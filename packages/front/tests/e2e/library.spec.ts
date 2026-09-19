import { expect, test } from '@playwright/test';
import { field0, signIn, test0 } from './helpers';

/**
 * Browsing the poster wall.
 *
 * The library is the screen this product is opened for, and almost everything on
 * it is a rendering decision that only a browser can check: that the bands are
 * there, that a tile carries its state and where its copies come from, that a
 * poster with no artwork shows something rather than a broken image, and that the
 * dense list is still one click away for the people who prefer it.
 */
test.describe('library', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
		await page.locator(test0('nav-library')).click();
		await expect(page.locator(test0('page-title'))).toBeVisible();
	});

	/**
	 * One band per *category* — every library of that name, on every server — headed
	 * by the name those libraries carry rather than by our structural enum. Two
	 * servers with a library called `Shows` are one band, which is the whole point of
	 * the merge.
	 */
	test('shows a band per merged category, under its own name', async ({ page }) => {
		const sections = page.locator(test0('library-section'));
		await expect(sections.first()).toBeVisible();

		const count = await sections.count();
		expect(count).toBeGreaterThan(0);

		const names = new Set<string>();
		for (let index = 0; index < count; index += 1) {
			const section = sections.nth(index);
			await expect(section).toHaveAttribute('data-category', /.+/);
			await expect(section.locator(test0('library-section-count'))).toBeVisible();
			// The heading is theirs, never our structural enum.
			await expect(section.locator('.library-section_title')).not.toHaveText(/^(shows|movies|music|other)$/);
			names.add((await section.locator('.library-section_title').textContent() ?? '').trim());
		}

		// Merged means merged: one band per name, never one per library-and-server.
		expect(names.size).toBe(count);
	});

	/** A glance at what is new, then everything in it, paginated. */
	test('opens a category on its own, and says where you are', async ({ page }) => {
		const section = page.locator(test0('library-section')).first();
		const heading = (await section.locator('.library-section_title').textContent() ?? '').trim();
		await expect(section.locator(test0('library-section-latest'))).toBeVisible();

		await section.locator(test0('library-section-all')).click();

		await expect(page).toHaveURL(/category=/);
		await expect(page.locator(test0('library-section'))).toHaveCount(1);

		const trail = page.locator(test0('media-breadcrumb'));
		await expect(trail).toBeVisible();
		await expect(trail.locator(test0('media-breadcrumb-current'))).toHaveText(heading);

		// The way back out is a step, not the browser's own button.
		await trail.locator(test0('media-breadcrumb-step')).first().click();
		await expect(page).not.toHaveURL(/category=/);
	});

	test('browses across every category on request', async ({ page }) => {
		await page.locator(`${test0('library-everything')} input`).check();
		await expect(page).toHaveURL(/all=/);
		await expect(page.locator(test0('library-section'))).toHaveCount(1);
	});

	test('shows a poster per media, with its state and who holds it', async ({ page }) => {
		const card = page.locator(test0('media-card')).first();
		await expect(card).toBeVisible();

		// The state badge and the source marks are the two things a glance is for.
		await expect(card.locator(test0('sync-state'))).toBeVisible();
		await expect(card.locator(test0('source-marks'))).toBeVisible();
		await expect(card).toHaveAttribute('data-state', /\w+/);
		// Every mark says how far away that copy is, and not merely that it is remote.
		await expect(card.locator(test0('source-marks'))).toHaveAttribute('data-origins', /\w+/);
	});

	/**
	 * "Show me what my friends have" is one filter, and naming six servers is not.
	 * Both travel in the address, so a filtered wall stays a link somebody can send.
	 */
	test('filters by origin, and keeps it in the address', async ({ page }) => {
		await page.locator(test0('media-origin-local')).click();
		await expect(page).toHaveURL(/origins=local/);

		await page.reload();
		await expect(page.locator(test0('media-origin-local'))).toHaveClass(/media-filters_origin--on/);

		// The four are readable without opening anything, friends of friends included.
		await expect(page.locator(test0('media-origin-friend'))).toBeVisible();
		await expect(page.locator(test0('media-origin-friend_of_friend'))).toBeVisible();
	});

	/**
	 * The lab library is generated video with almost no artwork, so the placeholder
	 * is what most of the wall is made of — and a wall of broken-image icons is
	 * exactly the failure this checks for.
	 */
	test('draws a placeholder rather than a broken image where there is no artwork', async ({ page }) => {
		const posters = page.locator(test0('media-poster'));
		await expect(posters.first()).toBeVisible();

		const broken = await page.locator(`${test0('media-poster')} img`).evaluateAll(images => {
			return images.filter(image => {
				const element = image as HTMLImageElement;
				return element.complete && element.naturalWidth === 0;
			}).length;
		});

		expect(broken, 'a poster failed to load and left a broken image').toBe(0);
	});

	test('keeps a filtered wall in the address, so it can be sent to somebody', async ({ page }) => {
		await page.locator(`${test0('media-search')} input`).fill('bunny');
		await expect(page).toHaveURL(/search=bunny/);

		await page.reload();
		await expect(page.locator(`${test0('media-search')} input`)).toHaveValue('bunny');
	});

	test('offers the dense list to whoever wants it, and remembers the choice', async ({ page }) => {
		await page.locator(test0('library-view-list')).click();
		await expect(page.locator(test0('media-row')).first()).toBeVisible();

		await page.reload();
		await expect(page.locator(test0('media-row')).first()).toBeVisible();

		await page.locator(test0('library-view-grid')).click();
		await expect(page.locator(test0('media-card')).first()).toBeVisible();
	});

	/** Picking a handful of media and pulling them is the point of the wall. */
	test('lets a media be picked on the wall and offers to sync the selection', async ({ page }) => {
		await expect(page.locator(test0('library-selection-bar'))).toHaveCount(0);

		// Chained rather than concatenated: `field0` is a selector list, and gluing a
		// prefix in front of it would only scope the first alternative.
		await page.locator(test0('media-card')).first().locator(field0('media-select')).check();

		const bar = page.locator(test0('library-selection-bar'));
		await expect(bar).toBeVisible();
		await expect(bar.locator(test0('library-sync-selected'))).toBeEnabled();

		await bar.locator(test0('library-selection-clear')).click();
		await expect(page.locator(test0('library-selection-bar'))).toHaveCount(0);
	});

	test('opens a media and lists every server that holds it', async ({ page }) => {
		await page.locator(`${test0('media-card')} .media-card_title`).first().click();
		await expect(page).toHaveURL(/\/library\/[\da-f-]{36}/);
		await expect(page.locator(test0('page-title'))).toBeVisible();

		// Where it sits, from the category down, with every step but the last a link.
		await expect(page.locator(test0('media-breadcrumb'))).toBeVisible();
		await expect(page.locator(test0('media-breadcrumb-step')).first()).toBeVisible();

		await expect(page.locator(test0('source-picker'))).toBeVisible();
		await expect(page.locator(test0('group-source')).first()).toBeVisible();
		await expect(page.locator(test0('item-sync'))).toBeEnabled();
	});
});
