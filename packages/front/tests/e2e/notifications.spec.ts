import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { authorized } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';

/**
 * The ways this gateway reaches somebody, and the one that stopped working.
 *
 * A channel is a row with its own routes and its own form rather than a setting on the
 * settings body, so nothing on this pane is saved by the page's save button and
 * nothing here can mark a tab. That makes the refusals its own responsibility, which
 * is what these journeys are mostly about: a channel the handler cannot use must be
 * refused under the box that is wrong, and a channel that cannot be reached must say
 * so on the row — not only in the toast that was on screen for four seconds while
 * somebody was pressing the test button.
 *
 * Fixtures: created here over the API or through the form, and removed in a `finally`.
 * Nothing needs a server that answers: the channel these point at is a port nothing
 * listens on, which is the case worth proving and the only one that is the same on
 * every machine.
 */
interface Channel {
	id: string;
	name: string;
	type: string;
	lastError: string | null;
	lastSentAt: string | null;
}

/** Named so a leftover is recognisable, and so the cleanup can find it by name. */
const NTFY_NAME = 'Journey ntfy';
const SMTP_NAME = 'Journey mailbox';

/** A port nothing listens on, on an address that resolves instantly. */
const NOWHERE = 'http://127.0.0.1:1';

async function channelsOf (request: APIRequestContext): Promise<Channel[]> {
	const response = await request.get(`${API_URL}/notifications/channels`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `channels failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Channel[];
}

/** Removes every channel this file may have left behind, by the names it uses. */
async function forget (request: APIRequestContext, ...names: string[]): Promise<void> {
	const headers = await authorized(request);

	for (const channel of await channelsOf(request)) {
		if (names.includes(channel.name)) {
			await request.delete(`${API_URL}/notifications/channels/${channel.id}`, { headers });
		}
	}
}

async function createNtfy (request: APIRequestContext, name: string): Promise<Channel> {
	const response = await request.post(`${API_URL}/notifications/channels`, {
		headers: await authorized(request),
		data: {
			name,
			type: 'ntfy',
			enabled: true,
			events: [],
			config: { url: NOWHERE, topic: 'journeys' },
		},
	});
	expect(response.ok(), `create failed: ${response.status()} ${await response.text()}`).toBeTruthy();
	return await response.json() as Channel;
}

/** Opens the settings screen on the pane the channels live on. */
async function openChannels (page: Page): Promise<void> {
	await page.goto('/settings');
	await page.locator(test0('settings-tab-notifications')).click();
	await expect(page.locator(test0('notification-channels'))).toBeVisible();
}

test.describe('notification channels', () => {
	test('the pane lists what the gateway holds, and says so when it holds none', async ({ page, request }) => {
		const channels = await channelsOf(request);

		const failures = watchApi(page);
		await signIn(page);
		await openChannels(page);

		for (const channel of channels) {
			await expect(page.locator(test0(`notification-channel-${channel.id}`))).toBeVisible();
		}

		// A section that simply renders nothing is indistinguishable from one whose
		// query failed, which is the whole reason this sentence exists.
		await expect(page.locator(test0('notification-empty')))
			.toHaveCount(channels.length === 0 ? 1 : 0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('an ntfy channel is added through the form, and removed from its row', async ({ page, request }) => {
		const failures = watchApi(page);

		try {
			await signIn(page);
			await openChannels(page);

			await page.locator(test0('notification-add')).click();
			await expect(page.locator(test0('notification-dialog'))).toBeVisible();

			await page.locator(field0('notification-name')).fill(NTFY_NAME);
			// ntfy is the kind the dialog opens on, so nothing is chosen here: a click
			// spent on a select that is already right is a click that can go wrong.
			await page.locator(field0('notification-config-url')).fill(NOWHERE);
			await page.locator(field0('notification-config-topic')).fill('journeys');
			await page.locator(test0('notification-save')).click();

			await expect(page.locator(test0('notification-dialog'))).toBeHidden();

			// The gateway holds it, rather than the list holding a row it drew.
			const held = (await channelsOf(request)).find(one => one.name === NTFY_NAME);
			expect(held, 'the channel was never recorded').toBeDefined();

			const row = page.locator(test0(`notification-channel-${held!.id}`));
			await expect(row).toBeVisible();
			// A channel nobody has used yet says as much. Blank, it reads either as a
			// channel that has worked forever or as one whose state failed to load.
			await expect(row.locator(test0('notification-never-sent'))).toBeVisible();

			await row.locator(test0(`notification-remove-${held!.id}`)).click();
			await page.locator(test0('confirm-accept')).click();

			await expect(row).toHaveCount(0);
			expect(
				(await channelsOf(request)).some(one => one.name === NTFY_NAME),
				'the row went but the channel stayed',
			).toBe(false);
		} finally {
			await forget(request, NTFY_NAME);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a setting the channel cannot work without never leaves the form', async ({ page, request }) => {
		const failures = watchApi(page);
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes('/notifications/channels')) {
				attempts.push(one.url());
			}
		});

		try {
			await signIn(page);
			await openChannels(page);

			await page.locator(test0('notification-add')).click();
			await page.locator(field0('notification-name')).fill(NTFY_NAME);
			// The topic is filled and the address is not: an ntfy channel without a
			// server to publish to would be stored and would deliver nothing.
			await page.locator(field0('notification-config-topic')).fill('journeys');

			/*
			 * The field says something else afterwards, whatever it says.
			 *
			 * Compared against what it said a moment earlier rather than against a
			 * sentence, the way `setup.spec.ts` does it: the wording is Vuetify's
			 * rendering of our rule in whichever language the browser asked for, and a
			 * journey that spelled it out would break on a rewording.
			 */
			const url = page.locator(test0('notification-config-url'));
			const saidBefore = (await url.textContent() ?? '').trim();

			await page.locator(test0('notification-save')).click();

			await expect
				.poll(async () => (await url.textContent() ?? '').trim(), {
					message: 'the form said nothing about the address it cannot accept',
				})
				.not
				.toBe(saidBefore);

			// Said on the spot, and the dialog is still open: a refusal on a dialog that
			// closed would be a refusal nobody can act on.
			await expect(page.locator(test0('notification-dialog'))).toBeVisible();

			await page.waitForLoadState('networkidle');
			expect(attempts, `a channel was posted anyway: ${attempts.join(', ')}`).toHaveLength(0);
			expect(
				(await channelsOf(request)).some(one => one.name === NTFY_NAME),
				'a channel that could never deliver was stored',
			).toBe(false);
		} finally {
			await forget(request, NTFY_NAME);
		}

		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a channel that cannot be reached says so on its row, and still does after a reload', async ({ page, request }) => {
		const channel = await createNtfy(request, NTFY_NAME);
		const failures = watchApi(page);

		try {
			await signIn(page);
			await openChannels(page);

			const row = page.locator(test0(`notification-channel-${channel.id}`));
			await expect(row.locator(test0('notification-never-sent'))).toBeVisible();

			await row.locator(test0(`notification-test-${channel.id}`)).click();

			// The toast is the immediate answer to the button that was pressed.
			const toast = page.locator(test0('notify')).first();
			await expect(toast).toBeVisible({ timeout: 30_000 });

			/*
			 * And the row keeps it, which is the part that matters.
			 *
			 * A channel that has delivered nothing since March has to be visible as
			 * such on the screen somebody opens months later — the toast was gone four
			 * seconds after the button was pressed, and nothing else on this pane
			 * would ever mention it again.
			 */
			const stated = row.locator(test0('notification-last-error'));
			await expect(stated).toBeVisible({ timeout: 30_000 });
			// The far end's own words, so the sentence is a diagnosis rather than a
			// shrug: an empty one would say only that something went wrong.
			await expect(stated).not.toHaveText('');

			await page.reload();
			await page.locator(test0('settings-tab-notifications')).click();
			await expect(page.locator(test0(`notification-channel-${channel.id}`))
				.locator(test0('notification-last-error'))).toBeVisible();

			// The gateway holds the failure too, rather than the screen remembering it.
			const held = (await channelsOf(request)).find(one => one.id === channel.id);
			expect(held?.lastError, 'nothing was recorded about the failed send').toBeTruthy();
		} finally {
			await forget(request, NTFY_NAME);
		}

		// The test route answers `200` with a result: a channel that refused us is an
		// ordinary answer this screen renders, and a 5xx here would be the gateway
		// reporting itself broken about a message it handled perfectly well.
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a mailbox asks for other settings, and a port the handler refuses lands on the port box', async ({ page, request }) => {
		const failures = watchApi(page);

		try {
			await signIn(page);
			await openChannels(page);

			await page.locator(test0('notification-add')).click();
			await page.locator(field0('notification-name')).fill(SMTP_NAME);

			// The kind decides which boxes are drawn, and that is the whole reason a
			// channel is not a set of settings on the page body: ntfy asks for a topic,
			// a mailbox asks for a host and two addresses, and they share nothing.
			await expect(page.locator(test0('notification-config-topic'))).toBeVisible();
			await page.locator(test0('notification-type')).click();
			await page.getByRole('option').nth(1).click();

			await expect(page.locator(test0('notification-config-topic'))).toHaveCount(0);
			await expect(page.locator(test0('notification-config-host'))).toBeVisible();

			await page.locator(field0('notification-config-host')).fill('127.0.0.1');
			await page.locator(field0('notification-config-from')).fill('gateway@example.invalid');
			await page.locator(field0('notification-config-to')).fill('somebody@example.invalid');
			// Not a port. The interface deliberately keeps no copy of the handler's
			// rules, so this is refused by the API — and the refusal has to arrive under
			// the one box somebody has to change, not above the whole form.
			await page.locator(field0('notification-config-port')).fill('99999');

			const port = page.locator(test0('notification-config-port'));
			const saidBefore = (await port.textContent() ?? '').trim();

			await page.locator(test0('notification-save')).click();

			await expect
				.poll(async () => (await port.textContent() ?? '').trim(), {
					message: 'the refusal named no field; it was a sentence above the form',
				})
				.not
				.toBe(saidBefore);

			await expect(page.locator(test0('notification-dialog'))).toBeVisible();
			expect(
				(await channelsOf(request)).some(one => one.name === SMTP_NAME),
				'a channel the handler refused was stored',
			).toBe(false);

			// And with a port it can use, the same form saves.
			await page.locator(field0('notification-config-port')).fill('587');
			await page.locator(test0('notification-save')).click();
			await expect(page.locator(test0('notification-dialog'))).toBeHidden();

			const held = (await channelsOf(request)).find(one => one.name === SMTP_NAME);
			expect(held, 'the mailbox was never recorded').toBeDefined();
			expect(held!.type).toBe('smtp');

			// Editing it keeps the credential it was given: an empty secret box means
			// "leave what is stored alone", which is what makes renaming a channel
			// possible without retyping a password nothing ever gives back.
			await page.locator(test0(`notification-edit-${held!.id}`)).click();
			await page.locator(field0('notification-name')).fill(`${SMTP_NAME} renamed`);
			await page.locator(test0('notification-save')).click();
			await expect(page.locator(test0('notification-dialog'))).toBeHidden();

			const renamed = (await channelsOf(request)).find(one => one.id === held!.id);
			expect(renamed?.name).toBe(`${SMTP_NAME} renamed`);
		} finally {
			await forget(request, SMTP_NAME, `${SMTP_NAME} renamed`);
		}

		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
