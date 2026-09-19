import { expect, type Page, test } from '@playwright/test';
import { signIn, test0 } from './helpers';

/**
 * Every top-level page opens, and the API answers everything it asks for.
 *
 * The second half was learned the hard way. This suite once passed in full while
 * `GET /api/peers` answered 500 on every call: the page rendered its title, its empty
 * state said there were no peers, and nothing anywhere distinguished "none" from
 * "the query failed". A journey that only checks a heading is a journey that passes
 * against a broken gateway.
 *
 * So each page is also watched at the network level. It is deliberately strict — any
 * status at or above 500, and any request that never completed — because those are
 * never acceptable and never ambiguous, unlike a 404, which some screens ask for on
 * purpose.
 */
const ROUTES = ['library', 'services', 'peers', 'sync', 'transfers', 'settings'] as const;

/** Collects every API answer a page was not entitled to get. */
function watchApi (page: Page): string[] {
	const failures: string[] = [];

	page.on('response', response => {
		if (response.url().includes('/api/') && response.status() >= 500) {
			failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
		}
	});

	page.on('requestfailed', request => {
		// The progress stream is closed by the browser on navigation, which is not a
		// failure of anything; only its own journey has anything to say about it.
		if (request.url().includes('/api/') && !request.url().includes('/api/events')) {
			failures.push(`failed ${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
		}
	});

	return failures;
}

test.describe('navigation', () => {
	for (const route of ROUTES) {
		test(`the ${route} page opens, and the API answers it`, async ({ page }) => {
			const errors: string[] = [];
			const failures = watchApi(page);

			page.on('pageerror', error => errors.push(error.message));

			await signIn(page);
			await page.locator(test0(`nav-${route}`)).click();
			await expect(page).toHaveURL(new RegExp(`/${route}`));
			await expect(page.locator(test0('page-title'))).toBeVisible();

			// Give the page's own calls time to come back: asserting immediately would
			// pass on a request that fails a moment later, which is the same blindness
			// this test exists to remove.
			await page.waitForLoadState('networkidle');

			expect(failures, failures.join('\n')).toHaveLength(0);
			expect(errors, errors.join('\n')).toHaveLength(0);
		});
	}
});
