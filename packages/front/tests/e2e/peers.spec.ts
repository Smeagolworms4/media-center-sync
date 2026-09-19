import { type APIRequestContext, expect, test } from '@playwright/test';
import { API_URL, apiToken, field0, signIn, test0, watchApi } from './helpers';

/**
 * The gateways this one is linked to, and what somebody needs to link to it.
 *
 * This page was the one that taught the suite to watch the network: it once rendered
 * its title and an empty state saying there were no peers while `GET /api/peers`
 * answered 500 on every call, and nothing anywhere distinguished "none" from "the
 * query failed". So every journey here reads the page against what the API holds, and
 * fails on a 5xx even when the screen looks right.
 *
 * The identity is checked as carefully as the list. A fingerprint or a node
 * identifier that is not this gateway's is not a cosmetic defect: it is what somebody
 * pastes into a friend's gateway, and a wrong one fails hours later as a link that
 * never forms.
 */
interface Peer {
	id: string;
	name: string;
	status: string;
	direction: string | null;
}

interface Identity {
	nodeId: string | null;
	fingerprint: string;
}

const FINGERPRINT = 'aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999';

async function authorized (request: APIRequestContext): Promise<{ Authorization: string }> {
	return { Authorization: `Bearer ${await apiToken(request)}` };
}

async function peersOf (request: APIRequestContext): Promise<Peer[]> {
	const response = await request.get(`${API_URL}/peers`, { headers: await authorized(request) });
	expect(response.ok(), `peers failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Peer[];
}

async function identityOf (request: APIRequestContext): Promise<Identity> {
	const response = await request.get(`${API_URL}/peers/identity`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `identity failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Identity;
}

async function forget (request: APIRequestContext, name: string): Promise<void> {
	const headers = await authorized(request);
	for (const peer of await peersOf(request)) {
		if (peer.name === name) {
			await request.delete(`${API_URL}/peers/${peer.id}`, { headers });
		}
	}
}

test.describe('peers', () => {
	test('the page shows the peers the gateway holds, and its own identity with them', async ({ page, request }) => {
		const peers = await peersOf(request);
		const identity = await identityOf(request);

		const failures = watchApi(page);
		await signIn(page);
		await page.locator(test0('nav-peers')).click();

		// Ours first: the node identifier is what somebody is asked for when a
		// catalogue goes round in circles, and it is generated once — deliberately not
		// the fingerprint, which a key rotation would change.
		if (identity.nodeId) {
			await expect(page.locator(test0('peer-node-id'))).toContainText(identity.nodeId);
		}
		// Whether direct connections are possible, said next to the identity rather
		// than hidden in a diagnostic: a relayed gateway works and shares somebody
		// else's bandwidth, which is better learned here than mid-transfer.
		await expect(page.locator(test0('peer-reachability'))).toBeVisible();

		await expect(page.locator(test0('peer-row'))).toHaveCount(peers.length);
		// A gateway with no peers says so rather than showing an empty frame, which is
		// what a page whose query failed looks like.
		await expect(page.locator(test0('empty-state'))).toHaveCount(peers.length === 0 ? 1 : 0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a gateway is linked by its fingerprint, and the row says who is waiting on whom', async ({ page, request }) => {
		const name = 'Journey peer';
		const failures = watchApi(page);

		try {
			await signIn(page);
			await page.goto('/peers');

			await page.locator(test0('peer-invite')).click();
			// The three ways two gateways are linked are one conversation, so they are
			// tabs rather than screens: hand out a code, use one, or paste what a link
			// actually is — a fingerprint, which expires never and reveals nothing.
			await expect(page.locator(test0('invite-tab-create'))).toBeVisible();
			await expect(page.locator(test0('invite-tab-accept'))).toBeVisible();
			await page.locator(test0('invite-tab-fingerprint')).click();

			await page.locator(field0('peer-fingerprint')).fill(FINGERPRINT);
			await page.locator(field0('peer-name')).fill(name);
			await page.locator(test0('peer-add')).click();

			const row = page.locator(test0('peer-row')).filter({ hasText: name });
			await expect(row).toHaveCount(1);

			/*
			 * Pending is two situations wearing one word, and the row has to say which.
			 *
			 * This one is ours to wait for — we asked them — so there is nothing to
			 * answer here and no approval offered. An incoming request is a decision
			 * somebody here owes, and showing both as "pending" is how a request sits
			 * unanswered for a week with nobody realising it was theirs to answer.
			 */
			await expect(row).toHaveAttribute('data-status', 'pending');
			await expect(row).toHaveAttribute('data-direction', 'outgoing');
			await expect(row.locator(test0('peer-approve'))).toHaveCount(0);
			await expect(row.locator(test0('peer-incoming-hint'))).toHaveCount(0);

			// And the gateway holds it, rather than the screen holding a card it drew.
			const held = (await peersOf(request)).find(one => one.name === name);
			expect(held, 'the link was never recorded').toBeDefined();
			expect(held!.status).toBe('pending');
		} finally {
			await forget(request, name);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('an invitation the gateway refuses is refused on screen, in words', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);
		await page.goto('/peers');
		await page.locator(test0('peer-invite')).click();
		await page.locator(test0('invite-tab-accept')).click();

		await page.locator(field0('invite-code')).fill('not-an-invitation');
		await page.locator(test0('invite-accept')).click();

		// The API answers an error key; the interface decides the wording. A raw
		// `error.peer.invite_invalid` on screen means the catalogue is missing the
		// key, which is a defect nothing but a browser catches.
		const error = page.locator(test0('form-main-error'));
		await expect(error).toBeVisible();
		await expect(error).not.toContainText('error.peer');

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
