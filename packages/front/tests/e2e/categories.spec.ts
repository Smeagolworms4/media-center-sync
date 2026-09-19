import { type APIRequestContext, expect, test } from '@playwright/test';
import { API_URL, apiToken, signIn, test0, watchApi } from './helpers';

/**
 * Libraries of the same name are one thing to whoever is looking at them.
 *
 * A household with two media servers has two libraries called `Movies`, and a friend
 * makes a third. Three bands under the same word shows somebody the plumbing rather
 * than their media, so the screens are built on categories — the merge — and not on
 * the rows the API keeps per service.
 *
 * That merge is invisible in a screenshot: a band called `Movies` looks the same
 * whether it stands for one library or for four. So every journey here checks the
 * screen against what the gateway itself holds — how many libraries merged, and how
 * many media the merged category has — rather than against what a heading says.
 *
 * And a category that can be opened has to be one somebody can get back out of,
 * which is what the trail is for: an episode reached from a search looks exactly
 * like an episode reached from the wall, and the browser's own button walks the
 * history rather than the tree.
 */
interface Category {
	key: string;
	name: string;
	libraryIds: string[];
	serviceIds: string[];
}

async function categoriesOf (request: APIRequestContext): Promise<Category[]> {
	const token = await apiToken(request);
	const response = await request.get(`${API_URL}/libraries/categories`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(response.ok(), `categories failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Category[];
}

/** How many media the gateway answers for one merged category, posters not rows. */
async function groupedTotal (request: APIRequestContext, categoryKey: string): Promise<number> {
	const token = await apiToken(request);
	const response = await request.get(
		`${API_URL}/media/groups?rootsOnly=true&limit=1&categoryKey=${encodeURIComponent(categoryKey)}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	expect(response.ok(), `groups failed: ${response.status()}`).toBeTruthy();
	const body = await response.json() as { pagination: { total: number } };
	return body.pagination.total;
}

async function libraryCount (request: APIRequestContext): Promise<number> {
	const token = await apiToken(request);
	const response = await request.get(`${API_URL}/libraries`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(response.ok(), `libraries failed: ${response.status()}`).toBeTruthy();
	return (await response.json() as unknown[]).length;
}

/** The merged category the fixture can actually prove a merge with. */
function merged (categories: Category[]): Category {
	const found = categories.find(one => one.libraryIds.length > 1);
	expect(
		found,
		'no two libraries of this gateway share a name, so nothing here can prove a merge',
	).toBeDefined();
	return found!;
}

test.describe('categories', () => {
	test('the wall draws one band per merged category, carrying the category\'s own total', async ({ page, request }) => {
		const categories = await categoriesOf(request);
		const libraries = await libraryCount(request);
		// Asserted before anything is opened: without two libraries of one name there
		// is no merge on this gateway, and every check below would pass on nothing.
		merged(categories);

		const failures = watchApi(page);
		await signIn(page);
		await page.locator(test0('nav-library')).click();

		const sections = page.locator(test0('library-section'));
		await expect(sections).toHaveCount(categories.length);
		// The point of the merge, said as a number: fewer bands than libraries.
		expect(categories.length).toBeLessThan(libraries);

		for (const category of categories) {
			const section = page.locator(`${test0('library-section')}[data-category="${category.key}"]`);
			await expect(section).toHaveCount(1);
			/*
			 * The total is the category's, not the row's.
			 *
			 * A band of the home screen is capped to the newest of its category, so a
			 * count of what fits on the row would read the same for a category of
			 * twenty-four and one of four hundred. It is asked of the gateway for the
			 * whole merged category, which is what the heading claims to be counting.
			 */
			await expect(section)
				.toHaveAttribute('data-total', String(await groupedTotal(request, category.key)));
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('the screen that edits the merge says what merged with what', async ({ page, request }) => {
		const categories = await categoriesOf(request);
		const target = merged(categories);

		const failures = watchApi(page);
		await signIn(page);
		await page.locator(test0('nav-settings')).click();

		const rows = page.locator(test0('category-row'));
		await expect(rows).toHaveCount(categories.length);

		// The count of libraries behind the name is the whole information here:
		// somebody who has just set an alias comes to this list to find out what it
		// did, and a row that only repeats the name answers nothing.
		const row = page.locator(`${test0('category-row')}[data-category="${target.key}"]`);
		await expect(row).toHaveAttribute('data-libraries', String(target.libraryIds.length));
		await expect(row).toHaveAttribute('data-services', String(target.serviceIds.length));

		// And the way from here to the screen where an alias is actually typed.
		await page.locator(test0('settings-categories-services')).click();
		await expect(page).toHaveURL(/\/services/);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a category opens on its own from the home page, and the trail leads back out', async ({ page, request }) => {
		const categories = await categoriesOf(request);
		const target = merged(categories);

		const failures = watchApi(page);
		await signIn(page);

		// The dashboard's chips are the first click from the home page, and they are
		// the same merged categories in the same order.
		const chips = page.locator(test0('dashboard-category'));
		await expect(chips).toHaveCount(categories.length);
		await chips.filter({ hasText: target.name }).first().click();

		await expect(page).toHaveURL(new RegExp(`category=${target.key}`));
		const sections = page.locator(test0('library-section'));
		await expect(sections).toHaveCount(1);
		await expect(sections.first()).toHaveAttribute('data-category', target.key);

		// Where you are, in the name the category carries rather than in our own
		// vocabulary of kinds.
		const trail = page.locator(test0('media-breadcrumb'));
		await expect(trail.locator(test0('media-breadcrumb-current'))).toHaveText(target.name);

		await trail.locator(test0('media-breadcrumb-step')).first().click();
		await expect(page).not.toHaveURL(/category=/);
		await expect(page.locator(test0('library-section'))).toHaveCount(categories.length);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a media opened from a category knows which category it came from', async ({ page, request }) => {
		const categories = await categoriesOf(request);
		const target = merged(categories);

		const failures = watchApi(page);
		await signIn(page);
		await page.goto(`/library?category=${target.key}`);

		const card = page.locator(test0('media-card')).first();
		await expect(card).toBeVisible();
		await card.locator(test0('media-open')).click();
		await expect(page).toHaveURL(/\/library\/[\da-f-]{36}/);

		/*
		 * The category is a step of the trail, and it is the one that matters.
		 *
		 * It is not in the address the item page was reached by and not in the media
		 * itself: it is derived from the library the media sits in, merged with every
		 * library of that name. Without it the way back from an episode is the
		 * browser's own button, and nothing on the screen ever says which category
		 * that episode belongs to.
		 */
		const step = page.locator(test0('media-breadcrumb-step')).filter({ hasText: target.name });
		await expect(step).toHaveCount(1);
		await step.click();

		await expect(page).toHaveURL(new RegExp(`category=${target.key}`));
		await expect(page.locator(test0('library-section'))).toHaveCount(1);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
