import { chmod, mkdir, rm } from 'node:fs/promises';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { authorized, journeyTag, landingPaths, startFakeJellyfin } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';
import { librariesOfService, removeServices } from './lab';

/**
 * A server whose films and shows are on two disks, mapped through the service form.
 *
 * The case a single root pair could not describe: `/data/…/movies` is reached here
 * under one directory and `/srv/…/shows` under another, and the two share nothing but
 * `/`. What has to hold is what somebody configuring it would check by looking — two
 * rows offered from what the server reported, each library on the service's page
 * carrying the path of *its* disk, a row that repeats a server folder refused on the
 * row itself, and a removed row taking its library's path with it rather than leaving
 * it pointed at a disk nobody declared any more.
 *
 * The server is `./fake-jellyfin.ts`, which answers the calls a real Jellyfin does and
 * needs nothing running. The two gateway directories are made under the ignored
 * `var/e2e-landing/`, where the gateway and the journeys see the same disk, so each
 * library is really writable rather than merely derived.
 */
const NAME = 'Journey mappings, two disks';

/** What a library shows on the service's page as its path, read from the field. */
async function pathShown (page: Page, libraryId: string): Promise<string> {
	return page
		.locator(`${test0('service-library')}[data-library="${libraryId}"]`)
		.locator(field0('library-path'))
		.inputValue();
}

/**
 * What a field says under itself — its hint, or the refusal that replaced it — read
 * through `aria-describedby` as `share-policy.spec.ts` does, rather than a class.
 */
async function describedBy (page: Page, field: Locator): Promise<string> {
	const ids = (await field.locator('[aria-describedby]').first().getAttribute('aria-describedby')) ?? '';
	const texts = await Promise.all(ids.split(/\s+/).filter(Boolean)
		.map(async one => (await page.locator(`[id="${one}"]`).textContent()) ?? ''));
	return texts.join(' ').trim();
}

async function openEdit (page: Page): Promise<void> {
	await page.goto('/services');
	const row = page.locator(test0('service-row')).filter({ hasText: NAME });
	await expect(row).toHaveCount(1);
	await row.locator(test0('service-edit')).click();
	await expect(page.locator(test0('service-mappings'))).toBeVisible();
}

async function serviceId (request: APIRequestContext): Promise<string> {
	const response = await request.get(`${API_URL}/services`, { headers: await authorized(request) });
	const found = (await response.json() as { id: string; name: string }[]).find(one => one.name === NAME);
	expect(found, 'the service was not registered').toBeDefined();
	return found!.id;
}

test.describe('where a service\'s files are, for us', () => {
	test('two disks, two mappings: each library gets the path of its own, and a removed one takes its path away', async ({ page, request }) => {
		test.setTimeout(120_000);
		const failures = watchApi(page);
		const tag = journeyTag();
		const films = `/data/journey-${tag}/movies`;
		const shows = `/srv/journey-${tag}/shows`;
		const paths = landingPaths(`mappings-${tag}`);
		const nas1 = { ours: `${paths.ours}/nas1/movies`, gateway: `${paths.gateway}/nas1/movies` };
		const nas2 = { ours: `${paths.ours}/nas2/shows`, gateway: `${paths.gateway}/nas2/shows` };

		// Open to everybody for the reason `useOwnDestination` gives: the gateway may
		// not run as this process's user, and a directory it cannot write into would
		// make the libraries unwritable for a reason this journey is not about.
		for (const directory of [paths.ours, `${paths.ours}/nas1`, nas1.ours, `${paths.ours}/nas2`, nas2.ours]) {
			await mkdir(directory, { recursive: true });
			await chmod(directory, 0o777);
		}

		const server = await startFakeJellyfin({
			serverName: NAME,
			libraries: [
				{ externalId: `films-${tag}`, name: `Journey Films ${tag}`, collectionType: 'movies', locations: [films] },
				{ externalId: `shows-${tag}`, name: `Journey Shows ${tag}`, collectionType: 'tvshows', locations: [shows] },
			],
			items: [],
		});

		try {
			await removeServices(request, NAME);
			await signIn(page);
			await page.goto('/services');
			await page.locator(test0('service-add')).click();
			await page.locator(field0('service-name')).fill(NAME);
			await page.locator(field0('service-url')).fill(server.baseUrl);

			// Nothing mapped yet, and the form says what that means rather than
			// showing an empty space.
			await expect(page.locator(test0('service-mappings-empty'))).toBeVisible();

			/*
			 * One suggestion per disk, from what the server reported.
			 *
			 * The old single suggestion was the prefix common to every library, which
			 * for these two is `/` — nothing to offer. Taking both is two clicks instead
			 * of two paths to remember.
			 */
			await page.locator(test0('service-probe')).click();
			const suggestions = page.locator(test0('service-mapping-suggestion'));
			await expect(suggestions).toHaveCount(2);
			await suggestions.filter({ hasText: films }).click();
			await suggestions.filter({ hasText: shows }).click();
			await expect(suggestions).toHaveCount(0);

			const rows = page.locator(test0('service-mapping'));
			await expect(rows).toHaveCount(2);
			await expect(rows.nth(0).locator(field0('service-mapping-remote'))).toHaveValue(films);
			await expect(rows.nth(1).locator(field0('service-mapping-remote'))).toHaveValue(shows);
			await rows.nth(0).locator(field0('service-mapping-local')).fill(nas1.gateway);
			await rows.nth(1).locator(field0('service-mapping-local')).fill(nas2.gateway);

			/*
			 * A third row repeating a server folder is refused on that row, visibly.
			 *
			 * Two rows claiming one prefix would derive from whichever came first, so
			 * reordering them would move where transfers land. A refusal that marked
			 * nothing — or only the top of the form — is the defect this product has
			 * shipped before.
			 */
			await page.locator(test0('service-mapping-add')).click();
			await expect(rows).toHaveCount(3);
			await rows.nth(2).locator(field0('service-mapping-remote')).fill(`${films}/`);
			await rows.nth(2).locator(field0('service-mapping-local')).fill(nas2.gateway);
			const repeated = rows.nth(2).locator(test0('service-mapping-remote'));
			const original = rows.nth(0).locator(test0('service-mapping-remote'));
			// What a server side says when nothing is wrong with it, read off the first
			// row: the repeated row may already be refused by the time it is read, since
			// the form checks as somebody types.
			const hint = await describedBy(page, original);
			expect(hint, 'the server side explains nothing under itself').not.toBe('');
			await page.locator(test0('service-save')).click();
			await expect
				.poll(() => describedBy(page, repeated), { message: 'the repeated folder was not refused on its row' })
				.not
				.toBe(hint);
			// Blamed on the row that repeats, not on the one it repeats: nested and
			// earlier rows are not at fault.
			expect(await describedBy(page, original)).toBe(hint);
			// The dialog stays open on the refusal: nothing was registered.
			await expect(page.locator(test0('service-mappings'))).toBeVisible();
			await rows.nth(2).locator(test0('service-mapping-remove')).click();
			await expect(rows).toHaveCount(2);

			await page.locator(test0('service-save')).click();
			await expect(page.locator(test0('service-mappings'))).toHaveCount(0);

			// Each library, on the service's own page, with the path of its own disk.
			const id = await serviceId(request);
			const libraries = await librariesOfService(request, id);
			const filmsLibrary = libraries.find(one => one.paths.includes(films));
			const showsLibrary = libraries.find(one => one.paths.includes(shows));
			expect(filmsLibrary && showsLibrary, 'the gateway did not adopt both libraries').toBeTruthy();

			await page.goto(`/services/${id}`);
			await expect.poll(() => pathShown(page, filmsLibrary!.id)).toBe(nas1.gateway);
			await expect.poll(() => pathShown(page, showsLibrary!.id)).toBe(nas2.gateway);

			// Removing the shows' row, and only that one.
			await openEdit(page);
			await expect(rows).toHaveCount(2);
			const remotes = await rows.locator(field0('service-mapping-remote')).evaluateAll(
				inputs => inputs.map(input => (input as HTMLInputElement).value),
			);
			expect(remotes.toSorted()).toEqual([films, shows].toSorted());
			await rows.nth(remotes.indexOf(shows)).locator(test0('service-mapping-remove')).click();
			await expect(rows).toHaveCount(1);
			await expect(rows.nth(0).locator(field0('service-mapping-remote'))).toHaveValue(films);
			await page.locator(test0('service-save')).click();
			await expect(page.locator(test0('service-mappings'))).toHaveCount(0);

			/*
			 * The shows lose their path; the films keep theirs.
			 *
			 * A library left pointing at a disk nobody declares any more would go on
			 * accepting transfers into a directory whose mapping was withdrawn on
			 * purpose.
			 */
			await page.goto(`/services/${id}`);
			await expect.poll(() => pathShown(page, showsLibrary!.id)).toBe('');
			await expect.poll(() => pathShown(page, filmsLibrary!.id)).toBe(nas1.gateway);

			const stored = await (await request.get(`${API_URL}/services/${id}`, { headers: await authorized(request) }))
				.json() as { rootMappings: { remoteRoot: string; localRoot: string }[]; mode: string };
			expect(stored.rootMappings).toEqual([{ remoteRoot: films, localRoot: nas1.gateway }]);
			// Still ours: one disk is mapped.
			expect(stored.mode).toBe('local');
		} finally {
			await removeServices(request, NAME);
			await server.close();
			// Tolerant, as `useOwnDestination` is: what the gateway wrote under these
			// belongs to its user, and a leftover under the ignored `var/` is not worth a
			// thrown teardown.
			await rm(paths.ours, { recursive: true, force: true }).catch((error: unknown) => {
				console.warn(`could not remove ${paths.ours}: ${String(error)}`);
			});
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
