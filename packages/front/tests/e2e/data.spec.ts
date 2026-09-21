import { expect, test } from '@playwright/test';
import { authorized, until, useOwnDestination } from './fake-jellyfin';
import { ADMIN, API_URL, apiToken, COMPLETE, signIn, test0, watchApi } from './helpers';
import { LAB_JELLYFIN, LAB_JELLYFIN_ACCOUNT, LAB_PLEX } from './lab';

/**
 * The `data` project: what every journey starts from, loaded and checked once before
 * any of them.
 *
 * Most journeys build the fixtures they need and remove them — a fake media server, a
 * library of their own, a landing directory. About twenty do not, and could not: the
 * wall, the category bands, the merge of two libraries of one name, the correction of
 * a media's year and synopsis, the settings' row per category. Those browse a
 * catalogue, and a catalogue only exists because a real server was scanned. So this
 * phase registers the dataset `E2E_DATASET` names — two Jellyfin servers holding the
 * same two library names, which is the smallest thing that produces a merge — and
 * waits until the gateway holds what those journeys look for. It is left in place:
 * the journeys read it, and the run's stack is thrown away afterwards.
 *
 * Nothing else is loaded, on purpose. A baseline nothing reads is a second source of
 * truth for the journeys to drift away from.
 *
 * Under `E2E_COMPLETE` it also proves the environment several journeys would otherwise
 * skip without, because on the run meant to prove everything a skip is a hole that
 * reads as green: the landing directory the pulling journeys write into, the lab the
 * three real-server journeys need, the short landing grace one journey waits out, and
 * the placement hold another catches a transfer in.
 */

/**
 * `url|token[|serverRoot=gatewayRoot[;serverRoot=gatewayRoot…]]` entries, comma-separated.
 *
 * Addresses as the gateway reaches them. Registered under names that are not a
 * journey's (`Journey …`), so no journey's clean-up ever mistakes them for a leftover.
 *
 * The optional mappings are what make a server *ours*: the gateway reaches the files
 * the server reports under each `serverRoot` at the matching `gatewayRoot`, as many
 * pairs as the server has disks. At least one server needs one — the placement screen
 * gives a row only to the categories of our own servers, and a dataset of nothing but
 * other people's shelves leaves that screen, and its journey, with nothing to show.
 */
const DATASET = (process.env.E2E_DATASET ?? '')
	.split(',')
	.map(entry => entry.trim())
	.filter(entry => entry !== '')
	.map(entry => {
		const [url, token = '', mappings = ''] = entry.split('|');
		const rootMappings = mappings
			.split(';')
			.filter(pair => pair !== '')
			.map(pair => {
				const [remoteRoot = '', localRoot = ''] = pair.split('=');
				return { remoteRoot, localRoot };
			});
		return { url: url.replace(/\/+$/, ''), token, rootMappings };
	});

interface Category {
	key: string;
	libraryIds: string[];
}

test.describe('the installed gateway', () => {
	test('signs its administrator in, through the interface', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);
		await expect(page.locator(test0('account-menu'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('answers its API, and its settings can be read', async ({ request }) => {
		const health = await request.get(`${API_URL}/health`);
		expect(health.ok(), `health failed: ${health.status()}`).toBeTruthy();

		const headers = { Authorization: `Bearer ${await apiToken(request, ADMIN)}` };
		const settings = await request.get(`${API_URL}/settings`, { headers });
		expect(settings.ok(), `settings failed: ${settings.status()}`).toBeTruthy();

		// The key the pulling journeys read and put back. A settings answer without it
		// is one they would restore as `undefined` — pointing the next pull nowhere.
		expect(await settings.json()).toHaveProperty('defaultTargetLibraryId');
	});
});

test.describe('the dataset', () => {
	test.skip(
		DATASET.length === 0 && !COMPLETE,
		'no dataset named (E2E_DATASET): the journeys browse whatever this gateway already holds',
	);

	test('is registered, scanned, and holds what the browsing journeys look for', async ({ request }) => {
		// Two real servers, each walked by the gateway after walking its own folders.
		test.setTimeout(240_000);
		expect(DATASET.length, 'E2E_DATASET must name two servers: a merge needs two libraries of one name')
			.toBeGreaterThanOrEqual(2);
		expect(
			DATASET.some(one => one.rootMappings.length > 0),
			'E2E_DATASET must map one server onto this gateway\'s disk: only our own categories can be placed',
		).toBe(true);

		const headers = await authorized(request);
		const services = await (await request.get(`${API_URL}/services`, { headers })).json() as
			{ id: string; baseUrl: string }[];
		const ids: string[] = [];

		for (const [index, server] of DATASET.entries()) {
			// Registered once: a second run against a gateway that kept its data finds
			// it there, and the gateway would refuse the same address twice.
			const held = services.find(one => one.baseUrl.replace(/\/+$/, '') === server.url);
			if (held) {
				ids.push(held.id);
				continue;
			}

			const created = await request.post(`${API_URL}/services`, {
				headers,
				data: {
					name: `Dataset Jellyfin ${String.fromCodePoint(65 + index)}`,
					type: 'jellyfin',
					shared: false,
					baseUrl: server.url,
					...(server.token ? { token: server.token } : {}),
					rootMappings: server.rootMappings,
				},
			});
			expect(created.ok(), `${server.url} was refused: ${created.status()} ${await created.text()}`).toBeTruthy();
			ids.push((await created.json() as { id: string }).id);
		}

		/*
		 * Scanned again until the catalogue is there, rather than once and waited on.
		 *
		 * A Jellyfin whose libraries were created a moment ago is still walking its own
		 * folders, and a gateway scan that lands before it has finished finds empty
		 * libraries and is done. Asking again is what a person would do.
		 */
		let lastScan = 0;
		const scan = async (): Promise<void> => {
			if (Date.now() - lastScan < 10_000) {
				return;
			}
			lastScan = Date.now();
			for (const id of ids) {
				await request.post(`${API_URL}/services/${id}/scan`, { headers });
			}
		};

		await until(
			async () => {
				await scan();
				const categories = await (await request.get(`${API_URL}/libraries/categories`, { headers }))
					.json() as Category[];
				const groups = await (await request.get(`${API_URL}/media/groups?rootsOnly=true&limit=50`, { headers }))
					.json() as { items: { id: string }[] };
				let described = false;
				for (const group of groups.items) {
					const media = await request.get(`${API_URL}/media/${group.id}`, { headers });
					const body = media.ok() ? await media.json() as { year: number | null; overview: string | null } : null;
					described ||= body !== null && body.year !== null && (body.overview ?? '') !== '';
				}
				return {
					merged: categories.filter(one => one.libraryIds.length > 1).length,
					categories: categories.length,
					described,
				};
			},
			state => state.merged >= 1 && state.categories >= 2 && state.described,
			'the dataset never produced two categories, a merge, and a media with a year and a synopsis',
			200_000,
		);
	});
});

test.describe('what the journeys need', () => {
	test.skip(!COMPLETE, 'only required of a complete run (E2E_COMPLETE=1, make e2e/ci); journeys skip on their own otherwise');

	test('the gateway can write where the pulling journeys land', async ({ request }) => {
		// Six journeys pull into a library of their own under `var/e2e-landing/`, and each
		// skips when the gateway cannot write there. Asked once here, with the helper they
		// all use, so a mount or a permission is reported as itself.
		const destination = await useOwnDestination(request, `data-${Date.now().toString(36)}`);
		expect(
			destination,
			'the gateway cannot write under var/e2e-landing/: set E2E_LANDING_PATH to that directory as the gateway sees it',
		).not.toBeNull();
		await destination!.release(request);
	});

	test('the lab is named, for the journeys that need a real media server', () => {
		expect(LAB_JELLYFIN.url, 'E2E_JELLYFIN_URL').not.toBe('');
		expect(LAB_JELLYFIN.token, 'E2E_JELLYFIN_TOKEN').not.toBe('');
		expect(LAB_JELLYFIN_ACCOUNT.username, 'E2E_JELLYFIN_USER').not.toBe('');
		expect(LAB_JELLYFIN_ACCOUNT.password, 'E2E_JELLYFIN_PASSWORD').not.toBe('');
		expect(LAB_PLEX.url, 'E2E_PLEX_URL').not.toBe('');
	});

	test('the landing grace is short enough to be waited out', () => {
		// The same bounds `media-states.spec.ts` skips outside of. The gateway must have
		// been started with the same value; only the journey itself can tell whether it was.
		const grace = Number(process.env.MCS_LANDING_GRACE_MS ?? 0);
		expect(grace, 'MCS_LANDING_GRACE_MS, on the journeys and on the API').toBeGreaterThan(0);
		expect(grace).toBeLessThanOrEqual(120_000);
	});

	test('placements are held long enough to be caught in the act', () => {
		// What `transfers.spec.ts` skips below. Same caveat as the grace: the gateway has
		// to have been started with it, which only that journey can find out.
		expect(Number(process.env.MCS_PLACING_HOLD_MS ?? 0), 'MCS_PLACING_HOLD_MS, on the journeys and on the API')
			.toBeGreaterThanOrEqual(1000);
	});
});
