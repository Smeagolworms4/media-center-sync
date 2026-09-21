import { type APIRequestContext, expect, type Page } from '@playwright/test';

/**
 * The journeys address elements through `data-test` attributes, never through class
 * names or rendered text.
 *
 * A class is an implementation detail of Vuetify and changes with a minor version; a
 * label changes the day somebody improves the wording, or the moment the interface is
 * read in French. Either would break a journey for a reason that has nothing to do
 * with what it verifies. The attributes are part of the contract between the pages
 * and these tests — the list of the ones in use is in `README.md` of this folder.
 */
export const test0 = (name: string): string => `[data-test="${name}"]`;

/**
 * The control inside a marked field.
 *
 * A Vuetify input puts unknown attributes on its root, which is a `div` wrapping the
 * real `<input>`. Marking the field is the right thing for a page to do — one
 * attribute, on the component somebody actually wrote — but a journey that types into
 * it fails with "Element is not an <input>", and the failure names Playwright rather
 * than the mismatch. So the contract is: pages mark the field, journeys reach through
 * to the control.
 *
 * The hidden textarea is excluded on purpose: an auto-growing Vuetify textarea keeps
 * a second, `aria-hidden` copy of itself to measure the height against, and a
 * selector that takes both fails as a strict-mode violation naming two textareas
 * nobody wrote.
 */
export function field0 (name: string): string {
	return `${test0(name)} input, ${test0(name)} textarea:not([aria-hidden="true"])`;
}

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4200/api';

/**
 * The administrator every journey signs in as.
 *
 * On a workstation, the account `npm run seed` creates. Under `make e2e/ci`, the one
 * the install journey (`setup.spec.ts`) creates through the setup screen — which is
 * why it is read from the environment rather than written here: both have to be the
 * same account, and the seed's `admin` password is too short for the setup screen to
 * accept.
 */
export const ADMIN = {
	username: process.env.E2E_ADMIN_USER ?? 'admin',
	password: process.env.E2E_ADMIN_PASSWORD ?? 'admin',
};

/**
 * Whether this run must be complete: `make e2e/ci` sets `E2E_COMPLETE=1`.
 *
 * A journey that finds its environment missing skips and says why, which is right on
 * a workstation and wrong on the run that is supposed to prove everything: there, a
 * skip for want of a lab or a writable directory reads as green and proves nothing.
 * Under this flag the install and data phases fail instead, naming what is missing,
 * before any journey gets the chance to skip.
 */
export const COMPLETE = process.env.E2E_COMPLETE === '1';

/**
 * Sign in through the interface rather than by injecting a token.
 *
 * Seeding the session directly would be faster and would skip the only part of the
 * flow that has ever broken: the provider list, the form, and the redirect that
 * follows. A journey that starts already signed in cannot tell you that nobody can
 * sign in.
 */
export async function signIn (page: Page, user = ADMIN): Promise<void> {
	await page.goto('/login');
	await page.locator(field0('login-username')).fill(user.username);
	await page.locator(field0('login-password')).fill(user.password);
	await page.locator(test0('login-submit')).click();
	await expect(page.locator(test0('app-shell'))).toBeVisible({ timeout: 15_000 });
}

/** A bearer token for the fixtures that set up state through the API. */
export async function apiToken (request: APIRequestContext, user = ADMIN): Promise<string> {
	const response = await request.post(`${API_URL}/auth/login`, {
		data: { provider: 'internal', username: user.username, password: user.password },
	});
	expect(response.ok(), `sign-in failed: ${response.status()}`).toBeTruthy();
	const body = await response.json();
	return body.accessToken as string;
}

/**
 * Every API answer a page was not entitled to get, collected while it renders.
 *
 * The pattern `navigation.spec.ts` established, offered here because every journey
 * needs it: a screen that renders its heading and its empty state while the call
 * underneath answers 500 passes any assertion made about what is on screen. Only
 * watching the network tells "there is nothing" apart from "the query failed".
 *
 * Deliberately strict about what it collects — 5xx and requests that never completed
 * — because those are never acceptable and never ambiguous, unlike a 404, which some
 * screens ask for on purpose.
 */
export function watchApi (page: Page): string[] {
	const failures: string[] = [];

	page.on('response', response => {
		if (response.url().includes('/api/') && response.status() >= 500) {
			failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
		}
	});

	page.on('requestfailed', request => {
		// The progress stream is closed by the browser on navigation, which is not a
		// failure of anything; only its own journey has anything to say about it.
		if (!request.url().includes('/api/') || request.url().includes('/api/events')) {
			return;
		}
		// Neither is a request the browser itself cancelled. Leaving a page while its
		// posters are still arriving aborts them by design, and counting that as a
		// gateway failure makes every journey that navigates twice fail for the
		// gateway's good behaviour.
		const reason = request.failure()?.errorText ?? '';
		if (reason.includes('ERR_ABORTED')) {
			return;
		}
		failures.push(`failed ${request.method()} ${request.url()} — ${reason}`);
	});

	return failures;
}
