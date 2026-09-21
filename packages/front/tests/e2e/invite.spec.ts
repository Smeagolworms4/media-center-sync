import { expect, test } from '@playwright/test';
import { field0, signIn, test0, watchApi } from './helpers';

/**
 * The invitation dialog's two halves `peers.spec.ts` does not reach.
 *
 * That file links a gateway by fingerprint and proves a bad invitation is refused in
 * words. Left over were handing an invitation out — the tab the dialog opens on, and
 * the first thing most people do with it — and the fingerprint form's own refusal,
 * which never reaches the gateway at all.
 *
 * Fixtures: none. Handing out an invitation does write one row, and no route removes
 * it: it is one-shot, it expires on its own, and its secret exists only in this
 * browser. That is the one thing these journeys leave behind, and it is harmless by
 * construction rather than by cleanup.
 */
test.describe('invitations', () => {
	test('handing out an invitation shows what to send, and says when it stops working', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);
		await page.goto('/peers');
		await page.locator(test0('peer-invite')).click();
		await expect(page.locator(test0('invite-dialog'))).toBeVisible();

		// The dialog opens on handing one out, which is what whoever opened it has
		// usually just been asked for.
		await expect(page.locator(test0('invite-create'))).toBeVisible();
		await expect(page.locator(test0('invite-result'))).toHaveCount(0);

		const created = page.waitForResponse(one => one.request().method() === 'POST' && one.url().endsWith('/peers/invites'));
		await page.locator(test0('invite-create')).click();
		expect((await created).ok(), 'the gateway refused to issue an invitation').toBe(true);

		/*
		 * Two things to send and the terms they come with.
		 *
		 * The link and the code are each copyable on their own, because they go to
		 * different places — a chat message, a form on the other gateway. And the
		 * expiry is said next to them: an invitation that silently died an hour ago is
		 * indistinguishable, from the other side, from one that was mistyped.
		 */
		const result = page.locator(test0('invite-result'));
		await expect(result).toBeVisible();
		await expect(result.locator(test0('copy-button'))).toHaveCount(2);
		await expect(result.locator(test0('invite-expiry'))).not.toHaveText('');

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a fingerprint left empty is refused under its box, and nothing is linked', async ({ page }) => {
		const failures = watchApi(page);
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'POST' && /\/api\/peers$/.test(one.url())) {
				attempts.push(one.url());
			}
		});

		await signIn(page);
		await page.goto('/peers');
		await page.locator(test0('peer-invite')).click();
		await page.locator(test0('invite-tab-fingerprint')).click();

		// A name alone: the fingerprint is the link, and a peer with a name and no key
		// is a row that can never connect to anybody.
		await page.locator(field0('peer-name')).fill('Journey nobody');

		/*
		 * The box says something else afterwards, whatever it says — compared against
		 * itself, because the wording is in whichever language the browser asked for.
		 */
		const fingerprint = page.locator(test0('peer-fingerprint'));
		const saidBefore = (await fingerprint.textContent() ?? '').trim();

		await page.locator(test0('peer-add')).click();

		await expect
			.poll(async () => (await fingerprint.textContent() ?? '').trim(), {
				message: 'the form said nothing about the missing fingerprint',
			})
			.not
			.toBe(saidBefore);
		await expect(page.locator(test0('invite-dialog'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(attempts, `a peer was posted anyway: ${attempts.join(', ')}`).toHaveLength(0);
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
