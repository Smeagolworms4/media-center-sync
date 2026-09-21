import { type APIRequestContext, expect, test } from '@playwright/test';
import { ADMIN, API_URL, COMPLETE, field0, test0, watchApi } from './helpers';

/**
 * The installation, tested by being done.
 *
 * This is the `install` project: it runs first, against the gateway under test while
 * that gateway is still empty, and the administrator it creates through the setup
 * screen is the one every later journey signs in as — `ADMIN`, from `E2E_ADMIN_USER`
 * and `E2E_ADMIN_PASSWORD`. One set of credentials for both, because an install
 * journey that created an account nobody used afterwards would prove the screen works
 * and nothing about the gateway the journeys then run against.
 *
 * Serial, and in this order, because what they act on is one-shot: claiming is what
 * the third one does, and it is the last thing that can ever be done on that gateway.
 *
 * On a gateway that is already claimed — the development stack `make e2e` runs
 * against — the three that need an empty one skip and say so, and the fourth still
 * runs: it is true of every claimed gateway. Under `E2E_COMPLETE` (`make e2e/ci`) a
 * claimed gateway is a failure instead: that run starts from a fresh database, and
 * finding an account there means something created one behind the journey's back.
 */

/** The floor the screen states, and the API enforces. */
const TOO_SHORT = 'short';

/** A display name for the first administrator, which only the setup screen asks for. */
const DISPLAY_NAME = 'Journey Administrator';

test.describe.serial('first run', () => {
	/** Whether the gateway says it has an account, asked of the gateway itself. */
	async function claimed (request: APIRequestContext): Promise<boolean> {
		const response = await request.get(`${API_URL}/auth/setup`);
		expect(response.ok(), `the gateway did not answer: ${response.status()}`).toBeTruthy();
		const state = await response.json() as { required: boolean };
		return state.required === false;
	}

	/**
	 * Skips the calling journey on a gateway somebody already installed — unless this
	 * run must be complete, where that is a failure with the reason.
	 */
	async function requireEmpty (request: APIRequestContext): Promise<void> {
		const already = await claimed(request);
		expect(
			COMPLETE && already,
			'E2E_COMPLETE is set, but the gateway under test already has an account: the run did not start '
			+ 'from a fresh database',
		).toBe(false);
		test.skip(already, 'this gateway is already installed; the install journey runs on an empty one (make e2e/ci)');
	}

	test.beforeAll(() => {
		// Checked before anything is typed: the setup route would refuse this password,
		// and the journey would then fail as "the form refused", pointing at the screen
		// rather than at the variable.
		expect(
			ADMIN.password.length,
			'E2E_ADMIN_PASSWORD must be at least 8 characters: it becomes the first administrator\'s password',
		).toBeGreaterThanOrEqual(8);
	});

	test('every address leads to the setup screen, the sign-in page included', async ({ page, request }) => {
		await requireEmpty(request);

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
		await requireEmpty(request);

		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes('/api/auth/setup')) {
				attempts.push(one.url());
			}
		});

		await page.goto('/setup');
		await page.locator(field0('setup-username')).fill(ADMIN.username);
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

	test('creating the first administrator lands inside, signed in', async ({ page, request }) => {
		await requireEmpty(request);

		const failures = watchApi(page);

		await page.goto('/setup');
		await page.locator(field0('setup-display-name')).fill(DISPLAY_NAME);
		await page.locator(field0('setup-username')).fill(ADMIN.username);
		await page.locator(field0('setup-password')).fill(ADMIN.password);
		await page.locator(field0('setup-confirmation')).fill(ADMIN.password);
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
		const second = await request.post(`${API_URL}/auth/setup`, {
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
