import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API_URL, apiToken, signIn, test0, watchApi } from './helpers';

/**
 * The synchronisation screen: the standing intents, and what they have done.
 *
 * Everything here is built by the journey itself over the API, because `make e2e/ci`
 * seeds an administrator and some settings and nothing else — no service, no library,
 * no media, no plan. A journey that needed the owner's catalogue would pass on his
 * machine and fail on a runner for reasons nobody could reproduce.
 *
 * The one fixture that cannot be taken back is a run: a job row has no delete route,
 * and retention is what eventually removes it. So the runs these journeys start are
 * scoped to an item identifier nothing holds, which the planner resolves to zero
 * items — the gateway records one finished job with nothing in it, which is the
 * smallest trace that still proves the live/finished split is real.
 */

/**
 * A subtree identifier no media server will ever have issued.
 *
 * It keeps the scope *bounded*, which matters: an empty scope is refused unless it is
 * acknowledged — see `sync-plan.spec.ts` — so a fixture plan has to name something,
 * and naming something that does not exist is how a run finishes instantly instead of
 * pulling a whole library onto somebody's disk.
 */
const NOWHERE = '00000000-0000-4000-8000-000000000e2e';

interface Fixture {
	id: string;
	name: string;
	token: string;
}

/** A plan of our own: bounded, manual, so nothing schedules it behind the journey. */
async function createPlan (request: APIRequestContext, name: string): Promise<Fixture> {
	const token = await apiToken(request);
	const created = await request.post(`${API_URL}/sync/plans`, {
		headers: { Authorization: `Bearer ${token}` },
		data: {
			name,
			trigger: 'manual',
			scope: { rootItemIds: [NOWHERE] },
			filter: { missingOnly: true },
		},
	});
	expect(created.ok(), `create failed: ${created.status()} ${await created.text()}`).toBeTruthy();

	return { id: (await created.json()).id as string, name, token };
}

async function removePlan (request: APIRequestContext, fixture: Fixture): Promise<void> {
	await request.delete(`${API_URL}/sync/plans/${fixture.id}`, {
		headers: { Authorization: `Bearer ${fixture.token}` },
	});
}

/**
 * Which half of the history the screen actually asked the gateway for.
 *
 * Read off the request rather than off the toggle, and that is not a shortcut: a
 * Vuetify button group marks its selection with a class and nothing else, and the
 * `data-test` contract of this folder exists precisely so journeys never depend on
 * one. The question being asked here — "did picking Finished widen what is queried"
 * — is answered by the query string and by nothing on the screen at all.
 */
function recordJobQueries (page: Page): string[] {
	const asked: string[] = [];

	page.on('request', one => {
		if (one.url().includes('/api/sync/jobs')) {
			asked.push(one.url());
		}
	});

	return asked;
}

test.describe('synchronisation', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
		await page.locator(test0('nav-sync')).click();
		await expect(page.locator(test0('plan-list'))).toBeVisible();
	});

	test('a plan is on the list, with everything that can be done to it', async ({ page, request }) => {
		const failures = watchApi(page);
		const fixture = await createPlan(request, 'Journey plan · listed');

		try {
			await page.reload();

			const row = page.locator(test0('plan-row')).filter({ hasText: fixture.name });
			await expect(row).toBeVisible();

			// The actions a row exists to carry. A row that only held the name would
			// make somebody open six plans to find the one they meant to run.
			await expect(row.locator(test0('plan-run'))).toBeVisible();
			await expect(row.locator(test0('plan-toggle'))).toBeVisible();
			await expect(row.locator(test0('plan-edit'))).toBeVisible();

			await page.waitForLoadState('networkidle');
			expect(failures, failures.join('\n')).toHaveLength(0);
		} finally {
			await removePlan(request, fixture);
		}
	});

	/**
	 * The live half, and the way out of it — which is the whole point.
	 *
	 * Both halves of the promise are one promise: the runs list opens on what is still
	 * going, and somebody whose fifty finished runs are suddenly not on the screen has
	 * to be told where they went *on that screen*. There is a caption under a non-empty
	 * list and a button inside the empty state for exactly that, and which of the two
	 * applies depends on what the gateway happens to be doing — so the journey makes
	 * the list non-empty itself to see the caption, then empties it to see the button.
	 */
	test('the finished runs are reachable from the live view, and the screen says so', async ({ page, request }) => {
		const failures = watchApi(page);
		const asked = recordJobQueries(page);
		const fixture = await createPlan(request, 'Journey plan · history');

		try {
			await page.reload();
			await expect(page.locator(test0('plan-list'))).toBeVisible();

			// It opens on what is running, which is the reason the rest of this journey
			// has anything to prove.
			await expect.poll(() => asked.at(-1) ?? '').toContain('view=live');

			const row = page.locator(test0('plan-row')).filter({ hasText: fixture.name });
			await row.locator(test0('plan-run')).click();
			await expect(page.locator(test0('notify'))).toBeVisible();

			/*
			 * The run it just started is on the screen although it is already finished.
			 *
			 * Deliberate, and worth pinning down: a row vanishing at the very moment
			 * somebody is watching it complete is the worst possible moment for it to
			 * go. It leaves on the next load, which is what the rest of this checks.
			 */
			const started = page.locator(test0('job-row')).filter({ hasText: fixture.name });
			await expect(started).toBeVisible();

			// With a non-empty live list, the caption is what says the finished ones
			// still exist. This is the branch a populated gateway is always in.
			await expect(page.locator(test0('job-history-hint'))).toBeVisible();

			await page.reload();
			await expect(page.locator(test0('plan-list'))).toBeVisible();
			await expect(started).toHaveCount(0);

			// And now the other branch. On a seeded gateway nothing else is running, so
			// the empty state stands there with the button in it; where something is,
			// the caption does the same job and the toggle is the road.
			const button = page.locator(test0('job-see-finished'));

			if (await button.count() > 0) {
				await button.click();
			} else {
				await expect(page.locator(test0('job-history-hint'))).toBeVisible();
				await page.locator(test0('job-view-finished')).click();
			}

			await expect.poll(() => asked.at(-1) ?? '').toContain('view=finished');
			await expect(page.locator(test0('job-row')).filter({ hasText: fixture.name })).toBeVisible();

			// "All" holds it too, which is what makes the three-way control honest: the
			// finished half is a filter over one list, not a second list elsewhere.
			await page.locator(test0('job-view-all')).click();
			await expect.poll(() => asked.at(-1) ?? '').toContain('view=all');
			await expect(page.locator(test0('job-row')).filter({ hasText: fixture.name })).toBeVisible();

			await page.waitForLoadState('networkidle');
			expect(failures, failures.join('\n')).toHaveLength(0);
		} finally {
			await removePlan(request, fixture);
		}
	});

	/**
	 * Disabling a plan from the list, without opening it.
	 *
	 * The one action on this screen that changes what the gateway will do on its own,
	 * so the row has to show the result rather than only having accepted the click.
	 */
	test('a plan can be disabled from its row, and the row says that it is', async ({ page, request }) => {
		const fixture = await createPlan(request, 'Journey plan · toggle');

		try {
			await page.reload();

			const row = page.locator(test0('plan-row')).filter({ hasText: fixture.name });
			await row.locator(test0('plan-toggle')).click();

			// Read back from the gateway rather than from the button's new label: a
			// label that flipped on an optimistic update and a plan that is really
			// disabled are the same picture and not the same thing.
			await expect
				.poll(async () => {
					const read = await request.get(`${API_URL}/sync/plans/${fixture.id}`, {
						headers: { Authorization: `Bearer ${fixture.token}` },
					});
					return (await read.json()).enabled as boolean;
				}, { message: 'the plan is still enabled on the gateway' })
				.toBe(false);

			await expect(row.locator(test0('plan-disabled'))).toBeVisible();
		} finally {
			await removePlan(request, fixture);
		}
	});
});
