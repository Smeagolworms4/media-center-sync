import { randomBytes } from 'node:crypto';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { authorized, type FakeJellyfin, journeyTag, startFakeJellyfin } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';
import { type FixtureLibrary, librariesOfService, registerService, removeServices } from './lab';

/**
 * One library's share policy, field by field.
 *
 * `shares.spec.ts` proves the list agrees with the API and that a rule can be set and
 * released. This file is about the form itself: what it says while nothing has been
 * decided, what each box means when it is left empty, and what the gateway ends up
 * holding once somebody has decided. A blank control with no explanation reads as
 * broken, and on this form a blank means something different in each box — "follow
 * the default", "no exception", "no cap" — so each one has to say which.
 *
 * Fixtures: a library of the journey's own, from a server `./fake-jellyfin.ts` raises
 * — there is no route that creates a library, and asserting against somebody's real
 * shelves would pass on their gateway and fail on a runner — plus two peers linked by
 * fingerprint, which never answer and are only there to be named in the rule. All of
 * it is removed in a `finally`.
 */
interface Policy {
	libraryId: string;
	visibility: string;
	overridden: boolean;
	allowedPeerIds: string[];
	deniedPeerIds: string[];
	rateLimit: number;
}

interface Peer {
	id: string;
	name: string;
}

interface Fixture {
	server: FakeJellyfin;
	library: FixtureLibrary;
	tag: string;
}

/** Named so a leftover is recognisable, and so the cleanup can find it by name. */
const SERVICE_NAME = 'Journey share fixture';

/** The three rules, in the order the API defines them and the select draws them. */
const VISIBILITIES = ['private', 'friends', 'friends_of_friends'];

async function policyOf (request: APIRequestContext, libraryId: string): Promise<Policy> {
	const response = await request.get(`${API_URL}/shares`, { headers: await authorized(request) });
	expect(response.ok(), `shares failed: ${response.status()}`).toBeTruthy();
	const held = (await response.json() as Policy[]).find(one => one.libraryId === libraryId);
	expect(held, `the API listed no policy at all for ${libraryId}`).toBeDefined();
	return held!;
}

async function createFixture (request: APIRequestContext): Promise<Fixture> {
	const tag = journeyTag();
	const server = await startFakeJellyfin({
		serverName: SERVICE_NAME,
		libraries: [{
			externalId: `shelf-${tag}`,
			name: `Journey shelf ${tag}`,
			collectionType: 'movies',
			locations: [`/data/shelf-${tag}`],
		}],
		items: [],
	});

	try {
		const service = await registerService(request, {
			name: SERVICE_NAME,
			type: 'jellyfin',
			server: { url: server.baseUrl, token: '' },
		});
		const [library] = await librariesOfService(request, service.id);
		expect(library, 'the gateway adopted no library from the fixture').toBeDefined();

		return { server, library, tag };
	} catch (error) {
		await server.close();
		throw error;
	}
}

async function dropFixture (request: APIRequestContext, fixture: Fixture | null): Promise<void> {
	if (fixture) {
		await request.delete(`${API_URL}/shares/${fixture.library.id}`, { headers: await authorized(request) });
	}
	await removeServices(request, SERVICE_NAME);
	await fixture?.server.close();
}

/** A peer that exists only to be named in a rule: a fingerprint nobody holds. */
async function linkPeer (request: APIRequestContext, name: string): Promise<Peer> {
	const response = await request.post(`${API_URL}/peers`, {
		headers: await authorized(request),
		data: { fingerprint: randomBytes(32).toString('hex'), name },
	});
	expect(response.ok(), `peer failed: ${response.status()} ${await response.text()}`).toBeTruthy();
	return await response.json() as Peer;
}

async function forgetPeers (request: APIRequestContext, peers: Peer[]): Promise<void> {
	const headers = await authorized(request);
	for (const peer of peers) {
		await request.delete(`${API_URL}/peers/${peer.id}`, { headers });
	}
}

/**
 * What a field says about itself under it — its hint, or the refusal that replaced
 * it — read through the accessibility tree rather than through a class.
 *
 * The control names the element carrying that sentence in `aria-describedby`, which
 * is what a screen reader reads too: a hint a screen reader cannot find is one this
 * journey should not be able to find either. The field is given rather than the
 * control because a select keeps a hidden input beside the one people use, and only
 * the one people use is described.
 */
async function describedBy (page: Page, field: Locator): Promise<string> {
	const ids = (await field.locator('[aria-describedby]').first().getAttribute('aria-describedby')) ?? '';
	const texts = await Promise.all(ids.split(/\s+/).filter(Boolean)
		.map(async id => (await page.locator(`[id="${id}"]`).textContent()) ?? ''));
	return texts.join(' ').trim();
}

/**
 * Picks one option of one select, from the menu that select opened.
 *
 * Found through the control's `aria-controls` rather than among every option on the
 * page: the allowed and the denied lists name the same peers, and a menu that is
 * still fading out when the next one opens leaves both on screen for a moment — which
 * is when a page-wide match takes the wrong one.
 */
async function choose (page: Page, field: Locator, option: string): Promise<void> {
	await field.click();
	const menu = await field.locator('[aria-controls]').first().getAttribute('aria-controls');
	expect(menu, 'the select names no menu').toBeTruthy();
	await page.locator(`[id="${menu}"]`).getByRole('option').filter({ hasText: option }).click();
	await page.keyboard.press('Escape');
}

async function openPanel (page: Page, libraryId: string): Promise<Locator> {
	await page.goto('/settings/shares');
	const panel = page.locator(`${test0('share-library')}[data-library="${libraryId}"]`);
	await panel.locator(test0('share-library-open')).click();
	await expect(panel.locator(test0('share-policy'))).toBeVisible();
	return panel;
}

test.describe('share policy form', () => {
	test('a library nobody has decided about says the default applies, and shows only what that rule needs', async ({ page, request }) => {
		const failures = watchApi(page);
		let fixture: Fixture | null = null;

		try {
			fixture = await createFixture(request);
			const policy = await policyOf(request, fixture.library.id);
			expect(policy.overridden, 'a library registered a moment ago already has a rule').toBe(false);

			await signIn(page);
			const panel = await openPanel(page, fixture.library.id);

			/*
			 * Nobody chose this, and the form says so.
			 *
			 * "Nobody" chosen by somebody and "nobody" because the default says so are
			 * opposite states, and a form showing the same select for both leaves people
			 * guessing which they are looking at — and whether changing the default will
			 * move this library.
			 */
			const note = panel.locator(test0('share-origin-note'));
			await expect(note).toHaveAttribute('data-origin', 'default');
			await expect(note).not.toHaveText('');
			// Nothing to drop: there is no rule of this library's own to hand back.
			await expect(panel.locator(test0('share-remove'))).toHaveCount(0);

			// The rule in force is explained under the select, in a sentence: the three
			// differ by who is included, and that does not fit in a label.
			expect(await describedBy(page, panel.locator(test0('share-visibility')))).not.toBe('');

			// The exceptions and the cap only mean something once something is shared;
			// on a private library they would be three boxes about nothing.
			const shared = policy.visibility !== 'private';
			for (const box of ['share-allowed', 'share-denied', 'share-rate-limit']) {
				await expect(panel.locator(test0(box))).toHaveCount(shared ? 1 : 0);
			}
		} finally {
			await dropFixture(request, fixture);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('sharing it, bent for one peer either way and with no cap, is exactly what the gateway then holds', async ({ page, request }) => {
		const failures = watchApi(page);
		let fixture: Fixture | null = null;
		const peers: Peer[] = [];

		try {
			fixture = await createFixture(request);
			peers.push(
				await linkPeer(request, `Journey allowed ${fixture.tag}`),
				await linkPeer(request, `Journey denied ${fixture.tag}`),
			);
			const [allowed, denied] = peers;

			// A shared rule other than the one in force, so the change is this journey's.
			const current = (await policyOf(request, fixture.library.id)).visibility;
			const chosen = current === 'friends' ? 2 : 1;

			await signIn(page);
			const panel = await openPanel(page, fixture.library.id);

			const visibility = panel.locator(test0('share-visibility'));
			const explainedBefore = await describedBy(page, visibility);

			await panel.locator(test0('share-visibility')).click();
			await page.getByRole('option').nth(chosen).click();

			// The sentence under the select follows the rule: it is the part that says
			// who is now included, which the rule's name alone does not.
			await expect.poll(() => describedBy(page, visibility)).not.toBe(explainedBefore);

			/*
			 * Each box says what it means while it is empty.
			 *
			 * Empty means a different thing in each — no peer let in regardless, no peer
			 * kept out regardless, no cap — and a blank box with nothing under it reads
			 * as a form that failed to load its value.
			 */
			for (const box of ['share-allowed', 'share-denied', 'share-rate-limit']) {
				await expect(panel.locator(test0(box))).toBeVisible();
				expect(await describedBy(page, panel.locator(test0(box))), `${box} explains nothing`).not.toBe('');
			}
			await expect(panel.locator(field0('share-rate-limit'))).toHaveValue(/^0?$/);

			await choose(page, panel.locator(test0('share-allowed')), allowed.name);
			await choose(page, panel.locator(test0('share-denied')), denied.name);

			const saved = page.waitForResponse(one => one.request().method() === 'PUT' && one.url().includes('/shares/'));
			await panel.locator(test0('share-save')).click();
			expect((await saved).ok(), 'the rule was refused').toBe(true);

			// What the gateway holds, rather than what the form still shows.
			const held = await policyOf(request, fixture.library.id);
			expect(held.overridden).toBe(true);
			expect(held.visibility).toBe(VISIBILITIES[chosen]);
			expect(held.allowedPeerIds).toEqual([allowed.id]);
			expect(held.deniedPeerIds).toEqual([denied.id]);
			// Left empty, the cap is no cap — not a cap of zero bytes a second.
			expect(held.rateLimit).toBe(0);

			// Decided here now, and the note says that the default no longer moves it.
			const note = panel.locator(test0('share-origin-note'));
			await expect(note).toHaveAttribute('data-origin', 'set');
			await expect(panel.locator(test0('share-remove'))).toBeVisible();

			// Handing it back is a deletion, which returns it to the default rather than
			// making it private: a visibility left behind on a row nobody sees is how a
			// library stays shared.
			await panel.locator(test0('share-remove')).click();
			await expect(note).toHaveAttribute('data-origin', 'default');
			expect((await policyOf(request, fixture.library.id)).overridden).toBe(false);
		} finally {
			await dropFixture(request, fixture);
			await forgetPeers(request, peers);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a cap that is not a size is refused under the cap, and never sent', async ({ page, request }) => {
		const failures = watchApi(page);
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PUT' && one.url().includes('/shares/')) {
				attempts.push(one.url());
			}
		});
		let fixture: Fixture | null = null;

		try {
			fixture = await createFixture(request);

			await signIn(page);
			const panel = await openPanel(page, fixture.library.id);
			await panel.locator(test0('share-visibility')).click();
			await page.getByRole('option').nth(1).click();

			/*
			 * What the box says before, and what it says once it is refused.
			 *
			 * Compared against itself rather than against a sentence: the wording is in
			 * whichever language the browser asked for. What matters is that the hint
			 * explaining an empty box gives way to a sentence about the value typed —
			 * under the box, where somebody is looking — and that nothing leaves.
			 */
			const rate = panel.locator(test0('share-rate-limit'));
			const saidBefore = await describedBy(page, rate);

			await panel.locator(field0('share-rate-limit')).fill('as fast as it goes');
			await panel.locator(test0('share-save')).click();

			await expect
				.poll(() => describedBy(page, rate), { message: 'the form said nothing about a cap it cannot send' })
				.not
				.toBe(saidBefore);

			await page.waitForLoadState('networkidle');
			expect(attempts, `a policy was sent anyway: ${attempts.join(', ')}`).toHaveLength(0);
			expect((await policyOf(request, fixture.library.id)).overridden).toBe(false);
		} finally {
			await dropFixture(request, fixture);
		}

		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
