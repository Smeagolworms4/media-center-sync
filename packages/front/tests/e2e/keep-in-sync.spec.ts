import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import {
	authorized,
	createMediaFixture,
	type MediaFixture,
	type OwnDestination,
	useOwnDestination,
} from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';

/**
 * Keeping a show in step, from the show.
 *
 * The blank plan form asks for a name, a trigger, sources, a scope, a filter and a
 * ceiling before anybody has said the one thing they meant — *this show* — so nobody
 * fills it in and the feature the product exists for goes unused. This dialog is the
 * answer to that, and everything worth checking about it is on the screen rather than
 * in the body it posts: what the scope comes to before anything is undertaken, that
 * the two intents are told apart, that a plan which already covers the media is named
 * instead of duplicated, and that a form which cannot be submitted says so where
 * somebody is looking.
 *
 * The media is the journey's own, created over the API from a media server the test
 * itself serves — see `fake-jellyfin.ts`. Nothing here asserts against a catalogue
 * somebody happened to have loaded, and `DELETE /services/:id` at the end takes the
 * whole fixture away.
 *
 * Serial, because the plan created halfway through is what the last two journeys are
 * about: a media is either covered or it is not, and that is the state under test.
 */
test.describe.serial('keeping a media in sync', () => {
	let fixture: MediaFixture;
	/**
	 * A library of the file's own, for the whole file and not only for the run.
	 *
	 * The estimate is a plan the gateway computes, and planning needs somewhere the
	 * files could land: on a gateway with no writable library — a clean CI stack, or a
	 * household that only reads a friend's server — it is refused, and the dialog shows
	 * no number at all. Giving it one keeps this journey about the dialog.
	 */
	let destination: OwnDestination | null = null;
	const plans: string[] = [];

	test.beforeAll(async ({ request }) => {
		fixture = await createMediaFixture(request);
		destination = await useOwnDestination(request, `keep-${fixture.tag}`);
	});

	test.afterAll(async ({ request }) => {
		const headers = await authorized(request);
		for (const planId of plans) {
			await request.delete(`${API_URL}/sync/plans/${planId}`, { headers });
		}
		await destination?.release(request);
		await fixture.remove(request);
	});

	/** The plans the gateway itself holds for a media, which is the only proof there is. */
	async function coverage (request: APIRequestContext, itemId: string): Promise<{
		covering: { exact: boolean; plan: { id: string; name: string } }[];
	}> {
		const response = await request.get(`${API_URL}/sync/plans/for-item/${itemId}`, {
			headers: await authorized(request),
		});
		expect(response.ok(), `coverage failed: ${response.status()}`).toBeTruthy();
		return await response.json();
	}

	async function openKeepDialog (page: Page, itemId: string): Promise<void> {
		await page.goto(`/library/${itemId}`);
		await page.locator(test0('item-keep')).click();
		await expect(page.locator(test0('keep-in-sync'))).toBeVisible();
		// The dialog asks the gateway two questions before it can show anything; the
		// estimate is the last of them to arrive.
		await expect(page.locator(test0('keep-estimate'))).toBeVisible({ timeout: 15_000 });
	}

	/**
	 * A show and a season grow; a film is finished.
	 *
	 * Offering "keep this film in step for ever" would create a schedule that finds
	 * nothing every night, which is how people learn that plans do nothing.
	 */
	test('is offered on a series and on a season, and never on a film', async ({ page }) => {
		const failures = watchApi(page);
		await signIn(page);

		await page.goto(`/library/${fixture.series.id}`);
		await expect(page.locator(test0('page-title'))).toHaveText(fixture.series.title);
		await expect(page.locator(test0('item-keep'))).toBeVisible();

		await page.goto(`/library/${fixture.season.id}`);
		await expect(page.locator(test0('item-keep'))).toBeVisible();

		await page.goto(`/library/${fixture.film.id}`);
		await expect(page.locator(test0('page-title'))).toHaveText(fixture.film.title);
		// A film is not something to watch for new parts of, so no schedule is offered —
		// and nothing above the list offers a fetch either, since a copy is what a
		// transfer is about.
		await expect(page.locator(test0('item-keep'))).toHaveCount(0);
		await expect(page.locator(test0('item-sync'))).toHaveCount(0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * The number, before anything is saved.
	 *
	 * From a season it is a handful of episodes and from a series it is a whole show,
	 * and that difference is the entire reason it is shown here rather than on the
	 * screen somebody reaches afterwards.
	 */
	test('says what the scope comes to before anything is created', async ({ page }) => {
		const failures = watchApi(page);
		await signIn(page);
		await openKeepDialog(page, fixture.season.id);

		const estimate = page.locator(test0('keep-estimate'));
		// Three episodes, none of them ours: the fixture is a server whose files this
		// gateway cannot reach, so everything under it is something to fetch.
		await expect(estimate).toContainText('3');
		// A catalogue with no entry for the key renders the key, which is a defect
		// nobody notices in a screenshot.
		await expect(estimate).not.toContainText('sync.');

		// Both intents on screen at once, each under its own heading. One button that
		// silently does the other is the failure this arrangement exists to prevent.
		await expect(page.locator(test0('keep-create'))).toBeVisible();
		await expect(page.locator(test0('keep-run-once'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * A schedule nobody typed is a gateway that downloads at four in the morning.
	 *
	 * The trigger opens on *manual*, so the question this journey asks is the one the
	 * form actually has to answer: a standing schedule with no cron in it. The refusal
	 * has to be *visible* — a form that silently does nothing when the button is
	 * pressed is the defect class this product has shipped more than once — and it has
	 * to happen here, which is what the absence of a request below proves.
	 */
	test('refuses a schedule with no cron, on the screen, and posts nothing', async ({ page }) => {
		const posted: string[] = [];
		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes('/sync/plans')) {
				posted.push(one.url());
			}
		});

		await signIn(page);
		await openKeepDialog(page, fixture.series.id);

		// By position rather than by wording: the triggers are an enum the API owns and
		// the labels are sentences somebody will reword or translate. `schedule` is the
		// second of `manual`, `schedule`, `on_new`.
		await page.locator(test0('keep-trigger')).click();
		await page.getByRole('option').nth(1).click();

		const schedule = page.locator(test0('keep-schedule'));
		await expect(schedule).toBeVisible();
		const saidBefore = (await schedule.textContent() ?? '').trim();

		await page.locator(test0('keep-create')).click();

		// Compared against what the field said a moment ago rather than against a
		// sentence: the message is our rule rendered by Vuetify in whichever language
		// the browser asked for.
		await expect
			.poll(async () => (await schedule.textContent() ?? '').trim(), {
				message: 'the form said nothing about a schedule it cannot accept',
			})
			.not
			.toBe(saidBefore);

		await expect(page.locator(test0('keep-in-sync'))).toBeVisible();
		expect(posted, `a plan with no schedule was posted: ${posted.join(', ')}`).toHaveLength(0);

		// And a cron it can accept goes through, which is what makes the refusal above
		// a rule rather than a broken button.
		await page.locator(field0('keep-schedule')).fill('0 4 * * *');
		await expect
			.poll(async () => (await schedule.textContent() ?? '').trim())
			.toBe(saidBefore);
	});

	/**
	 * The other intent: pull what is missing now, and remember nothing.
	 *
	 * It runs for real, into a library this journey created and pointed the gateway at
	 * — see `useOwnDestination`. A run with no destination of our own lands files in
	 * whatever shelf the placement rule reaches, which on a gateway with a real
	 * catalogue is somebody's own; that is not a thing a test may do, so without one it
	 * skips.
	 */
	test('runs once without creating a plan', async ({ page, request }) => {
		test.skip(
			destination === null,
			'no library this journey owns to pull into: the gateway cannot write where the '
			+ 'journey can create a directory — set E2E_LANDING_PATH to the gateway\'s view of it',
		);

		const runs: string[] = [];
		const posted: string[] = [];
		page.on('request', one => {
			if (one.method() !== 'POST') {
				return;
			}
			if (one.url().includes('/sync/run')) {
				runs.push(one.postData() ?? '');
			}
			if (one.url().includes('/sync/plans')) {
				posted.push(one.url());
			}
		});

		await signIn(page);
		await openKeepDialog(page, fixture.season.id);

		await page.locator(test0('keep-run-once')).click();
		await expect(page.locator(test0('notify'))).toBeVisible();
		await expect(page.locator(test0('keep-in-sync'))).toBeHidden();

		// What it asked for is the scope of the dialog, filling holes only: somebody
		// asking for the missing episodes of a season has not asked for the ones
		// they already hold to be replaced.
		expect(runs, 'the one-off button ran nothing').toHaveLength(1);
		const body = JSON.parse(runs[0]) as {
			scope: { rootItemIds: string[] };
			filter: { missingOnly: boolean };
		};
		expect(body.scope.rootItemIds).toEqual([fixture.season.id]);
		expect(body.filter.missingOnly).toBe(true);

		// And nothing was remembered, which is the whole difference between the two
		// halves of this dialog.
		expect(posted, `the one-off run created a plan: ${posted.join(', ')}`).toHaveLength(0);
		expect((await coverage(request, fixture.season.id)).covering).toHaveLength(0);
	});

	/**
	 * Creating the plan, and finding it again in September.
	 *
	 * Somebody who kept a show in sync in March comes back to the show, not to the sync
	 * screen — so the media has to carry the way back to its plan, and that chip has to
	 * lead somewhere.
	 */
	test('creates the plan from the series, and the media then links to it', async ({ page, request }) => {
		const failures = watchApi(page);
		await signIn(page);
		await openKeepDialog(page, fixture.series.id);

		// The name is derived from the media rather than asked for, which is the point:
		// the one question left is when it runs.
		await expect(page.locator(field0('keep-name'))).toHaveValue(fixture.series.title);

		await page.locator(test0('keep-create')).click();
		await expect(page.locator(test0('notify'))).toBeVisible();
		await expect(page.locator(test0('keep-in-sync'))).toBeHidden();

		const covering = (await coverage(request, fixture.series.id)).covering;
		expect(covering, 'no plan was created').toHaveLength(1);
		plans.push(covering[0].plan.id);
		expect(covering[0].plan.name).toBe(fixture.series.title);
		expect(covering[0].exact, 'the plan does not cover the media it was made from').toBe(true);

		const chip = page.locator(test0('item-plan-link'));
		await expect(chip).toBeVisible();
		await expect(chip).toContainText(fixture.series.title);

		await chip.click();
		await expect(page).toHaveURL(new RegExp(`/sync/plans/${covering[0].plan.id}`));
		await expect(page.locator(test0('page-title'))).toContainText(fixture.series.title);

		// The way back is there on a fresh page too, and not merely because the chip was
		// written in by the dialog that had just closed.
		await page.goto(`/library/${fixture.series.id}`);
		await expect(page.locator(test0('item-plan-link'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * A plan on the series speaks for the season under it.
	 *
	 * Two plans over one show are two runs pulling the same episodes into the same
	 * folder, and the loser of the race finds the winner's half-written file. So the
	 * answer to "keep this season in sync" when the show is already kept is that plan,
	 * named and linked — and the button that would make a second one is not there to
	 * be pressed.
	 */
	test('refuses a second plan where one already covers, naming the one that does', async ({ page, request }) => {
		expect(plans, 'the plan this journey needs was not created').not.toHaveLength(0);
		const failures = watchApi(page);
		await signIn(page);

		await openKeepDialog(page, fixture.season.id);

		const covered = page.locator(test0('keep-covered'));
		await expect(covered).toBeVisible();
		await expect(covered).toContainText(fixture.series.title);
		await expect(covered).not.toContainText('sync.keep');
		await expect(page.locator(test0('keep-create')), 'a second plan was still offered')
			.toHaveCount(0);
		await expect(page.locator(test0('keep-form'))).toHaveCount(0);

		// The refusal leads somewhere: the plan that already covers this season is one
		// click away, which is the only thing to do about it.
		await page.locator(test0('keep-open-plan')).click();
		await expect(page).toHaveURL(new RegExp(`/sync/plans/${plans[0]}`));

		// And the screen is not the only guard. The route refuses it too, with a key
		// rather than a sentence — otherwise the rule is a rendering decision and a
		// second tab, or a second person, goes round it.
		const second = await request.post(`${API_URL}/sync/plans/for-item`, {
			headers: await authorized(request),
			data: { itemId: fixture.season.id, trigger: 'manual', name: 'Journey duplicate' },
		});
		expect(second.status(), await second.text()).toBe(409);
		expect(await second.text()).toContain('already_covered');

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
