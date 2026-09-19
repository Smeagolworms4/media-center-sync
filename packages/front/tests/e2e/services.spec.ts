import { expect, test } from '@playwright/test';
import { API_URL, apiToken, signIn, test0 } from './helpers';

/**
 * Registering a service, and failing to.
 *
 * The failure matters more than the success here. Somebody setting this up types an
 * address and a token, and the first thing that happens to most people is that one of
 * the two is wrong. A form that saves a service which does not work, and only reveals
 * it on the next scan, is the difference between a tool somebody keeps and one they
 * uninstall.
 */
test.describe('media services', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
		await page.locator(test0('nav-services')).click();
	});

	test('a service that cannot be reached is refused, and says why', async ({ page }) => {
		await page.locator(test0('service-add')).click();
		await page.locator(test0('service-name')).fill('Nowhere');
		// A port nothing listens on, on an address that resolves instantly. A public
		// host would make this test depend on the network being up.
		await page.locator(test0('service-url')).fill('http://127.0.0.1:1');
		await page.locator(test0('service-probe')).click();

		const error = page.locator(test0('form-main-error'));
		await expect(error).toBeVisible({ timeout: 20_000 });
		// The API answers a key; if the catalogue is missing it, the raw key shows.
		await expect(error).not.toContainText('error.service');
	});

	test('the list shows what the API holds', async ({ page, request }) => {
		const token = await apiToken(request);
		const created = await request.post(`${API_URL}/services`, {
			headers: { Authorization: `Bearer ${token}` },
			data: {
				name: 'Journey fixture',
				type: 'jellyfin',
				scope: 'remote',
				baseUrl: 'http://127.0.0.1:1',
			},
		});
		expect(created.ok(), `create failed: ${created.status()} ${await created.text()}`).toBeTruthy();
		const service = await created.json();

		// A token is never returned by any route. Asserting it here rather than only in
		// a unit test is deliberate: this is the response a browser actually receives.
		expect(service.token).toBeUndefined();

		await page.reload();
		await expect(page.locator(test0('service-row')).filter({ hasText: 'Journey fixture' })).toBeVisible();

		await request.delete(`${API_URL}/services/${service.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
	});
});
