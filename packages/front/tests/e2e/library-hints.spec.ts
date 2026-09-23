import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
	authorized,
	type FakeCatalogue,
	type FakeItem,
	journeyTag,
	startFakeJellyfin,
	until,
} from './fake-jellyfin';
import { API_URL, signIn, test0 } from './helpers';

/**
 * The two lines that exist only to be seen.
 *
 * Neither is a bug in the gateway, and that is exactly why both need a journey. A
 * media server that reads a folder of shows as one show has been mirrored faithfully,
 * and a row nothing here can reach really is missing — so nothing else in the product
 * says a word about either, and a hint that silently stopped rendering would take the
 * whole feature with it and break no test anywhere else.
 *
 * The owner spent an evening finding out why two of his series were invisible, and his
 * development gateway reads thirty-one thousand rows of "missing" with nothing
 * explaining why.
 */

/** A folder of shows, as a media server reports it once the library root is too high. */
function misreadFolder (tag: string): FakeCatalogue {
	const shelf = `hints-${tag}`;
	const folder = `Marvel Comics ${tag}`;
	/*
	 * Two numbered seasons and four named ones, which is the shape of the owner's own
	 * library: Jellyfin numbered what it could and used the folder names for the rest.
	 *
	 * The numbers are load-bearing and the first version of this got them wrong, giving
	 * every season an index including the four named ones. A season the server numbered
	 * is a season whatever it is called — that is what stops a suspicion landing on a
	 * show whose specials are correctly filed — so a decor that numbers a folder the
	 * server plainly could not name was describing a server that does not exist.
	 */
	const seasons: { name: string; index: number | null }[] = [
		{ name: 'Season 1', index: 1 },
		{ name: 'Season 2', index: 2 },
		{ name: 'Agatha All Along', index: null },
		{ name: 'Agent Carter', index: null },
		{ name: 'Agents of SHIELD', index: null },
		{ name: 'Cloak and Dagger', index: null },
	];

	const items: FakeItem[] = [
		{
			Id: `${tag}-folder`,
			Type: 'Series',
			Name: folder,
			library: shelf,
			ProductionYear: 2015,
			IsFolder: true,
			Path: `/data/hints/${folder}`,
			DateCreated: '2024-01-01T09:00:00.0000000Z',
		},
	];

	for (const [index, season] of seasons.entries()) {
		items.push(
			{
				Id: `${tag}-season-${index}`,
				Type: 'Season',
				Name: season.name,
				library: shelf,
				ParentId: `${tag}-folder`,
				SeriesId: `${tag}-folder`,
				SeriesName: folder,
				...(season.index === null ? {} : { IndexNumber: season.index }),
				IsFolder: true,
				Path: `/data/hints/${folder}/${season.name}`,
				DateCreated: '2024-01-01T09:00:00.0000000Z',
			},
			{
				Id: `${tag}-episode-${index}`,
				Type: 'Episode',
				Name: `Episode ${index + 1}`,
				library: shelf,
				ParentId: `${tag}-season-${index}`,
				SeasonId: `${tag}-season-${index}`,
				SeriesId: `${tag}-folder`,
				SeriesName: folder,
				IndexNumber: 1,
				/*
				 * Numbered for the real seasons and left off the named ones, because the
				 * episode's own number is what files it. An episode inside `Agent Carter`
				 * stamped with season three would be moved into season three by the scan,
				 * emptying the folder — and an emptied folder is not drawn, so the very
				 * shape this journey is about would disappear before it could be seen.
				 */
				...(season.index === null ? {} : { ParentIndexNumber: season.index }),
				Path: `/data/hints/${folder}/${season.name}/E01.mkv`,
				DateCreated: '2024-01-01T09:00:00.0000000Z',
			},
		);
	}

	return {
		serverName: `Journey hints ${tag}`,
		libraries: [{
			externalId: shelf,
			name: `Journey Hints ${tag}`,
			collectionType: 'tvshows',
			locations: ['/data/hints'],
		}],
		items,
	};
}

interface Service {
	id: string;
	name: string;
	rootMappings: { remoteRoot: string; localRoot: string }[];
}

async function services (request: APIRequestContext): Promise<Service[]> {
	const response = await request.get(`${API_URL}/services`, { headers: await authorized(request) });
	expect(response.ok(), `services failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Service[];
}

async function hintKeys (request: APIRequestContext): Promise<string[]> {
	const response = await request.get(`${API_URL}/libraries/hints`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `hints failed: ${response.status()}`).toBeTruthy();
	return (await response.json() as { key: string }[]).map(one => one.key);
}

/** Put the dismissals back where the run found them, whatever the journey did. */
async function setDismissed (request: APIRequestContext, keys: string[]): Promise<void> {
	const response = await request.patch(`${API_URL}/settings`, {
		headers: await authorized(request),
		data: { dismissedLibraryHints: keys },
	});
	expect(response.ok(), `settings failed: ${response.status()}`).toBeTruthy();
}

test.describe('the library says when it is organised in a way the server misreads', () => {
	test('names the series, says what to check, and stays dismissed once dismissed', async ({ page, request }) => {
		const tag = journeyTag();
		const server = await startFakeJellyfin(misreadFolder(tag));
		const headers = await authorized(request);
		const created = await request.post(`${API_URL}/services`, {
			headers,
			data: {
				name: `Journey hints ${tag}`,
				type: 'jellyfin',
				shared: false,
				baseUrl: server.baseUrl,
			},
		});
		expect(created.ok(), `service failed: ${created.status()} ${await created.text()}`).toBeTruthy();
		const service = await created.json() as { id: string };
		const before = await request.get(`${API_URL}/settings`, { headers });
		const dismissedBefore = ((await before.json()) as { dismissedLibraryHints?: string[] })
			.dismissedLibraryHints ?? [];

		try {
			const scanned = await request.post(`${API_URL}/services/${service.id}/scan`, { headers });
			expect(scanned.ok(), `scan failed: ${scanned.status()}`).toBeTruthy();

			// The rows are what proves a scan finished; a delay is the same wait spelled
			// as a flake.
			const keys = await until(
				() => hintKeys(request),
				listed => listed.some(one => one.startsWith('misread-folder:')),
				'the scan produced no suspicion about the folder of shows',
			);
			const key = keys.find(one => one.startsWith('misread-folder:')) as string;

			await signIn(page);
			await page.goto('/library');

			// Filtered on this run's own folder, not merely on the kind: a gateway that
			// already suspects one of its own shelves would otherwise satisfy every
			// assertion here without the journey's own folder ever being reported.
			const hint = page
				.locator(`${test0('library-hint')}[data-kind="misread_folder"]`)
				.filter({ hasText: `Marvel Comics ${tag}` });

			await expect(hint).toBeVisible({ timeout: 15_000 });
			// Named, so somebody knows which shelf to go and look at, and quoted, so they
			// recognise the folder without opening the server.
			await expect(hint.locator(test0('library-hint-text'))).toContainText(`Marvel Comics ${tag}`);
			await expect(hint.locator(test0('library-hint-examples'))).toContainText('Agent Carter');
			// A suspicion, never a verdict: real shows do name their seasons.
			await expect(hint).toContainText('worth checking');
			await expect(hint).toContainText('Add the deeper folder as a library root');

			await hint.locator(test0('library-hint-dismiss')).click();
			await expect(hint).toHaveCount(0);

			// Stored on the gateway and not in this browser: dismissed on the laptop and
			// back on the phone is a notice nobody can be rid of.
			await page.reload();
			// The page has to be drawn before an absence means anything: `toHaveCount(0)`
			// on a screen that has not rendered yet passes without proving a thing.
			await expect(page.locator(test0('library-everything'))).toBeVisible({ timeout: 15_000 });
			await expect(hint).toHaveCount(0);
			expect(await hintKeys(request)).not.toContain(key);
		} finally {
			await setDismissed(request, dismissedBefore);
			await request.delete(`${API_URL}/services/${service.id}`, {
				headers: await authorized(request),
			});
			await server.close();
		}
	});
});

test.describe('the dashboard says when nothing is mounted', () => {
	test('says it in one line, and stops the moment one server has its folders', async ({ page, request }) => {
		const mounted = (await services(request)).filter(one => one.rootMappings.length > 0);

		expect(
			mounted.length,
			'no server on this gateway declares a folder, so nothing can be taken away to prove the line',
		).toBeGreaterThan(0);

		await signIn(page);
		await page.goto('/');

		const hint = page.locator(`${test0('library-hint')}[data-kind="nothing_mounted"]`);

		// Nothing to say while a server is mounted, which is the half that matters most:
		// a line that never goes away is a line everybody stops reading.
		await expect(hint).toHaveCount(0);

		try {
			for (const service of mounted) {
				const cleared = await request.patch(`${API_URL}/services/${service.id}`, {
					headers: await authorized(request),
					data: { rootMappings: [] },
				});
				expect(cleared.ok(), `clearing ${service.name} failed: ${cleared.status()}`).toBeTruthy();
			}

			await page.reload();
			await expect(hint).toBeVisible({ timeout: 15_000 });
			await expect(hint).toContainText('nothing counts as held here');
			// The line explains every row underneath it, so it is never dismissable: a
			// gateway where the one sentence explaining thirty thousand rows can be
			// silenced is a gateway back where it started.
			await expect(hint.locator(test0('library-hint-dismiss'))).toHaveCount(0);
			await expect(hint.locator(test0('library-hint-fix'))).toBeVisible();
		} finally {
			for (const service of mounted) {
				await request.patch(`${API_URL}/services/${service.id}`, {
					headers: await authorized(request),
					data: { rootMappings: service.rootMappings },
				});
			}
		}

		// Restored, and gone again on its own: the line has no dismissal because it does
		// not need one.
		await page.reload();
		await expect(hint).toHaveCount(0);
		expect((await services(request)).some(one => one.rootMappings.length > 0)).toBe(true);
	});
});
