import { type APIRequestContext, expect, test } from '@playwright/test';
import { field0, test0, watchApi } from './helpers';

/**
 * Claiming a gateway nobody has claimed yet.
 *
 * This is the one screen that cannot be checked against the stack every other journey
 * uses: the setup screen exists only while no account exists, and that stack has one
 * from its first minute. So these run against a second gateway of their own — an API
 * on a spare port over a throwaway database file, with a dev server pointed at it —
 * named by `E2E_SETUP_BASE_URL` and `E2E_SETUP_API_URL`. `README.md` of this folder
 * has the two commands that raise it.
 *
 * Without those variables the journeys are skipped rather than run against the shared
 * gateway, where every one of them would be redirected to the sign-in page and would
 * then pass by asserting nothing.
 *
 * Serial, and in this order, because what they act on is one-shot: claiming is what
 * the third one does, and it is the last thing that can ever be done on that gateway.
 * A fresh database file is what makes the file runnable a second time.
 */
const BASE_URL = process.env.E2E_SETUP_BASE_URL ?? '';
const SETUP_API_URL = process.env.E2E_SETUP_API_URL ?? '';

/** The administrator these journeys create. Only this gateway ever sees it. */
const FIRST_ADMIN = {
	displayName: 'Journey Administrator',
	username: 'journey-admin',
	password: 'a-long-enough-password',
};

/** The floor the screen states, and the API enforces. */
const TOO_SHORT = 'short';

test.describe.serial('first run', () => {
	test.skip(
		BASE_URL === '' || SETUP_API_URL === '',
		'needs a gateway with no account: set E2E_SETUP_BASE_URL and E2E_SETUP_API_URL',
	);

	test.use({ baseURL: BASE_URL || undefined });

	/** Whether that gateway says it has an account, asked of the gateway itself. */
	async function claimed (request: APIRequestContext): Promise<boolean> {
		const response = await request.get(`${SETUP_API_URL}/auth/setup`);
		expect(response.ok(), `the setup gateway did not answer: ${response.status()}`).toBeTruthy();
		const state = await response.json() as { required: boolean };
		return state.required === false;
	}

	test('every address leads to the setup screen, the sign-in page included', async ({ page, request }) => {
		expect(await claimed(request), 'that gateway already has an account').toBe(false);

		const failures = watchApi(page);

		// `/login` matters more than the others: it is a public page, so nothing but
		// the setup state itself stops it rendering a form that cannot sign anybody
		// in — on a gateway where there is nobody to sign in as.
		await page.goto('/login');
		await expect(page).toHaveURL(/\/setup/);
		await expect(page.locator(test0('setup-form'))).toBeVisible();
		await expect(page.locator(test0('login-submit'))).toHaveCount(0);

		// And a bookmark into the application, which is how somebody who set up a
		// second gateway usually arrives.
		await page.goto('/transfers');
		await expect(page).toHaveURL(/\/setup/);
		await expect(page.locator(test0('setup-form'))).toBeVisible();

		// The version is the one thing on this screen that says which gateway is
		// about to be configured, which matters when two are being unpacked at once.
		await expect(page.locator(test0('setup-version'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a password below the floor is refused here, not by the gateway', async ({ page, request }) => {
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes('/api/auth/setup')) {
				attempts.push(one.url());
			}
		});

		await page.goto('/setup');
		await page.locator(field0('setup-username')).fill(FIRST_ADMIN.username);
		await page.locator(field0('setup-password')).fill(TOO_SHORT);
		await page.locator(field0('setup-confirmation')).fill(TOO_SHORT);

		/*
		 * The field says something else afterwards, whatever it says.
		 *
		 * Compared against what it said a moment earlier rather than against a
		 * sentence: the message is Vuetify's rendering of our rule, in whichever
		 * language the browser asked for — this suite reads the interface in French
		 * on a French machine — and a journey that spelled it out would break on a
		 * reworded hint. What is being checked is that the submit was handled and
		 * answered on the spot, which is also what makes the absence of a request
		 * below mean something.
		 */
		const password = page.locator(test0('setup-password'));
		const saidBefore = (await password.textContent() ?? '').trim();

		await page.locator(test0('setup-submit')).click();

		await expect
			.poll(async () => (await password.textContent() ?? '').trim(), {
				message: 'the form said nothing about a password it cannot accept',
			})
			.not
			.toBe(saidBefore);

		await page.waitForLoadState('networkidle');
		expect(attempts, `the form posted a password it should have refused: ${attempts.join(', ')}`)
			.toHaveLength(0);
		await expect(page.locator(test0('setup-form'))).toBeVisible();
		expect(await claimed(request), 'an account was created from a refused form').toBe(false);
	});

	test('creating the first administrator lands inside, signed in', async ({ page }) => {
		const failures = watchApi(page);

		await page.goto('/setup');
		await page.locator(field0('setup-display-name')).fill(FIRST_ADMIN.displayName);
		await page.locator(field0('setup-username')).fill(FIRST_ADMIN.username);
		await page.locator(field0('setup-password')).fill(FIRST_ADMIN.password);
		await page.locator(field0('setup-confirmation')).fill(FIRST_ADMIN.password);
		await page.locator(test0('setup-submit')).click();

		// The route answers a session, and this is the whole point of it: being sent
		// back to the sign-in page to retype the credentials chosen ten seconds ago is
		// a step for nobody, and a setup that ends on `/login` reads as a failure.
		await expect(page.locator(test0('app-shell'))).toBeVisible({ timeout: 15_000 });
		await expect(page).not.toHaveURL(/\/(login|setup)/);
		await expect(page.locator(test0('page-title'))).toBeVisible();
		await expect(page.locator(test0('account-menu'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a second administrator cannot be created, from anywhere', async ({ page, request }) => {
		expect(await claimed(request), 'the gateway was not claimed by the journey above').toBe(true);

		// The open route is what makes the screen safe, so it is the route that has to
		// refuse — not the screen in front of it, which anybody can go around.
		const second = await request.post(`${SETUP_API_URL}/auth/setup`, {
			data: { username: 'second-admin', password: 'another-long-password' },
		});
		expect(second.status(), await second.text()).toBe(409);

		// And the screen is gone with it: a form whose submit can only fail is worse
		// than the page that will actually let somebody in.
		await page.goto('/setup');
		await expect(page).toHaveURL(/\/login/);
		await expect(page.locator(test0('login-submit'))).toBeVisible();
	});
});
