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
 */
export const field0 = (name: string): string => `${test0(name)} input, ${test0(name)} textarea`;

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4200/api';

/** The account `npm run seed` creates. Overridable, because a runner may seed another. */
export const ADMIN = {
	username: process.env.E2E_ADMIN_USER ?? 'admin',
	password: process.env.E2E_ADMIN_PASSWORD ?? 'admin',
};

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
