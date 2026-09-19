import { expect, test } from '@playwright/test';
import { ADMIN, field0, signIn, test0 } from './helpers';

test.describe('signing in', () => {
	test('wrong credentials are refused, and say so in the form', async ({ page }) => {
		await page.goto('/login');
		await page.locator(field0('login-username')).fill(ADMIN.username);
		await page.locator(field0('login-password')).fill('not-the-password');
		await page.locator(test0('login-submit')).click();

		// The API answers an error key; the interface must have turned it into a
		// sentence. A raw `error.auth.invalid_credentials` on screen means the
		// catalogue is missing the key, which is a defect this catches.
		const error = page.locator(test0('form-main-error'));
		await expect(error).toBeVisible();
		await expect(error).not.toContainText('error.auth');
		await expect(page).toHaveURL(/\/login/);
	});

	test('the administrator signs in and reaches the dashboard', async ({ page }) => {
		await signIn(page);
		await expect(page.locator(test0('app-nav'))).toBeVisible();
	});

	test('signing out ends the session for good', async ({ page }) => {
		await signIn(page);
		await page.locator(test0('account-menu')).click();
		await page.locator(test0('account-logout')).click();
		await expect(page).toHaveURL(/\/login/);

		// Going back must not resurrect the session: the refresh token was revoked
		// server-side, not merely forgotten by the browser.
		await page.goto('/transfers');
		await expect(page).toHaveURL(/\/login/);
	});
});
