import { type APIRequestContext, expect, test } from '@playwright/test';
import { API_URL, apiToken, field0, signIn, test0, watchApi } from './helpers';

/**
 * What this gateway calls a library, and where that puts it.
 *
 * A friend's `Video2` is not a category anybody can navigate, and renaming it on
 * their server is not ours to do — so the name is local. It is not decoration
 * either: libraries merge on the name a person reads, so typing one is how two
 * shelves become one category, and typing the wrong one is how a library quietly
 * leaves the band it was in.
 *
 * That is why the screen has to say what the rename did. Setting an alias and then
 * hunting through the wall to find out where the library went is how a setting gets
 * changed twice and understood never — and it is the whole of what these journeys
 * check, against the merge the gateway itself computes.
 */
interface Category {
	key: string;
	name: string;
	libraryIds: string[];
}

interface Library {
	id: string;
	serviceId: string;
	name: string;
	alias: string | null;
	position: number;
}

async function authorized (request: APIRequestContext): Promise<{ Authorization: string }> {
	return { Authorization: `Bearer ${await apiToken(request)}` };
}

async function categoriesOf (request: APIRequestContext): Promise<Category[]> {
	const response = await request.get(`${API_URL}/libraries/categories`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `categories failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Category[];
}

/** How many media the gateway answers for one merged category, posters not rows. */
async function groupedTotal (request: APIRequestContext, categoryKey: string): Promise<number> {
	const response = await request.get(
		`${API_URL}/media/groups?rootsOnly=true&limit=1&categoryKey=${encodeURIComponent(categoryKey)}`,
		{ headers: await authorized(request) },
	);
	expect(response.ok(), `groups failed: ${response.status()}`).toBeTruthy();
	const body = await response.json() as { pagination: { total: number } };
	return body.pagination.total;
}

async function librariesOf (request: APIRequestContext): Promise<Library[]> {
	const response = await request.get(`${API_URL}/libraries`, { headers: await authorized(request) });
	expect(response.ok(), `libraries failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Library[];
}

/** Puts a library back the way the run found it, whatever the journey did to it. */
async function restore (request: APIRequestContext, library: Library): Promise<void> {
	await request.patch(`${API_URL}/libraries/${library.id}`, {
		headers: await authorized(request),
		data: { alias: library.alias, position: library.position },
	});
}

test.describe('library names', () => {
	test('an alias folds a library into another category, and the screen says so', async ({ page, request }) => {
		const categories = await categoriesOf(request);
		const libraries = await librariesOf(request);
		expect(
			categories.length,
			'this gateway has one category, so no rename can move a library between two',
		).toBeGreaterThan(1);

		// The library that is about to move, and the category it is about to join —
		// which has to be one it is not already in, or the journey proves nothing.
		const [from, into] = categories;
		const moving = libraries.find(one => from.libraryIds.includes(one.id))!;
		const joined = into.libraryIds.length + 1;

		const failures = watchApi(page);

		try {
			await signIn(page);
			await page.goto(`/services/${moving.serviceId}`);

			const block = page.locator(`${test0('service-library')}[data-library="${moving.id}"]`);
			await expect(block).toBeVisible();
			// Where it sits before anything is typed, so that what changes is the rename
			// and not the order two journeys happened to run in.
			await expect(block.locator(test0('library-category'))).toHaveAttribute('data-category', from.key);

			await block.locator(field0('library-alias')).fill(into.name);
			await block.locator(test0('library-name-save')).click();

			/*
			 * The merge is the gateway's answer, and this is where it is read back.
			 *
			 * The alias changes which libraries merge, so the categories the screen was
			 * built from are stale the moment it is saved. A screen that kept showing
			 * the old category would be telling somebody their rename did nothing, at
			 * the exact moment it did the most.
			 */
			const note = block.locator(test0('library-category'));
			await expect(note).toHaveAttribute('data-category', into.key);
			await expect(note).toHaveAttribute('data-merged', String(joined));

			// And the name the service itself reports is still on screen: an alias hides
			// nothing, or the next person to read this screen cannot match it to the
			// library their media server shows them.
			await expect(block.locator(test0('library-reported-name'))).toContainText(moving.name);

			/*
			 * And the wall is built on that same merge, so it is where the rename is
			 * felt: the band now counts the media of the library that joined it.
			 * Compared against the categories the gateway recomputed rather than
			 * against arithmetic done here — the merge is its answer, not ours.
			 */
			const after = await categoriesOf(request);
			const grown = after.find(one => one.key === into.key)!;
			expect(grown.libraryIds).toContain(moving.id);

			await page.locator(test0('nav-library')).click();
			await expect(page.locator(test0('library-section'))).toHaveCount(after.length);
			await expect(page.locator(`${test0('library-section')}[data-category="${into.key}"]`))
				.toHaveAttribute('data-total', String(await groupedTotal(request, into.key)));
		} finally {
			await restore(request, moving);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('an emptied alias gives the library back the name its service reports', async ({ page, request }) => {
		const libraries = await librariesOf(request);
		const moving = libraries[0];

		const failures = watchApi(page);

		try {
			await signIn(page);
			await page.goto(`/services/${moving.serviceId}`);

			const block = page.locator(`${test0('service-library')}[data-library="${moving.id}"]`);
			await block.locator(field0('library-alias')).fill('Journey alias');
			await block.locator(test0('library-name-save')).click();
			await expect(block.locator(test0('library-reported-name'))).toBeVisible();

			// An empty box is the one case where empty really does mean cleared, and it
			// has to be reachable: it is the only way back from a name somebody mistyped.
			await block.locator(field0('library-alias')).fill('');
			await block.locator(test0('library-name-save')).click();
			await expect(block.locator(test0('library-reported-name'))).toHaveCount(0);

			const after = await librariesOf(request);
			expect(after.find(one => one.id === moving.id)?.alias).toBeNull();
		} finally {
			await restore(request, moving);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('the position a library is given is the order its category appears in', async ({ page, request }) => {
		const categories = await categoriesOf(request);
		const libraries = await librariesOf(request);
		expect(categories.length, 'one category cannot be reordered against another').toBeGreaterThan(1);

		const failures = watchApi(page);

		await signIn(page);
		await page.locator(test0('nav-library')).click();
		const opened = await page.locator(test0('library-section')).first().getAttribute('data-category');

		// A category that is not already first, so that the position is what puts it
		// there rather than the order it happened to be in.
		const promoted = categories.find(one => one.key !== opened)!;
		const moving = libraries.find(one => promoted.libraryIds.includes(one.id))!;

		try {
			await page.goto(`/services/${moving.serviceId}`);

			const block = page.locator(`${test0('service-library')}[data-library="${moving.id}"]`);
			// Lowest first, and the lowest among the merged libraries decides the whole
			// category — so one library moved to the front moves its band with it.
			await block.locator(field0('library-position')).fill('0');
			await block.locator(test0('library-name-save')).click();
			await expect(block.locator(test0('library-category')))
				.toHaveAttribute('data-category', promoted.key);

			await page.locator(test0('nav-library')).click();
			await expect(page.locator(test0('library-section')).first())
				.toHaveAttribute('data-category', promoted.key);
		} finally {
			await restore(request, moving);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
