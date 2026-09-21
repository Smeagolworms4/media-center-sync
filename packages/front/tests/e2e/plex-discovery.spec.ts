import { type APIRequestContext, expect, test } from '@playwright/test';
import { authorized, journeyTag } from './fake-jellyfin';
import { FAKE_PLEX_TV_PORT, FAKE_PLEX_TV_URL, type FakePlexServer, startFakePlexTv } from './fake-plex-tv';
import { API_URL, COMPLETE, signIn, test0, watchApi } from './helpers';

/**
 * Adding Plex servers without knowing their address: sign in to plex.tv, tick, done.
 *
 * The whole path in a real browser against the running gateway — the add dialog, the
 * tab plex.tv opens in, the wait, the list of servers the account reaches, two of them
 * ticked and registered — with `fake-plex-tv.ts` standing in for plex.tv. The real
 * plex.tv is never called: see that file for why, and for how the gateway is pointed
 * at the fake.
 *
 * It needs the gateway to have been started with `MCS_PLEX_TV_URL` naming this fake,
 * which only the CI stack does (`make e2e/ci`). Against a development gateway that talks
 * to the real plex.tv it skips, and says why; under `E2E_COMPLETE` it fails instead.
 */
const NEEDS_FAKE = 'needs a gateway started with MCS_PLEX_TV_URL pointing at this run '
  + '(E2E_FAKE_PLEX_TV_PORT and E2E_FAKE_PLEX_TV_URL): `make e2e/ci` sets both';

interface Registered {
	id: string;
	name: string;
	serverIdentifier: string | null;
	connectionRoute: string | null;
	filesMounted: boolean;
	shared: boolean;
	status: string;
}

async function registered (request: APIRequestContext, identifiers: string[]): Promise<Registered[]> {
	const response = await request.get(`${API_URL}/services`, { headers: await authorized(request) });
	expect(response.ok(), `services failed: ${response.status()}`).toBeTruthy();
	return (await response.json() as Registered[])
		.filter(one => one.serverIdentifier !== null && identifiers.includes(one.serverIdentifier));
}

test.describe('adding Plex servers through plex.tv', () => {
	test('sign in on plex.tv, see the servers, add two, find them registered', async ({ page, request }) => {
		test.setTimeout(120_000);
		expect(!COMPLETE || (FAKE_PLEX_TV_PORT > 0 && FAKE_PLEX_TV_URL !== ''), NEEDS_FAKE).toBeTruthy();
		test.skip(FAKE_PLEX_TV_PORT === 0 || FAKE_PLEX_TV_URL === '', NEEDS_FAKE);

		const failures = watchApi(page);
		const tag = journeyTag();
		const servers: FakePlexServer[] = [
			{ identifier: `attic-${tag}`, name: `Journey Attic ${tag}`, owned: true, route: 'local' },
			{ identifier: `asleep-${tag}`, name: `Journey Asleep ${tag}`, owned: true, route: 'unreachable' },
			{ identifier: `home-${tag}`, name: `Journey Home ${tag}`, owned: false, ownerName: 'bob', route: 'remote' },
			{ identifier: `basement-${tag}`, name: `Journey Basement ${tag}`, owned: false, ownerName: 'carol', route: 'relay' },
		];
		const wanted = [servers[0].identifier, servers[2].identifier];
		const plexTv = await startFakePlexTv(servers);

		try {
			await signIn(page);
			await page.goto('/services');
			await page.locator(test0('service-add')).click();
			await page.locator(test0('service-add-type-plex')).click();

			// Plex leads with signing in, and says where the password goes.
			const start = page.locator(test0('directory-start'));
			await expect(start).toBeVisible();

			// plex.tv opens in a tab of its own, and the dialog says what it waits for.
			const popupOpened = page.waitForEvent('popup');
			await start.click();
			const popup = await popupOpened;
			await expect(page.locator(test0('directory-waiting'))).toBeVisible();
			await expect(page.locator(test0('directory-waiting'))).toContainText('plex.tv');

			// Opened blank inside the click and pointed at plex.tv once the PIN existed,
			// so its first address is `about:blank`: wait for the one that matters.
			await popup.waitForURL(url => url.href.startsWith(`${FAKE_PLEX_TV_URL}/auth#?`));
			expect(new URLSearchParams(popup.url().split('#?', 2)[1]).get('clientID')).toMatch(/^mcs-/);
			await popup.locator(test0('fake-plex-approve')).click();
			await expect(popup.locator(test0('fake-plex-approved'))).toBeVisible();
			await popup.close();

			// Back in the dialog, which noticed on its own: the servers, grouped by whose.
			const list = page.locator(test0('discovered-servers'));
			await expect(list).toBeVisible({ timeout: 30_000 });
			const groups = page.locator(test0('discovered-group'));
			await expect(groups).toHaveCount(3);
			await expect(groups.nth(0)).toContainText(servers[0].name);
			await expect(groups.nth(1)).toContainText('bob');
			await expect(groups.nth(2)).toContainText('carol');

			const row = (server: FakePlexServer) =>
				page.locator(`${test0('discovered-server')}[data-identifier="${server.identifier}"]`);
			await expect(row(servers[0]).locator(test0('connection-route'))).toHaveAttribute('data-route', 'local');
			await expect(row(servers[2]).locator(test0('connection-route'))).toHaveAttribute('data-route', 'remote');
			// The relay is said in words, and a server nothing answered for cannot be ticked.
			await expect(row(servers[3]).locator(test0('connection-route'))).toHaveAttribute('data-route', 'relay');
			await expect(row(servers[3]).locator(test0('discovered-relay-note'))).toBeVisible();
			await expect(row(servers[1]).locator(test0('connection-route'))).toHaveAttribute('data-route', 'unreachable');
			await expect(page.locator(`${test0(`discovered-select-${servers[1].identifier}`)} input`)).toBeDisabled();

			// Two at once: our own, and a friend's.
			await page.locator(`${test0(`discovered-select-${servers[0].identifier}`)} input`).check();
			await page.locator(`${test0(`discovered-select-${servers[2].identifier}`)} input`).check();
			await page.locator(test0('directory-add')).click();

			// The dialog closes on success, and both are on the services screen.
			await expect(page.locator(test0('directory-sign-in'))).toBeHidden({ timeout: 30_000 });
			const rows = page.locator(test0('service-row'));
			await expect(rows.filter({ hasText: servers[0].name })).toBeVisible();
			await expect(rows.filter({ hasText: `${servers[2].name} (bob)` })).toBeVisible();

			const saved = await registered(request, wanted);
			expect(saved.map(one => one.serverIdentifier).toSorted()).toEqual(wanted.toSorted());
			const own = saved.find(one => one.serverIdentifier === servers[0].identifier)!;
			const friends = saved.find(one => one.serverIdentifier === servers[2].identifier)!;
			expect(own).toMatchObject({ status: 'online', connectionRoute: 'local', filesMounted: false, shared: true });
			// Somebody else's: not mounted, and not passed on to our own peers.
			expect(friends).toMatchObject({ status: 'online', connectionRoute: 'remote', filesMounted: false, shared: false });
			// And no response ever carried a token.
			expect(JSON.stringify(saved)).not.toContain('token-');

			expect(plexTv.calls).toContain('POST /api/v2/pins');
			expect(plexTv.calls).toContain('GET /api/v2/resources');
			expect(failures).toEqual([]);
		} finally {
			const headers = await authorized(request);
			for (const service of await registered(request, servers.map(one => one.identifier))) {
				await request.delete(`${API_URL}/services/${service.id}`, { headers });
			}
			await plexTv.close();
		}
	});
});
