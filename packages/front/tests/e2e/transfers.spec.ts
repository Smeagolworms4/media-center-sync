import { expect, test } from '@playwright/test';
import { signIn, test0 } from './helpers';

test.describe('transfers', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
		await page.locator(test0('nav-transfers')).click();
	});

	test('an empty queue says so instead of showing an empty frame', async ({ page }) => {
		// A fresh gateway has no transfers, and that is the first thing anybody sees.
		// A blank page here reads as a broken one.
		await expect(page.locator(test0('empty-state'))).toBeVisible();
	});

	test('the progress stream is connected', async ({ page }) => {
		// The stream is what every progress bar depends on. When it is refused — a
		// missing attach, a proxy that drops the upgrade — nothing errors: the page
		// renders, the queue is right, and the bars simply never move. Only the
		// handshake itself distinguishes that from an idle gateway.
		//
		// Matched on the URL, because in development the first socket a page opens is
		// Vite's own hot-reload channel. Taking whichever arrives first passes against
		// the wrong connection, and would keep passing with the event stream switched
		// off entirely.
		const opened = page.waitForEvent('websocket', {
			predicate: socket => socket.url().includes('/api/events'),
			timeout: 15_000,
		});

		await page.reload();

		const socket = await opened;

		expect(socket.isClosed()).toBe(false);
	});
});
