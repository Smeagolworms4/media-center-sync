import { expect, test } from '@playwright/test';
import { API_URL, apiToken, field0, signIn, test0, watchApi } from './helpers';

/**
 * The settings page, which is six sections behind one save button.
 *
 * This journey exists because of a mistake worth not repeating. The sections were
 * turned into tabs, a unit test clicked a tab and saw the pane change, and the
 * feature was then declared broken in a browser and reverted — on the strength of
 * screenshots taken while a menu was still animating, and of clicks that had silently
 * become modified clicks. Nothing in the code was wrong. A journey answers the
 * question the unit test cannot and the eye gets wrong: does a click on a tab put the
 * other section on screen, in a real browser.
 *
 * The panes are `v-show` rather than a transition for the same reason: a pane is
 * either displayed or it is not, so nothing here has to wait out an animation and
 * decide what it saw.
 */
test.describe('settings', () => {
	test('every section is reachable, and only one is shown at a time', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);
		await page.goto('/settings');

		await expect(page.locator(test0('settings-tabs'))).toBeVisible();
		// The first pane is the one that answers the question people come here with.
		await expect(page.locator(field0('settings-peer-depth'))).toBeHidden();

		await page.locator(test0('settings-tab-peers')).click();

		await expect(page.locator(field0('settings-peer-depth'))).toBeVisible();
		// And the pane left behind is gone, not merely scrolled past.
		await expect(page.locator(test0('settings-write-nfo'))).toBeHidden();

		await page.locator(test0('settings-tab-placement')).click();

		await expect(page.locator(test0('settings-write-nfo'))).toBeVisible();
		await expect(page.locator(field0('settings-peer-depth'))).toBeHidden();

		expect(failures, failures.join('\n')).toEqual([]);
	});

	test('a refusal marks its tab and opens it, rather than hiding on a closed one', async ({ page }) => {
		// The failure tabs introduce: one form saves everything, so a refused field can
		// sit on a pane nobody is looking at. The screen would say the settings were
		// refused, show nothing anywhere visible, and leave somebody pressing save.
		await signIn(page);
		await page.goto('/settings');

		await page.locator(test0('settings-tab-peers')).click();
		await page.locator(field0('settings-peer-depth')).fill('99');

		// Back to another pane, so the refusal has somewhere to hide.
		await page.locator(test0('settings-tab-placement')).click();
		await expect(page.locator(field0('settings-peer-depth'))).toBeHidden();

		await page.locator(test0('settings-save')).click();

		await expect(page.locator(test0('settings-tab-error'))).toBeVisible();
		await expect(page.locator(field0('settings-peer-depth'))).toBeVisible();
	});

	test('the folder picker fills the field, and refuses what cannot be written to', async ({ page, request }) => {
		// Typing a path by hand is where the worst failure of this product starts: a
		// path that does not designate the directory the media server reads accepts
		// transfers the server never sees, with nothing reporting an error.
		await signIn(page);
		await page.goto('/settings');

		// The fallback folder lives with the rest of the placement rule now, which is
		// the only section where a path is an answer to "where does this land".
		await page.locator(test0('settings-default-target-browse')).click();

		const crumbs = page.locator(test0('browse-crumbs'));
		await expect(crumbs).toBeVisible();

		// The roots the API itself reports, so the journey asserts against the gateway
		// rather than against whatever this machine happens to have under /media.
		const listing = await request.get(`${API_URL}/filesystem/directories`, {
			headers: { Authorization: `Bearer ${await apiToken(request)}` },
		});
		expect(listing.ok(), `listing failed: ${listing.status()}`).toBeTruthy();
		const body = await listing.json() as { path: string; writable: boolean };

		await expect(crumbs).toContainText(body.path);
		// A folder the gateway cannot write into must not be offerable: choosing one
		// would queue transfers that can never land.
		await expect(page.locator(test0('browse-choose')))
			.toBeEnabled({ enabled: body.writable });
	});

	test('states the rule and gives every category a row of its own', async ({ page }) => {
		// The most important screen in the product: a file that lands somewhere the
		// media server never scans is a transfer that succeeded and produced nothing.
		// The rule has to be readable, and every category has to have a destination
		// somebody can see — including the ones that simply fall back.
		const failures = watchApi(page);

		await signIn(page);
		await page.goto('/settings');

		// The placement pane is the one the page opens on, so nothing is clicked first:
		// a click that silently became a modified click is how this journey earns its
		// keep, and there is no reason to spend one here.
		await expect(page.locator(test0('settings-placement-rule'))).toBeVisible();
		await expect(page.locator(test0('settings-placement-rule-existing')))
			.toContainText('Saison 1');

		await expect(page.locator(test0('settings-default-target-library'))).toBeVisible();

		const rows = page.locator(test0('category-target-row'));
		// The stack this runs against carries several categories; one row is the claim
		// worth making, because a table that renders none is the failure being watched.
		await expect(rows.first()).toBeVisible();
		expect(await rows.count()).toBeGreaterThan(0);

		// A row nobody has configured says where its media goes rather than sitting
		// empty, which is what a blank cell in a table of destinations reads as.
		await expect(page.locator(test0('category-target-fallback')).first()).toBeVisible();

		expect(failures, failures.join('\n')).toEqual([]);
	});
});
