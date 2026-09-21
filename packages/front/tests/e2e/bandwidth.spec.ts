import { type APIRequestContext, expect, test } from '@playwright/test';
import { authorized } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';

/**
 * The global caps, from the bar that is on every screen and from the settings page.
 *
 * Two controls write the same two numbers, which is the reason both are here: the
 * panel in the app bar is where somebody throttles the gateway while a video call is
 * starting, and the settings page is where the same value is typed as a size. They
 * refuse different things — a negative number and a size nobody can parse — and a
 * refusal on the settings page has the extra problem that one form saves six panes at
 * once, so a rate refused on the transfers pane can sit on a tab nobody opened.
 *
 * Fixtures: none, but two of these journeys write a global setting, and each reads the
 * caps first and puts them back in a `finally`: the stack they run against is
 * somebody's gateway, and a cap left behind is a gateway that has been quietly slow
 * ever since. The refusals write nothing and put nothing back, which is the point of
 * them — see the panel's refusal below for why a restore there would do harm.
 */
interface Caps {
	downloadRateLimit: number;
	uploadRateLimit: number;
}

/**
 * The presets the panel offers, in the order it draws them. Zero is first and on
 * purpose: taking a cap off is the action people look for in a hurry.
 */
const PRESETS = [0, 512 * 1024, 1024 ** 2, 2 * 1024 ** 2, 5 * 1024 ** 2];

async function capsOf (request: APIRequestContext): Promise<Caps> {
	const response = await request.get(`${API_URL}/settings`, { headers: await authorized(request) });
	expect(response.ok(), `settings failed: ${response.status()}`).toBeTruthy();
	const settings = await response.json() as Caps;
	return {
		downloadRateLimit: settings.downloadRateLimit,
		uploadRateLimit: settings.uploadRateLimit,
	};
}

/**
 * Puts the caps back, and writes nothing when nothing moved.
 *
 * Settings are sparse — a key nobody changed has no row — so writing back a value that
 * was never altered would turn a default into an explicit choice nobody made, and hide
 * for ever which of the two it was.
 */
async function restore (request: APIRequestContext, caps: Caps): Promise<void> {
	const current = await capsOf(request);
	if (current.downloadRateLimit === caps.downloadRateLimit && current.uploadRateLimit === caps.uploadRateLimit) {
		return;
	}

	const response = await request.patch(`${API_URL}/settings`, {
		headers: await authorized(request),
		data: caps,
	});
	expect(response.ok(), `the caps were not put back: ${response.status()}`).toBeTruthy();
}

test.describe('bandwidth', () => {
	test('the panel opens on the caps the gateway holds, and says when there are none', async ({ page, request }) => {
		const caps = await capsOf(request);

		const failures = watchApi(page);
		await signIn(page);

		// The live rate is on the button whether or not anything is capped, which is
		// what makes the control worth its space when nothing needs changing.
		await expect(page.locator(test0('bandwidth-control'))).toBeVisible();

		/*
		 * The caps beside it appear only when one is set.
		 *
		 * A gateway throttled to two megabytes a second that looks unthrottled is a
		 * support question waiting to happen, and an unthrottled one wearing a cap
		 * badge is the same confusion the other way round.
		 */
		const capped = caps.downloadRateLimit > 0 || caps.uploadRateLimit > 0;
		await expect(page.locator(test0('bandwidth-caps'))).toHaveCount(capped ? 1 : 0);

		await page.locator(test0('bandwidth-control')).click();
		await expect(page.locator(test0('bandwidth-panel'))).toBeVisible();

		// An empty field is not a missing value here: it is "no cap", which the field
		// spells out rather than leaving somebody to guess at a blank box.
		const download = page.locator(field0('bandwidth-download'));
		if (caps.downloadRateLimit === 0) {
			await expect(download).toHaveValue('');
			await expect(download).toHaveAttribute('placeholder', /.+/);
		} else {
			await expect(download).not.toHaveValue('');
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a preset is applied by the click that chooses it, and taken off the same way', async ({ page, request }) => {
		const before = await capsOf(request);
		// A preset that is not already in force, so that what is asserted afterwards is
		// this journey's doing rather than the state it found.
		const chosen = PRESETS.findIndex(one => one > 0 && one !== before.downloadRateLimit);
		expect(chosen, 'no preset differs from the cap already set').toBeGreaterThan(0);

		const failures = watchApi(page);

		try {
			await signIn(page);
			await page.locator(test0('bandwidth-control')).click();

			// One gesture, which is the whole reason the presets exist: "cap me at two
			// megabytes" must not be a field, a unit and a confirmation.
			await page.locator(test0('bandwidth-download-preset')).nth(chosen).click();

			await expect(page.locator(test0('bandwidth-caps'))).toBeVisible();
			await expect
				.poll(async () => (await capsOf(request)).downloadRateLimit, {
					message: 'the cap was never stored',
				})
				.toBe(PRESETS[chosen]);

			// And off again, which is the preset people look for in a hurry: the badge
			// goes with it, so the bar stops claiming a cap that is no longer in force.
			await page.locator(test0('bandwidth-download-preset')).first().click();
			await expect
				.poll(async () => (await capsOf(request)).downloadRateLimit)
				.toBe(0);

			if (before.uploadRateLimit === 0) {
				await expect(page.locator(test0('bandwidth-caps'))).toHaveCount(0);
			}
		} finally {
			await restore(request, before);
		}

		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a cap the panel cannot accept never leaves it, and the field says so', async ({ page }) => {
		// Nothing is put back afterwards, on purpose: this journey must not write, and
		// the proof is that this page sent nothing. Restoring "just in case" would
		// overwrite whatever another run on the same gateway had set meanwhile.
		const failures = watchApi(page);
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PATCH' && one.url().endsWith('/settings')) {
				attempts.push(one.url());
			}
		});

		await signIn(page);
		await page.locator(test0('bandwidth-control')).click();

		/*
		 * What the field said before the value was typed, and what it says after.
		 *
		 * Compared against itself rather than against a sentence, the way
		 * `setup.spec.ts` does it: the message is Vuetify's rendering of our rule,
		 * in whichever language the browser asked for. Read before the fill and not
		 * before the click, because this control answers as somebody types — which
		 * is the better behaviour and means the refusal is already on screen by the
		 * time the button is pressed.
		 */
		const download = page.locator(test0('bandwidth-download'));
		const saidBefore = (await download.textContent() ?? '').trim();

		// A negative cap is not a slow gateway, it is a number nothing can act on.
		await page.locator(field0('bandwidth-download')).fill('-5');

		await expect
			.poll(async () => (await download.textContent() ?? '').trim(), {
				message: 'the panel said nothing about a cap it cannot send',
			})
			.not
			.toBe(saidBefore);

		await page.locator(test0('bandwidth-apply')).click();

		// The panel stays open: a refusal behind a panel that closed is a refusal
		// nobody sees, and the value is still there to be corrected.
		await expect(page.locator(test0('bandwidth-panel'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(attempts, `the caps were written anyway: ${attempts.join(', ')}`).toHaveLength(0);

		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a rate the settings page cannot read marks its tab and opens it', async ({ page }) => {
		/*
		 * The same defect the peer depth journey pins, on the pane the caps live on.
		 *
		 * One form saves every setting at once. A rate refused on the transfers pane
		 * while somebody is looking at the placement pane would report that the
		 * settings were refused, show nothing anywhere visible, and leave them pressing
		 * save — which is the failure that has shipped in this product four times.
		 *
		 * Nothing is put back afterwards, for the reason the panel journey gives.
		 */
		const failures = watchApi(page);
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PATCH' && one.url().endsWith('/settings')) {
				attempts.push(one.url());
			}
		});

		await signIn(page);
		await page.goto('/settings');
		/*
		 * Typed into only once the stored values are in.
		 *
		 * The page fills every field when its loads settle, so a value typed before
		 * then is overwritten with the stored one — and the save below then writes the
		 * whole screen back instead of being refused. That happened once, on a gateway
		 * slow to answer after a restart.
		 */
		await page.waitForLoadState('networkidle');

		await page.locator(test0('settings-tab-transfers')).click();
		const rate = page.locator(field0('settings-download-rate'));
		await expect(rate).toBeVisible();
		await rate.fill('as fast as it goes');

		// Away to another pane, so the refusal has somewhere to hide.
		await page.locator(test0('settings-tab-placement')).click();
		await expect(rate).toBeHidden();

		// Still what was typed, right before the button that would otherwise save it.
		await expect(rate).toHaveValue('as fast as it goes');
		await page.locator(test0('settings-save')).click();

		await expect(page.locator(test0('settings-tab-error'))).toBeVisible();
		// Not merely marked: the pane carrying the refusal is the one now on screen,
		// because the person pressed save and is owed the reason rather than a red
		// dot to go hunting for.
		await expect(page.locator(field0('settings-download-rate'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(attempts, `the settings were saved anyway: ${attempts.join(', ')}`).toHaveLength(0);

		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
