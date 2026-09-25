import { expect, type Page, type Route, test } from '@playwright/test';
import { signIn, test0, watchApi } from './helpers';

/**
 * The session surviving a refusal, which is what somebody means by "I get signed out at
 * random".
 *
 * The access token lasts fifteen minutes and the interface replaces it on its own clock
 * before it expires. That answers the ordinary case and nothing else: the gateway checks
 * the session on **every** authenticated request, so one that stops being accepted while
 * the tab still believes its token good — the gateway restarted, the session revoked from
 * another device, a clock a minute out — produced a 401 that nothing recovered from.
 * Every screen then failed until somebody reloaded the page.
 *
 * Proved here rather than only in a unit test because the thing being claimed is about
 * the whole shell: a refusal arrives in the middle of a screen loading, and what has to
 * happen is that the screen loads anyway.
 */
test.describe('a session refused mid-flight', () => {
	/**
	 * Refuse the next authenticated call to one route, once.
	 *
	 * Once is the whole point: a gateway that refuses for ever is a session that has
	 * genuinely ended, and the interface is right to give up on it. What is being tested
	 * is the recoverable refusal, which is the common one.
	 */
	async function refuseOnce (
		page: Page,
		path: string,
	): Promise<{ refreshed: () => number; asked: () => number }> {
		let refusals = 0;
		let refreshes = 0;
		let asks = 0;

		page.on('request', request => {
			if (request.url().includes('/api/auth/refresh')) {
				refreshes += 1;
			}

			if (request.url().includes(path)) {
				asks += 1;
			}
		});

		await page.route(url => url.pathname.endsWith(path), async (route: Route) => {
			if (refusals > 0 || route.request().method() !== 'GET') {
				return route.fallback();
			}

			refusals += 1;

			return route.fulfill({
				status: 401,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'error.auth.session_expired', statusCode: 401 }),
			});
		});

		return { refreshed: () => refreshes, asked: () => asks };
	}

	test('renews and carries on instead of throwing somebody out', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);

		const session = await refuseOnce(page, '/api/services');

		await page.goto('/services');

		// The screen this refusal landed in the middle of drew itself. Asserted on the
		// title rather than on a list, because a fresh gateway has no services and the
		// page is then quite correctly an empty state — what is being tested is that the
		// screen works at all, which before it did not until somebody reloaded.
		await expect(page.locator(test0('page-title'))).toBeVisible();

		// And the way it recovered is the one this exists for: it traded the refresh
		// token for a new pair and asked again, rather than sending somebody back to the
		// sign-in screen.
		await expect.poll(() => session.refreshed(), {
			message: 'the refusal did not renew the session',
		}).toBeGreaterThan(0);
		await expect.poll(() => session.asked(), {
			message: 'the refused call was never made again',
		}).toBeGreaterThan(1);
		await expect(page).not.toHaveURL(/\/login/);
		expect(failures, 'the gateway answered a server error').toEqual([]);
	});
});
