import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { authorized } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';
import {
	LAB_JELLYFIN,
	LAB_JELLYFIN_ACCOUNT,
	NEEDS_JELLYFIN_ACCOUNT,
	registerService,
	removeServices,
} from './lab';

/**
 * The accounts screen, and the one rule that protects it from itself.
 *
 * What this page can do is narrower than it looks, and the journeys below are shaped
 * by that rather than by what an administration screen usually offers. This gateway
 * has no route that creates an account and no screen that changes a password: an
 * account exists because somebody claimed the gateway on the setup screen, or because
 * they signed in through a media service and were mirrored. So an account is created
 * here the only way one ever is — by somebody signing in through a Jellyfin — and
 * nothing retypes a password, because a mirrored account's password lives on the
 * server that checks it and the page says so instead.
 *
 * The part that can go badly wrong is the last administrator, who cannot be demoted
 * and cannot be deleted: the account would stop being able to do anything, and the
 * only way back in is a command line on the host. The API refuses both with
 * `error.user.last_admin`; these journeys prove the refusal reaches the screen and
 * says which rule it is, rather than the generic sentence that used to stand there.
 *
 * Those two act on the one administrator every other journey signs in as, and they
 * are safe exactly as long as the rule holds. It is pinned by the functional suite
 * (`packages/api/test/user.spec.ts`, "The last administrator"), which runs before any
 * journey does; if it ever stops holding, this is where it is found, and the run after
 * this file fails loudly rather than a gateway quietly losing its administrator.
 *
 * Fixtures: the seed's administrator for the refusals. The account that is created,
 * promoted and removed is a Jellyfin user of the lab (`./lab.ts`), mirrored for the
 * length of one journey; without one named, that journey skips and says why.
 */
interface User {
	id: string;
	username: string;
	displayName: string | null;
	role: string;
	provider: string;
}

async function usersOf (request: APIRequestContext): Promise<User[]> {
	const response = await request.get(`${API_URL}/users`, { headers: await authorized(request) });
	expect(response.ok(), `users failed: ${response.status()}`).toBeTruthy();
	return await response.json() as User[];
}

/**
 * One account's row, by its identifier.
 *
 * Never by name: a mirrored account whose name is taken is suffixed — `lab`, then
 * `lab-1` — so a match on the text `lab` finds both rows, and the click that follows
 * lands on whichever came first.
 */
function rowOf (page: Page, user: Pick<User, 'id'>): Locator {
	return page.locator(`${test0('user-row')}[data-user="${user.id}"]`);
}

/** The account these journeys act on: the only administrator, when there is only one. */
async function lastAdmin (request: APIRequestContext): Promise<User | null> {
	const admins = (await usersOf(request)).filter(one => one.role === 'admin');

	return admins.length === 1 ? admins[0] : null;
}

test.describe('users', () => {
	test('every account the gateway holds is on the screen, with where it came from', async ({ page, request }) => {
		const users = await usersOf(request);

		const failures = watchApi(page);
		await signIn(page);
		await page.locator(test0('nav-settings-users')).click();

		const rows = page.locator(test0('user-row'));
		await expect(rows).toHaveCount(users.length);

		for (const user of users) {
			const row = rowOf(page, user);
			await expect(row).toHaveCount(1);

			/*
			 * An account mirrored from a media service says so, and an internal one
			 * does not.
			 *
			 * This is the difference between a username that can be changed somewhere
			 * and one that lives on a server this gateway does not own — and the note
			 * is what stops the absence of an edit control reading as a missing
			 * feature. Read off the provider the API reports, so the claim is about
			 * this account rather than about whatever this stack happens to hold.
			 */
			await expect(row.locator(test0('user-mirrored')))
				.toHaveCount(user.provider === 'internal' ? 0 : 1);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('the last administrator cannot be demoted, and the page says which rule refused', async ({ page, request }) => {
		const admin = await lastAdmin(request);
		test.skip(
			admin === null,
			'this gateway has no single administrator, so the rule being checked does not apply',
		);

		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/settings/users');

		const row = rowOf(page, admin!);
		await expect(row).toHaveCount(1);

		/*
		 * The role is chosen by position rather than by its wording: the three roles
		 * are an enum the API owns and the labels are sentences that get reworded and
		 * translated. The first is `admin` — the one already held — so the second is
		 * the first that is a demotion.
		 */
		await row.locator(test0('user-role')).click();
		await page.getByRole('option').nth(1).click();

		// Visible where the action was, and still there after the toast has gone: this
		// is the refusal that used to be `error.general`, a sentence saying something
		// went wrong and nothing about what — on the one page where what to do about it
		// is a sentence long.
		const refusal = page.locator(test0('user-error'));
		await expect(refusal).toBeVisible();
		await expect(refusal).toHaveAttribute('data-key', 'error.user.last_admin');
		// The API answers a key and the interface decides the wording; a raw key on
		// screen means the catalogue is missing it, which nothing but a browser catches.
		await expect(refusal).not.toContainText('error.user');

		// And the gateway is unchanged — the screen is not merely apologising for
		// something it went ahead and did.
		const after = (await usersOf(request)).find(one => one.id === admin!.id);
		expect(after?.role, 'the administrator was demoted anyway').toBe('admin');

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('the last administrator cannot be removed, and the refusal outlives the dialog', async ({ page, request }) => {
		const admin = await lastAdmin(request);
		test.skip(
			admin === null,
			'this gateway has no single administrator, so the rule being checked does not apply',
		);

		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/settings/users');

		const row = rowOf(page, admin!);
		await row.locator(test0('user-remove')).click();
		await page.locator(test0('confirm-accept')).click();

		// The dialog has to be out of the way, or the sentence explaining the refusal
		// is written behind the thing covering it.
		await expect(page.locator(test0('confirm-accept'))).toBeHidden();

		const refusal = page.locator(test0('user-error'));
		await expect(refusal).toBeVisible();
		await expect(refusal).toHaveAttribute('data-key', 'error.user.last_admin');
		await expect(refusal).not.toContainText('error.user');

		// The row is still there, and so is the account behind it.
		await expect(rowOf(page, admin!)).toHaveCount(1);
		expect(
			(await usersOf(request)).some(one => one.id === admin!.id),
			'the administrator was deleted anyway',
		).toBe(true);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});

/**
 * An account created the only way one ever is: by somebody signing in through a
 * media server this gateway trusts for it.
 *
 * A describe of its own so its cleanup can be an `afterEach`. The body promotes the
 * account it creates to administrator, and a `finally` inside the body does not run
 * with a usable request context once the test has timed out — which is how an earlier
 * version of this journey left two administrators nobody chose on the gateway it ran
 * against. A hook still does.
 */
test.describe('users, signed in through a media server', () => {
	const name = 'Journey sign-in provider';

	test.beforeEach(async ({ request }) => {
		// Whatever an interrupted run left — its service and the account it mirrored.
		await removeServices(request, name);
	});

	test.afterEach(async ({ request }) => {
		await removeServices(request, name);
	});

	test('is an account here, whose role takes effect and who can be removed', async ({ browser, page, request }) => {
		test.skip(
			LAB_JELLYFIN.url === '' || LAB_JELLYFIN.token === ''
			|| LAB_JELLYFIN_ACCOUNT.username === '' || LAB_JELLYFIN_ACCOUNT.password === '',
			NEEDS_JELLYFIN_ACCOUNT,
		);

		// Three sign-ins and a change of role, each waiting on a real Jellyfin.
		test.setTimeout(90_000);

		const failures = watchApi(page);
		const baseURL = test.info().project.use.baseURL;
		let provider = '';

		/** The mirrored account, found by where it came from rather than by its name. */
		const mirrored = async (): Promise<User | undefined> =>
			(await usersOf(request)).find(one => one.provider === provider);

		/**
		 * Signs the Jellyfin user in, in a browser of their own, and hands back what
		 * their navigation offers.
		 *
		 * A fresh context every time rather than one kept between sign-ins: a context
		 * that already holds their session is sent away from the sign-in page, and the
		 * provider button it waits for never appears. Fresh is also what makes the
		 * second sign-in carry the new role rather than the token issued before it.
		 */
		const signInThroughJellyfin = async (): Promise<{ page: Page; close: () => Promise<void> }> => {
			const context = await browser.newContext({ baseURL });
			const theirs = await context.newPage();
			await theirs.goto('/login');
			await theirs.locator(test0(`login-provider-${provider}`)).click();
			await theirs.locator(field0('login-username')).fill(LAB_JELLYFIN_ACCOUNT.username);
			await theirs.locator(field0('login-password')).fill(LAB_JELLYFIN_ACCOUNT.password);
			await theirs.locator(test0('login-submit')).click();
			await expect(theirs.locator(test0('app-shell'))).toBeVisible({ timeout: 15_000 });
			return { page: theirs, close: () => context.close() };
		};

		const service = await registerService(request, {
			name,
			type: 'jellyfin',
			server: LAB_JELLYFIN,
			authProvider: true,
		});
		provider = `service:${service.id}`;

		/*
		 * Created by signing in, which is the only way an account is ever created.
		 *
		 * The role it gets is the least this gateway grants: being an administrator of a
		 * Jellyfin says nothing about who may reconfigure this gateway, so the accounts
		 * page is not even in their navigation.
		 */
		const first = await signInThroughJellyfin();
		await expect(first.page.locator(test0('nav-settings-users'))).toHaveCount(0);
		await first.close();

		const created = await mirrored();
		expect(created, 'signing in created no account').toBeDefined();
		expect(created!.role).not.toBe('admin');

		await signIn(page);
		await page.goto('/settings/users');

		const row = rowOf(page, created!);
		await expect(row).toHaveCount(1);
		// Its username and password live on the Jellyfin, and the row says so rather than
		// offering fields that would change nothing at the far end.
		await expect(row.locator(test0('user-mirrored'))).toBeVisible();

		// Promoted, by position: `admin` is the first of the roles the API defines.
		await row.locator(test0('user-role')).click();
		await page.getByRole('option').filter({ visible: true }).first().click();
		await expect.poll(async () => (await mirrored())?.role).toBe('admin');
		await expect(page.locator(test0('user-error'))).toHaveCount(0);

		// And it takes effect: the next time they sign in, the page they could not see a
		// moment ago is theirs.
		const second = await signInThroughJellyfin();
		await expect(second.page.locator(test0('nav-settings-users'))).toBeVisible();
		await second.close();

		// Removed from the same row. There are two administrators now, so the rule
		// protecting the last one has nothing to say, and nothing is refused.
		await row.locator(test0('user-remove')).click();
		await page.locator(test0('confirm-accept')).click();
		await expect(row).toHaveCount(0);
		await expect(page.locator(test0('user-error'))).toHaveCount(0);
		expect(await mirrored(), 'the row went but the account stayed').toBeUndefined();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
