import { expect, test } from '@playwright/test';
import { authorized, createMediaFixture, type MediaFixture } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';

/**
 * Undoing a correction by reading it first.
 *
 * "Put it all back" writes at once and closes, which is right when somebody already
 * knows what they want. This is the other half of the same decision: fill the boxes
 * with what the service reports, leave them there, and let the person look before
 * agreeing.
 *
 * What the journey is really about is invisible from the screen — the **body** the
 * dialog then sends. Saving values that merely repeat the service's own answer must
 * remove the correction rather than record one with identical content. An item with no
 * correction goes on following its server, so the day Jellyfin fixes a title the next
 * scan picks it up; an item corrected to today's values is frozen on them for ever, and
 * nothing on any screen would ever say which of the two this is.
 *
 * Its own media server, and an episode rather than a root, so nothing this writes can
 * be picked up by the other correction journey running beside it.
 */
test.describe.serial('resetting a correction', () => {
	let fixture: MediaFixture;
	const CORRECTED = 'What the household calls it';

	test.beforeAll(async ({ request }) => {
		fixture = await createMediaFixture(request);
	});

	test.afterAll(async ({ request }) => {
		await fixture.remove(request);
	});

	test('offers nothing to reset on an item nobody has corrected', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);
		await page.goto(`/library/${fixture.episodes[0].id}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();

		// An action that cannot do anything teaches people not to read the row it is in.
		await expect(page.locator(test0('override-reset'))).toHaveCount(0);
		await expect(page.locator(test0('override-restore'))).toHaveCount(0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('fills the boxes with the service’s answer, and saving then drops the correction', async ({ page, request }) => {
		const failures = watchApi(page);
		const bodies: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PUT' && one.url().includes('/override')) {
				bodies.push(one.postData() ?? '');
			}
		});

		const episode = fixture.episodes[0];
		const reportedTitle = episode.title;

		await signIn(page);
		await page.goto(`/library/${episode.id}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();

		await page.locator(field0('override-title')).fill(CORRECTED);
		await page.locator(test0('override-save')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();
		await expect(page.locator(test0('page-title'))).toHaveText(CORRECTED);

		// Now the reset is on offer, because there is something to reset.
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();
		await expect(page.locator(field0('override-title'))).toHaveValue(CORRECTED);

		await page.locator(test0('override-reset')).click();

		// Visible before it is agreed to: the box changes and nothing has been written.
		await expect(page.locator(field0('override-title'))).toHaveValue(reportedTitle);
		await expect(page.locator(test0('page-title'))).toHaveText(CORRECTED);
		expect(bodies, 'the reset saved on its own').toHaveLength(1);

		await page.locator(test0('override-save')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();
		await expect(page.locator(test0('page-title'))).toHaveText(reportedTitle);

		// The body is the whole point: nothing at all, which is what removes the
		// correction. A body repeating the reported title would store one instead.
		expect(bodies).toHaveLength(2);
		expect(JSON.parse(bodies[1]) as Record<string, unknown>).toEqual({});

		// And the row says so, which is what the next scan reads: no instruction to
		// re-apply, and no snapshot to restore — this item follows its server again.
		const headers = await authorized(request);
		const read = await request.get(`${API_URL}/media/${episode.id}`, { headers });
		const item = await read.json() as { title: string; overrides: unknown; reported: unknown };

		expect(item.overrides).toBeNull();
		expect(item.reported).toBeNull();
		expect(item.title).toBe(reportedTitle);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
