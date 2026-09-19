import { type APIRequestContext, expect, test } from '@playwright/test';
import { API_URL, apiToken, field0, signIn, test0, watchApi } from './helpers';

/**
 * What this gateway exposes, library by library.
 *
 * The absence of a policy is the private state — a library is never shared by having
 * been forgotten — so the screen has to be read against what the API actually holds
 * rather than against what a chip says: a row that renders `private` because the
 * policy list failed to load looks exactly like a row that is private, and the two
 * are opposite answers to the only question this screen asks.
 *
 * Making a library private again is a deletion, which is why it is tested as one: a
 * visibility left behind on a row nobody can see is how something stays shared.
 */
interface Library {
	id: string;
	name: string;
}

interface Policy {
	libraryId: string;
	visibility: string;
	rateLimit: number;
}

const PRIVATE = 'private';

async function authorized (request: APIRequestContext): Promise<{ Authorization: string }> {
	return { Authorization: `Bearer ${await apiToken(request)}` };
}

async function librariesOf (request: APIRequestContext): Promise<Library[]> {
	const response = await request.get(`${API_URL}/libraries`, { headers: await authorized(request) });
	expect(response.ok(), `libraries failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Library[];
}

async function policiesOf (request: APIRequestContext): Promise<Policy[]> {
	const response = await request.get(`${API_URL}/shares`, { headers: await authorized(request) });
	expect(response.ok(), `shares failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Policy[];
}

async function makePrivate (request: APIRequestContext, libraryId: string): Promise<void> {
	await request.delete(`${API_URL}/shares/${libraryId}`, { headers: await authorized(request) });
}

test.describe('shares', () => {
	test('every library is on the screen, saying what it exposes today', async ({ page, request }) => {
		const libraries = await librariesOf(request);
		const policies = await policiesOf(request);

		const failures = watchApi(page);
		await signIn(page);
		await page.locator(test0('nav-settings-shares')).click();

		const panels = page.locator(test0('share-library'));
		await expect(panels).toHaveCount(libraries.length);

		for (const library of libraries) {
			const panel = page.locator(`${test0('share-library')}[data-library="${library.id}"]`);
			await expect(panel).toHaveCount(1);
			// The API's answer, not a default the screen fell back to.
			const held = policies.find(one => one.libraryId === library.id);
			await expect(panel.locator(test0('share-visibility-chip')))
				.toHaveAttribute('data-visibility', held?.visibility ?? PRIVATE);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a library is shared by saying who can see it, and made private by deletion', async ({ page, request }) => {
		const libraries = await librariesOf(request);
		const before = await policiesOf(request);
		const library = libraries[0];
		expect(
			before.some(one => one.libraryId === library.id),
			'that library is already shared, so this journey would not be the one sharing it',
		).toBe(false);

		const failures = watchApi(page);

		try {
			await signIn(page);
			await page.goto('/settings/shares');

			const panel = page.locator(`${test0('share-library')}[data-library="${library.id}"]`);
			await panel.locator(test0('share-library-open')).click();

			/*
			 * Chosen by position in the list rather than by its wording: the three
			 * rules are an enum the API owns, the labels are sentences that will be
			 * reworded and translated, and what this journey is about is that the
			 * choice made here is the one the gateway ends up holding.
			 */
			await panel.locator(test0('share-visibility')).click();
			await page.getByRole('option').nth(1).click();
			await panel.locator(test0('share-save')).click();

			const saved = (await policiesOf(request)).find(one => one.libraryId === library.id);
			expect(saved, 'nothing was saved').toBeDefined();
			expect(saved!.visibility).not.toBe(PRIVATE);
			await expect(panel.locator(test0('share-visibility-chip')))
				.toHaveAttribute('data-visibility', saved!.visibility);

			// And back: the row is removed rather than set to `private`, because the
			// absence of a row is what private means everywhere else in the gateway.
			await panel.locator(test0('share-remove')).click();
			await expect(panel.locator(test0('share-visibility-chip')))
				.toHaveAttribute('data-visibility', PRIVATE);
			expect((await policiesOf(request)).some(one => one.libraryId === library.id)).toBe(false);
		} finally {
			await makePrivate(request, library.id);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a cap the API would refuse never leaves the form', async ({ page, request }) => {
		const libraries = await librariesOf(request);
		const library = libraries[0];

		// What the API does with a rate it cannot accept, asked of the API itself: the
		// form below has to refuse exactly what this refuses, or somebody types a cap,
		// waits, and is told by a round trip what the box beside them already knew.
		const refused = await request.put(`${API_URL}/shares/${library.id}`, {
			headers: await authorized(request),
			data: { visibility: 'friends', rateLimit: -1 },
		});
		expect(refused.status(), await refused.text()).toBe(400);

		const failures = watchApi(page);
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PUT' && one.url().includes('/shares/')) {
				attempts.push(one.url());
			}
		});

		try {
			await signIn(page);
			await page.goto('/settings/shares');

			const panel = page.locator(`${test0('share-library')}[data-library="${library.id}"]`);
			await panel.locator(test0('share-library-open')).click();
			await panel.locator(test0('share-visibility')).click();
			await page.getByRole('option').nth(1).click();

			const rate = panel.locator(test0('share-rate-limit'));
			await panel.locator(field0('share-rate-limit')).fill('as fast as it goes');
			const saidBefore = (await rate.textContent() ?? '').trim();

			await panel.locator(test0('share-save')).click();

			// Said on the spot, in whatever language the interface is being read in.
			await expect
				.poll(async () => (await rate.textContent() ?? '').trim(), {
					message: 'the form said nothing about a cap it cannot send',
				})
				.not
				.toBe(saidBefore);

			await page.waitForLoadState('networkidle');
			expect(attempts, `a policy was sent anyway: ${attempts.join(', ')}`).toHaveLength(0);
			expect((await policiesOf(request)).some(one => one.libraryId === library.id)).toBe(false);
		} finally {
			await makePrivate(request, library.id);
		}

		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
