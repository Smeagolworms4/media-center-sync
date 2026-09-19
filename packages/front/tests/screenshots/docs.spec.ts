import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { signIn, test0 } from '../e2e/helpers';

/**
 * Two pictures for the README: what the gateway shows you, and what it is pointed at.
 *
 * They are signed in and taken against a stack holding real libraries, because the
 * thing worth showing is a populated shelf. An empty-state screenshot answers the
 * question "does this do anything" with "apparently not".
 */
// The package is ESM, so there is no `__dirname` to resolve against.
const DOCS = resolve(fileURLToPath(import.meta.url), '../../../../../docs/images');

test.beforeAll(() => {
	mkdirSync(DOCS, { recursive: true });
});

test('the library, as a poster wall of merged categories', async ({ page }) => {
	await signIn(page);
	await page.goto('/library');
	await expect(page.locator(test0('library-section')).first()).toBeVisible({ timeout: 15_000 });

	// Posters are lazily fetched and a shot taken too early shows grey rectangles,
	// which is the one thing this picture exists to disprove.
	await page.waitForLoadState('networkidle');

	await page.screenshot({ path: resolve(DOCS, 'library.png') });
});

test('the media services this gateway reads and feeds', async ({ page }) => {
	await signIn(page);
	await page.goto('/services');
	await expect(page.locator(test0('service-row')).first()).toBeVisible({ timeout: 15_000 });
	await page.waitForLoadState('networkidle');

	/*
	 * Clipped to the content, because this screen is a short list on a tall page.
	 * A full frame of it is two rows and then seven hundred pixels of background,
	 * which in a README reads as a screen with nothing on it.
	 */
	const bottom = await page.evaluate(() => {
		const list = document.querySelector('[data-test="service-list"]');

		return (list?.getBoundingClientRect().bottom ?? 0) + window.scrollY;
	});

	await page.screenshot({
		path: resolve(DOCS, 'services.png'),
		clip: { x: 0, y: 0, width: 1440, height: Math.ceil(bottom) + 32 },
	});
});
