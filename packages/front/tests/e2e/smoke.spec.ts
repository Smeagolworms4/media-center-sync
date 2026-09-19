import { expect, test } from '@playwright/test';
import { API_URL, test0 } from './helpers';

/**
 * The stack is up and the two halves can see each other.
 *
 * This runs first and deliberately checks almost nothing about the product: when it
 * fails, every other journey will fail too, and knowing it is the stack rather than
 * the feature saves the half hour spent reading the wrong failure.
 */
test.describe('smoke', () => {
	test('the API reports itself healthy', async ({ request }) => {
		const response = await request.get(`${API_URL}/health`);
		expect(response.ok()).toBeTruthy();

		const health = await response.json();
		expect(health.ok, `unhealthy: ${JSON.stringify(health.checks)}`).toBe(true);
		// The database check is the one that matters: a broken database leaves the
		// server answering and unusable, which is exactly the state this catches.
		expect(health.checks.some((c: { name: string; ok: boolean }) => c.name === 'database' && c.ok)).toBe(true);
	});

	test('the interface loads and offers a way in', async ({ page }) => {
		await page.goto('/login');
		await expect(page.locator(test0('login-submit'))).toBeVisible();
	});

	test('an unauthenticated visitor is sent to the sign-in page', async ({ page }) => {
		await page.goto('/transfers');
		await expect(page).toHaveURL(/\/login/);
	});
});
