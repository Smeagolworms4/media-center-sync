import { expect, type Page, test } from '@playwright/test';
import { authorized, createMediaFixture, type MediaFixture, until } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';

/**
 * What the series has to look like once a rescan has settled: two seasons, exactly one
 * of them the second — never none, which would mean the stale pass took the row the
 * gateway created, and never three, which would mean a scan built a new one beside it.
 */
function settled (children: { seasonNumber: number | null }[]): boolean {
	const seasonTwo = children.filter(one => one.seasonNumber === 2);

	return children.length === 2 && seasonTwo.length === 1;
}

/**
 * Correcting an episode into a season that does not exist, in a browser.
 *
 * The owner found this by using the product, which is why it belongs here and not only
 * in a unit test. He corrected an episode of a show from `S1E14` to `S2E1`, and from
 * the outside two things happened at once: *"it doesn't show up under season 2"* and
 * *"it disappeared"*. Both are the same missing write. The number changed and the place
 * did not, so the episode stayed among season one's hundred and fifty-three children —
 * and because children are ordered by season and then episode, an item claiming season
 * two sorts after every one of them, at the bottom of a list nobody scrolls.
 *
 * So this journey is about *places*, not values: which node the episode is under
 * before, after, and after the correction is withdrawn. Asserting on the number on
 * screen would have passed against the defect.
 *
 * Serial, because the three steps are one story told in order, and each needs what the
 * one before it left behind.
 */
test.describe.serial('correcting the season an episode belongs to', () => {
	let fixture: MediaFixture;

	test.beforeAll(async ({ request }) => {
		fixture = await createMediaFixture(request);
	});

	test.afterAll(async ({ request }) => {
		await fixture.remove(request);
	});

	/**
	 * The seasons a series page shows.
	 *
	 * Tiles rather than rows, and that is the page's own rule: a season is a thing with
	 * artwork and a number missing, an episode is a title and a size. Reading the wrong
	 * one here would make this journey fail for the layout rather than for the filing.
	 */
	const seasons = (page: Page) => page.locator(test0('media-list')).locator(test0('media-card'));

	/** One episode among the rows of a season page, found by the media it opens. */
	const episodeRow = (page: Page, id: string) =>
		page.locator(test0('media-row')).filter({ has: page.locator(`a[href$="/library/${id}"]`) });

	test('moves the episode to a season the gateway has to create', async ({ page }) => {
		const failures = watchApi(page);
		const episode = fixture.episodes[2];

		await signIn(page);

		// Before: one season, and the episode is inside it.
		await page.goto(`/library/${fixture.series.id}`);
		await expect(seasons(page)).toHaveCount(1);

		await page.goto(`/library/${fixture.season.id}`);
		await expect(episodeRow(page, episode.id)).toHaveCount(1);

		await page.goto(`/library/${episode.id}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();

		await page.locator(field0('override-season')).fill('2');
		await page.locator(field0('override-episode')).fill('1');
		await page.locator(test0('override-save')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();

		/*
		 * The series now lists two seasons.
		 *
		 * The second one is the gateway's own row: the fake server reports one season
		 * and will go on reporting one, so either this node was created here or the
		 * correction had nowhere to land.
		 */
		await page.goto(`/library/${fixture.series.id}`);
		await expect(seasons(page)).toHaveCount(2);

		// Named beside its sibling: the fixture calls the first one `Season 1`, so the
		// created row reads `Season 2` rather than anything of our own invention.
		await expect(seasons(page).nth(1).locator(test0('media-open'))).toHaveText(/Season 2/);

		// And the episode is under it, not under season one.
		await seasons(page).nth(1).locator(test0('media-open')).click();
		await expect(episodeRow(page, episode.id)).toHaveCount(1);

		await page.goto(`/library/${fixture.season.id}`);
		await expect(episodeRow(page, episode.id)).toHaveCount(0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('keeps the created season when the service is scanned again', async ({ page, request }) => {
		// The fake server still reports one season and three episodes of it, so the pass
		// that drops what a scan no longer saw would take the created row and file the
		// episode back under season one — the correction undoing itself on a timer, with
		// nothing anywhere reporting an error.
		const failures = watchApi(page);
		const headers = await authorized(request);

		const scanned = await request.post(`${API_URL}/services/${fixture.serviceId}/scan`, { headers });
		expect(scanned.ok(), `scan failed: ${scanned.status()}`).toBeTruthy();

		// The scan answers before it has walked anything, so the journey waits on what it
		// writes rather than on a delay: exactly one season two, never none and never a
		// second one built beside it.
		await until(
			async () => {
				const listed = await request.get(
					`${API_URL}/media/groups/${fixture.series.id}/children?limit=20`,
					{ headers },
				);
				return (await listed.json() as { items: { seasonNumber: number | null }[] }).items;
			},
			children => settled(children),
			'the scan removed or duplicated the season the gateway created',
		);

		await signIn(page);
		await page.goto(`/library/${fixture.series.id}`);
		await expect(seasons(page)).toHaveCount(2);
		await expect(episodeRow(page, fixture.episodes[2].id)).toHaveCount(0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('puts the episode back under the season the service files it in', async ({ page }) => {
		const failures = watchApi(page);
		const episode = fixture.episodes[2];

		await signIn(page);
		await page.goto(`/library/${episode.id}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();

		await page.locator(test0('override-restore')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();

		// One season again: the row nobody is under any more goes with the correction,
		// because nothing else could ever remove it — no service will stop reporting a
		// row no service ever reported.
		await page.goto(`/library/${fixture.series.id}`);
		await expect(seasons(page)).toHaveCount(1);

		await page.goto(`/library/${fixture.season.id}`);
		await expect(episodeRow(page, episode.id)).toHaveCount(1);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
