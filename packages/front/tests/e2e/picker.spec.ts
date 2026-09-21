import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { authorized, type FakeJellyfin, journeyTag, startFakeJellyfin } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';
import {
	type FixtureService,
	LAB_JELLYFIN,
	LAB_PLEX,
	librariesOfService,
	NEEDS_JELLYFIN,
	NEEDS_PLEX,
	registerService,
	removeServices,
} from './lab';

/**
 * The directory picker's two halves: what the media server says its folders are, and
 * what this gateway sees on its own disk.
 *
 * That pair is the mapping being configured — the server says `/media/shows`, the
 * gateway sees `/mnt/nas/shows` — and getting it wrong is the failure this product
 * exists to prevent: a transfer that succeeds and lands somewhere the server never
 * scans. The server's half shipped with unit tests only, and the unit tests cannot say
 * the one thing worth knowing about it, which is what a real server does when asked.
 *
 * Four situations, and they are the four the picker has to get right:
 *
 *  - no server to ask (the fallback folder on the settings page): only the disk, and
 *    no heading pretending a server said anything;
 *  - a server that cannot be asked at all: its half disappears and the browse below
 *    still works — the browse is the fallback this assist has always had;
 *  - a Jellyfin, which reports its folders and walks into them;
 *  - a Plex, which reports its roots and answers every deeper request with the same
 *    roots — the case the picker must render as "these are the folders, there is no
 *    way deeper" and never as a failure that takes the roots away.
 *
 * Fixtures: the first two need nothing but the gateway. What a server reports about
 * its own folders is served by `./fake-jellyfin.ts`, which answers the same call a real
 * Jellyfin does and needs nothing running. Walking deeper, and Plex's refusal to, are
 * behaviours of the real servers and nothing else: those two register a lab server of
 * their own (`./lab.ts`) and skip, saying so, when none is named.
 */
interface ServerEntry {
	path: string;
	directory: boolean;
}

interface Structure {
	support: string;
	entries: ServerEntry[];
}

/** Named so a leftover is recognisable, and so the cleanup can find it by name. */
const NOWHERE_NAME = 'Journey picker, unreachable';
const FAKE_NAME = 'Journey picker, reported folders';
const JELLYFIN_NAME = 'Journey picker, Jellyfin';
const PLEX_NAME = 'Journey picker, Plex';

/**
 * A port nothing listens on. Not `:1`, which `services.spec.ts` registers: the gateway
 * refuses one address twice, and a leftover from that file would fail this one.
 */
const NOWHERE = 'http://127.0.0.1:2';

async function structureOf (
	request: APIRequestContext,
	serviceId: string,
	query: { path?: string; libraryExternalId?: string } = {},
): Promise<Structure> {
	const response = await request.get(`${API_URL}/services/${serviceId}/structure`, {
		headers: await authorized(request),
		params: query,
	});
	expect(response.ok(), `structure failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Structure;
}

/** The server's folders, as the picker is expected to list them. */
function directories (structure: Structure): string[] {
	return structure.entries.filter(one => one.directory).map(one => one.path);
}

/**
 * Opens the gateway-side picker of a new mapping row, from a registered service's
 * edit dialog.
 *
 * That dialog is where the server's half first appears for most people: the service
 * exists, so it can be asked where its folders are, and the gateway side of a mapping
 * is the field the answer is for. The services these journeys register carry no
 * mapping, so a row is added first — which is what somebody configuring one does.
 */
async function openServicePicker (page: Page, name: string): Promise<void> {
	await page.goto('/services');
	const row = page.locator(test0('service-row')).filter({ hasText: name });
	await expect(row).toHaveCount(1);
	await row.locator(test0('service-edit')).click();
	await page.locator(test0('service-mapping-add')).click();
	await page.locator(test0('service-mapping-local-browse')).click();
	await expect(page.locator(test0('browse-crumbs'))).toBeVisible();
}

/**
 * A server that reports two folders and nothing else, registered as ours for one test.
 *
 * Two libraries rather than one, so that a picker restricted to a single library has
 * something to leave out — with one, "restricted" and "unrestricted" look the same.
 */
async function registerFake (
	request: APIRequestContext,
): Promise<{ service: FixtureService; server: FakeJellyfin; shows: string; films: string }> {
	const tag = journeyTag();
	const shows = `/data/journey-${tag}/shows`;
	const films = `/data/journey-${tag}/films`;
	const server = await startFakeJellyfin({
		serverName: FAKE_NAME,
		libraries: [
			{ externalId: `shows-${tag}`, name: `Journey Shows ${tag}`, collectionType: 'tvshows', locations: [shows] },
			{ externalId: `films-${tag}`, name: `Journey Films ${tag}`, collectionType: 'movies', locations: [films] },
		],
		items: [],
	});

	try {
		const service = await registerService(request, {
			name: FAKE_NAME,
			type: 'jellyfin',
			server: { url: server.baseUrl, token: '' },
		});

		return { service, server, shows, films };
	} catch (error) {
		await server.close();
		throw error;
	}
}

test.describe('directory picker', () => {
	test('with no server to ask, it shows this gateway\'s disk and claims nothing about a server', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);
		await page.goto('/settings');
		await page.locator(test0('settings-default-target-browse')).click();

		await expect(page.locator(test0('browse-crumbs'))).toBeVisible();
		await expect(page.locator(test0('browse-list'))).toBeVisible();

		/*
		 * No server half, and no heading over the disk half either.
		 *
		 * The fallback folder has no media server behind it, so a section headed "what
		 * the server reports" would be a heading over nothing — or worse, over an empty
		 * list that reads as a server that has no folders.
		 */
		await expect(page.locator(test0('browse-server'))).toHaveCount(0);
		await expect(page.locator(test0('browse-gateway-title'))).toHaveCount(0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a server that cannot be asked takes its half away, and the picker still browses', async ({ page, request }) => {
		const failures = watchApi(page);

		try {
			const headers = await authorized(request);
			await removeServices(request, NOWHERE_NAME);
			const created = await request.post(`${API_URL}/services`, {
				headers,
				data: { name: NOWHERE_NAME, type: 'jellyfin', shared: false, baseUrl: NOWHERE },
			});
			expect(created.ok(), `create failed: ${created.status()} ${await created.text()}`).toBeTruthy();

			await signIn(page);

			// The server is asked as the dialog opens; its answer is waited for rather
			// than slept on, so the assertions below are about what happened after it.
			const asked = page.waitForResponse(one => one.url().includes('/structure'));
			await openServicePicker(page, NOWHERE_NAME);
			const answer = await asked;

			// Proof that this is the case being checked: the server really could not be
			// asked. Without it the journey would pass just as well against a server
			// that answered with nothing.
			expect(answer.ok(), 'the unreachable server answered after all').toBe(false);

			/*
			 * The section is gone rather than empty.
			 *
			 * "No folder in here" about a server that never answered is a lie in the
			 * place this dialog is meant to be the trustworthy half; and an alert about
			 * the server would suggest the dialog is broken when it is merely quieter
			 * than usual.
			 */
			await expect(page.locator(test0('browse-server'))).toHaveCount(0);
			await expect(page.locator(test0('browse-error'))).toHaveCount(0);

			// And the browse underneath works: stepping into a folder changes where the
			// picker is, which is the whole of what it has to keep doing.
			const crumbs = page.locator(test0('browse-crumbs'));
			const entries = page.locator(test0('browse-entry'));
			const before = (await crumbs.textContent() ?? '').trim();

			if (await entries.count() > 0) {
				await entries.first().click();
				await expect.poll(async () => (await crumbs.textContent() ?? '').trim()).not.toBe(before);
			} else {
				await expect(page.locator(test0('browse-empty'))).toBeVisible();
			}
		} finally {
			await removeServices(request, NOWHERE_NAME);
		}

		// The structure call is the one failure this journey provokes on purpose; every
		// other call the dialog made still has to have succeeded.
		const unexpected = failures.filter(one => !one.includes('/structure'));
		expect(unexpected, unexpected.join('\n')).toHaveLength(0);
	});

	test('the server\'s folders come first, and the dialog says how they relate to this disk', async ({ page, request }) => {
		const failures = watchApi(page);
		let fake: Awaited<ReturnType<typeof registerFake>> | null = null;

		try {
			fake = await registerFake(request);

			// What the server reports, asked of the gateway: the picker is checked
			// against the gateway's answer rather than against a list written here.
			const roots = directories(await structureOf(request, fake.service.id));
			expect(roots.toSorted()).toEqual([fake.films, fake.shows].toSorted());

			await signIn(page);
			await openServicePicker(page, FAKE_NAME);

			const server = page.locator(test0('browse-server'));
			await expect(server).toBeVisible();
			await expect(page.locator(test0('browse-server-entry'))).toHaveCount(roots.length);
			for (const path of roots) {
				await expect(page.locator(test0('browse-server-entry')).filter({ hasText: path }))
					.toHaveCount(1);
			}

			/*
			 * Above, and the relationship said in words.
			 *
			 * The server's paths come from the machine that reads the files, and the
			 * disk below is this gateway's view; shown in the other order, or as two
			 * lists with no sentence between them, the dialog shows the same thing
			 * twice and asks somebody to work out which is which.
			 */
			await expect(page.locator(test0('browse-server-hint'))).toBeVisible();
			await expect(page.locator(test0('browse-server-hint'))).not.toHaveText('');
			const gatewayTitle = page.locator(test0('browse-gateway-title'));
			await expect(gatewayTitle).toBeVisible();
			const serverBox = await server.boundingBox();
			const gatewayBox = await gatewayTitle.boundingBox();
			expect(serverBox && gatewayBox && serverBox.y < gatewayBox.y, 'the server\'s half is not above the disk')
				.toBe(true);

			// Both halves at once: the server's folders did not push the disk away.
			await expect(page.locator(test0('browse-crumbs'))).toBeVisible();
			await expect(page.locator(test0('browse-list'))).toBeVisible();

			// Choosing one of the server's own paths fills the row's gateway side — and
			// only the field: it is saved by the same button and the same probe as a
			// typed one, because the picker assists the input and never replaces it.
			await page.locator(test0('browse-server-entry')).filter({ hasText: fake.shows }).click();
			await expect(server).toHaveCount(0);
			await expect(page.locator(field0('service-mapping-local'))).toHaveValue(fake.shows);
		} finally {
			await removeServices(request, FAKE_NAME);
			await fake?.server.close();
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a library\'s own picker shows that library\'s folders and no other', async ({ page, request }) => {
		const failures = watchApi(page);
		let fake: Awaited<ReturnType<typeof registerFake>> | null = null;

		try {
			fake = await registerFake(request);
			const libraries = await librariesOfService(request, fake.service.id);
			const library = libraries.find(one => one.paths.includes(fake!.shows));
			expect(library, 'the gateway did not adopt the shows library').toBeDefined();

			await signIn(page);
			await page.goto(`/services/${fake.service.id}`);

			const block = page.locator(`${test0('service-library')}[data-library="${library!.id}"]`);
			await block.locator(test0('library-path-browse')).click();

			/*
			 * Restricted to that library's folders.
			 *
			 * The other library's path is the wrong answer for this field, and listing it
			 * beside the right one is an invitation to pick it — which would map this
			 * library onto a directory the server scans for something else.
			 */
			await expect(page.locator(test0('browse-server'))).toBeVisible();
			const entries = page.locator(test0('browse-server-entry'));
			await expect(entries).toHaveCount(1);
			await expect(entries.filter({ hasText: fake.shows })).toHaveCount(1);
			await expect(entries.filter({ hasText: fake.films })).toHaveCount(0);

			await entries.first().click();
			await expect(block.locator(field0('library-path'))).toHaveValue(fake.shows);
		} finally {
			await removeServices(request, FAKE_NAME);
			await fake?.server.close();
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a Jellyfin walks into a folder it reported', async ({ page, request }) => {
		test.skip(LAB_JELLYFIN.url === '' || LAB_JELLYFIN.token === '', NEEDS_JELLYFIN);

		const failures = watchApi(page);

		try {
			const service = await registerService(request, {
				name: JELLYFIN_NAME,
				type: 'jellyfin',
				server: LAB_JELLYFIN,
			});

			const roots = directories(await structureOf(request, service.id));
			expect(roots.length, 'the lab Jellyfin reported no folder at all').toBeGreaterThan(0);
			// What is below the first one, asked of the gateway rather than written here:
			// the lab's fixtures can be regenerated with other titles tomorrow.
			const deeper = directories(await structureOf(request, service.id, { path: roots[0] }));
			expect(deeper.length, 'the lab Jellyfin has nothing below its first folder').toBeGreaterThan(0);

			await signIn(page);
			await openServicePicker(page, JELLYFIN_NAME);
			// Presence of what the server named, never a count: the lab's folders are
			// somebody's test media, and a file dropped into one must not fail this.
			await expect(page.locator(test0('browse-server-entry')).filter({ hasText: roots[0] }).first())
				.toBeVisible();

			const walked = page.waitForResponse(one => one.url().includes('/structure') && one.url().includes('path='));
			await page.locator(test0('browse-server-entry')).filter({ hasText: roots[0] }).first().locator(test0('browse-server-enter')).click();
			await walked;

			// `first()` because a folder name can be a prefix of its neighbour's, and a
			// substring match is all a list of paths offers.
			for (const path of deeper) {
				await expect(page.locator(test0('browse-server-entry')).filter({ hasText: path }).first())
					.toBeVisible();
			}
			// A way back out, and no claim that the server could not go further — it
			// just did.
			await expect(page.locator(test0('browse-server-up'))).toBeVisible();
			await expect(page.locator(test0('browse-server-no-deeper'))).toHaveCount(0);
		} finally {
			await removeServices(request, JELLYFIN_NAME);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a Plex that cannot walk deeper keeps the folders it reported, and says so', async ({ page, request }) => {
		test.skip(LAB_PLEX.url === '', NEEDS_PLEX);

		const failures = watchApi(page);

		try {
			const service = await registerService(request, {
				name: PLEX_NAME,
				type: 'plex',
				server: LAB_PLEX,
			});

			const roots = directories(await structureOf(request, service.id));
			expect(roots.length, 'the lab Plex reported no folder at all').toBeGreaterThan(0);
			// The premise, asked of the gateway rather than assumed: this Plex does not
			// walk. If a newer build ever does, this journey is no longer about the case
			// it was written for and should say so rather than pass.
			const attempt = await structureOf(request, service.id, { path: roots[0] });
			expect(attempt.support, 'this Plex walks after all; the dead end is not being tested').toBe('unsupported');

			await signIn(page);
			await openServicePicker(page, PLEX_NAME);

			// `first()` because a root can be a prefix of another, and a substring match
			// is all a list of paths offers.
			const entries = page.locator(test0('browse-server-entry'));
			for (const path of roots) {
				await expect(entries.filter({ hasText: path }).first()).toBeVisible();
			}

			const walked = page.waitForResponse(one => one.url().includes('/structure') && one.url().includes('path='));
			await entries.filter({ hasText: roots[0] }).first().locator(test0('browse-server-enter')).click();
			await walked;

			/*
			 * The roots stay, and a sentence explains why the click changed nothing.
			 *
			 * Overwriting them with "cannot say" would take away the one thing the
			 * server answered correctly, at the moment somebody asked for more — a
			 * section that emptied itself on a chevron reads as a broken dialog rather
			 * than as a limited server.
			 */
			await expect(page.locator(test0('browse-server-no-deeper'))).toBeVisible();
			await expect(page.locator(test0('browse-server-no-deeper'))).not.toHaveText('');
			for (const path of roots) {
				await expect(entries.filter({ hasText: path }).first()).toBeVisible();
			}
			await expect(page.locator(test0('browse-server-unsupported'))).toHaveCount(0);
			await expect(page.locator(test0('browse-server-empty'))).toHaveCount(0);
		} finally {
			await removeServices(request, PLEX_NAME);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
