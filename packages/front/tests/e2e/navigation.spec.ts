import { expect, test } from '@playwright/test';
import { signIn, test0 } from './helpers';

/**
 * Every top-level page opens.
 *
 * Cheap, and it catches the failure that costs the most time to diagnose: a route
 * whose lazy chunk fails to resolve renders a blank frame with one line in the
 * console, and nothing else in the suite looks at these pages at all.
 */
const ROUTES = ['library', 'services', 'peers', 'sync', 'transfers', 'settings'] as const;

test.describe('navigation', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
	});

	for (const route of ROUTES) {
		test(`the ${route} page opens`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));

			await page.locator(test0(`nav-${route}`)).click();
			await expect(page).toHaveURL(new RegExp(`/${route}`));
			await expect(page.locator(test0('page-title'))).toBeVisible();
			expect(errors, errors.join('\n')).toHaveLength(0);
		});
	}
});
