import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import {
	createMediaFixture,
	journeyTag,
	type MediaFixture,
	type OwnDestination,
	useOwnDestination,
} from './fake-jellyfin';
import { API_URL, apiToken, field0, signIn, test0, watchApi } from './helpers';

/**
 * The plan editor, and every way it says no.
 *
 * The densest form in the product, and the one with the most to lose: a plan is a
 * standing intent, so a field it accepts wrongly is not a mistake somebody sees — it
 * is a gateway that pulls the wrong thing, or nothing at all, at four in the morning
 * for months. Every refusal below is therefore checked for being *on screen*: a
 * refusal that appears nowhere is the defect class this product has shipped four
 * times, and no unit test has ever caught one of them.
 *
 * Everything is built over the API and taken back in a `finally`, because `make
 * e2e/ci` installs a gateway with an administrator and nothing else. The libraries the
 * destination checks need come from `fake-jellyfin.ts`: a scanned fake server whose
 * shelves this gateway cannot write into, and a landing library of the journey's own
 * that it can. Without both, "only writable libraries are offered" would be checked
 * against an empty list on every runner and pass by asserting nothing.
 */

/** Why a journey that needs a writable library of its own did not get one. */
const NO_LANDING = 'no library this journey owns: the gateway cannot write where the journey can create a directory — set E2E_LANDING_PATH to the gateway\'s view of it';

/** A subtree identifier nothing holds, which keeps a fixture plan's scope bounded. */
const NOWHERE = '00000000-0000-4000-8000-000000000e2e';

/** A library identifier nothing answers to, for the refusal that is purely by key. */
const NO_LIBRARY = '00000000-0000-4000-8000-0000000b0b00';

interface Destinations {
	/** Libraries this gateway can really write into: what the form may offer. */
	writable: string[];
	/** Everything else, which the form must name instead of dropping silently. */
	rejected: string[];
}

/**
 * What the gateway's own data says the destination offer should be.
 *
 * Computed here from the three routes the screen reads rather than trusted from the
 * screen, because the thing under test is precisely whether the two agree: a library
 * that quietly disappears from this list is how somebody's shelf stops being a
 * destination with nothing anywhere saying so.
 */
async function destinationsOf (request: APIRequestContext, token: string): Promise<Destinations> {
	const headers = { Authorization: `Bearer ${token}` };
	const libraries = await (await request.get(`${API_URL}/libraries`, { headers })).json();
	const services = await (await request.get(`${API_URL}/services`, { headers })).json();
	const checks = await (await request.get(`${API_URL}/libraries/check`, { headers })).json();

	const local = new Set(
		(services as { id: string; mode: string }[])
			.filter(one => one.mode === 'local')
			.map(one => one.id),
	);
	const checked = new Map(
		(checks as { libraryId: string; writable: boolean }[]).map(one => [one.libraryId, one.writable]),
	);

	const writable: string[] = [];
	const rejected: string[] = [];

	for (const library of libraries as { id: string; serviceId: string; writable: boolean }[]) {
		const ours = local.has(library.serviceId);
		const canWrite = checked.get(library.id) ?? library.writable;

		(ours && canWrite ? writable : rejected).push(library.id);
	}

	return { writable, rejected };
}

/** Open a Vuetify select and pick the option carrying a value, never a label. */
async function choose (page: Page, field: string, option: string, value: string): Promise<void> {
	await page.locator(test0(field)).click();
	await page.locator(`[data-test="${option}"][data-value="${value}"]`).click();
}

/**
 * Take back every plan this file created under a name, whatever its identifier.
 *
 * Used where the plan is created through the form rather than over the API, so a
 * journey that fails between the save and reading the address still leaves nothing.
 * Only ever called with a `Journey plan · …` name, which nothing but these files use.
 */
async function removePlansNamed (request: APIRequestContext, name: string): Promise<void> {
	const headers = { Authorization: `Bearer ${await apiToken(request)}` };
	const plans = await (await request.get(`${API_URL}/sync/plans`, { headers })).json() as { id: string; name: string }[];

	for (const plan of plans.filter(one => one.name === name)) {
		await request.delete(`${API_URL}/sync/plans/${plan.id}`, { headers });
	}
}

test.describe('the plan form', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
	});

	/**
	 * A schedule with no cron expression, refused twice over.
	 *
	 * This one has a history: such a plan used to be stored, listed as scheduled, and
	 * never fire — the scheduler registers what it can parse and says nothing about
	 * what it cannot, so the first anybody heard of it was the episodes that never
	 * arrived. Both refusals are checked, because they answer different questions:
	 * the form's says somebody is told on the spot, the gateway's says a form that
	 * lost its rule cannot put the row back.
	 */
	test('a schedule with no cron expression is refused on the spot, and nothing is sent', async ({ page, request }) => {
		const attempts: string[] = [];

		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes('/api/sync/plans')) {
				attempts.push(one.url());
			}
		});

		await page.goto('/sync/plans/new');
		await expect(page.locator(test0('plan-form'))).toBeVisible();

		await page.locator(field0('plan-name')).fill('Journey plan · blind schedule');
		await choose(page, 'plan-trigger', 'plan-trigger-option', 'schedule');

		// The cron field only exists once the trigger asks for one, which is itself
		// part of the contract: a plan that runs by hand has no business carrying a
		// schedule nobody can see.
		const schedule = page.locator(test0('plan-schedule'));
		await expect(schedule).toBeVisible();

		/*
		 * The field says something else afterwards, whatever it says.
		 *
		 * Compared against what it said a moment earlier rather than against a
		 * sentence: the message is Vuetify's rendering of our rule, in whichever
		 * language the browser asked for, and a journey that spelled it out would break
		 * on a reworded hint. What is being checked is that the submit was answered on
		 * the spot — which is also what makes the absence of a request below mean
		 * something.
		 */
		const saidBefore = (await schedule.textContent() ?? '').trim();

		await page.locator(test0('plan-save')).click();

		await expect
			.poll(async () => (await schedule.textContent() ?? '').trim(), {
				message: 'the form said nothing about the schedule it cannot accept',
			})
			.not
			.toBe(saidBefore);

		await page.waitForLoadState('networkidle');
		expect(attempts, `the form posted a plan it should have refused: ${attempts.join(', ')}`)
			.toHaveLength(0);
		await expect(page).toHaveURL(/\/sync\/plans\/new/);

		// And the gateway refuses the same thing, so the rule cannot be lost by
		// deleting one line of a form.
		const token = await apiToken(request);
		const posted = await request.post(`${API_URL}/sync/plans`, {
			headers: { Authorization: `Bearer ${token}` },
			data: { name: 'Journey plan · blind schedule', trigger: 'schedule', scope: { rootItemIds: [NOWHERE] } },
		});
		expect(posted.status(), await posted.text()).toBe(409);
		expect((await posted.json()).message).toBe('error.sync.schedule_required');
	});

	/**
	 * The plan an empty form produces: "synchronise everything", enabled.
	 *
	 * Refused, then acknowledged, then saved — the three states of one decision. The
	 * refusal used to tell somebody to confirm and offer nothing to confirm with, which
	 * is worse than no refusal: it says there is a way forward and hides it. So the box
	 * is checked for appearing exactly when it applies, for refusing on the spot while
	 * it is unticked, and for the plan really being stored once it is ticked.
	 */
	test('a plan whose scope names nothing is refused, then acknowledged, then saved', async ({ page, request }) => {
		const name = 'Journey plan · everything, knowingly';
		const posted: string[] = [];

		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes('/api/sync/plans')) {
				posted.push(one.postData() ?? '');
			}
		});

		try {
			await page.goto('/sync/plans/new');
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			// The name is the only field filled in, which is exactly the input under
			// test: everything else keeps the default an empty form gives it.
			await page.locator(field0('plan-name')).fill(name);

			const acknowledge = page.locator(test0('plan-acknowledge-unbounded'));
			await expect(acknowledge).toBeVisible();

			// Only while it applies: a root item bounds the scope, and a disabled plan
			// runs nothing — the gateway asks for neither, so neither does the form.
			await page.locator(field0('plan-root')).fill(NOWHERE);
			await expect(acknowledge).toHaveCount(0);
			await page.locator(field0('plan-root')).fill('');
			await expect(acknowledge).toBeVisible();
			await page.locator(field0('plan-enabled')).uncheck();
			await expect(acknowledge).toHaveCount(0);
			await page.locator(field0('plan-enabled')).check();
			await expect(acknowledge).toBeVisible();
			await expect(page.locator(field0('plan-acknowledge-unbounded'))).not.toBeChecked();

			// Refused: on the spot, next to the box that answers it, and nothing sent.
			const saidBefore = (await acknowledge.textContent() ?? '').trim();
			await page.locator(test0('plan-save')).click();
			await expect
				.poll(async () => (await acknowledge.textContent() ?? '').trim(), {
					message: 'the form said nothing about a scope that names nothing',
				})
				.not
				.toBe(saidBefore);
			// The gateway's key has an entry in the catalogue; a raw key here would be a
			// refusal that is technically present and practically invisible.
			await expect(acknowledge).not.toContainText('error.sync');
			await page.waitForLoadState('networkidle');
			expect(posted, 'the form posted an unacknowledged plan that names nothing').toHaveLength(0);

			// Acknowledged, then saved: the page moves to the plan's own address.
			await page.locator(field0('plan-acknowledge-unbounded')).check();
			await page.locator(test0('plan-save')).click();
			await expect(page).toHaveURL(/\/sync\/plans\/[0-9a-f-]{36}/);

			expect(posted).toHaveLength(1);
			expect(JSON.parse(posted[0]).acknowledgeUnbounded, 'saved without saying it was acknowledged')
				.toBe(true);

			const planId = /\/sync\/plans\/([0-9a-f-]{36})/.exec(page.url())![1];
			const token = await apiToken(request);
			const stored = await (await request.get(`${API_URL}/sync/plans/${planId}`, {
				headers: { Authorization: `Bearer ${token}` },
			})).json();
			expect(stored.enabled).toBe(true);
			expect(stored.scope).toEqual({});
		} finally {
			await removePlansNamed(request, name);
		}
	});

	/**
	 * "Everything" on a timer needs a ceiling as well.
	 *
	 * Pressing run on everything, knowingly, is defensible — the preview says what it
	 * comes to first. Leaving everything to a schedule is not: the scope that was a few
	 * shows in January is a whole server by June, and nobody is watching at four in
	 * the morning. The form asks for a limit per run, and what is typed is what is kept.
	 */
	test('a scheduled plan that names nothing needs a ceiling per run, and keeps the one it is given', async ({ page, request }) => {
		const name = 'Journey plan · everything, capped';
		const posted: string[] = [];

		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes('/api/sync/plans')) {
				posted.push(one.postData() ?? '');
			}
		});

		try {
			await page.goto('/sync/plans/new');
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			await page.locator(field0('plan-name')).fill(name);
			await choose(page, 'plan-trigger', 'plan-trigger-option', 'schedule');
			// The first of January at four: a schedule that exists for the length of a
			// journey and cannot fire during one.
			await page.locator(field0('plan-schedule')).fill('0 4 1 1 *');
			await page.locator(field0('plan-acknowledge-unbounded')).check();

			const items = page.locator(test0('plan-max-items-per-run'));
			const saidBefore = (await items.textContent() ?? '').trim();
			await page.locator(test0('plan-save')).click();
			await expect
				.poll(async () => (await items.textContent() ?? '').trim(), {
					message: 'the form said nothing about a limit an unbounded schedule needs',
				})
				.not
				.toBe(saidBefore);
			await page.waitForLoadState('networkidle');
			expect(posted, 'a scheduled plan that names nothing was posted with no ceiling').toHaveLength(0);

			// A ceiling of nothing is refused too: it would read as a limit and pull
			// nothing, ever.
			await page.locator(field0('plan-max-items-per-run')).fill('0');
			await page.locator(test0('plan-save')).click();
			await page.waitForLoadState('networkidle');
			expect(posted).toHaveLength(0);

			await page.locator(field0('plan-max-items-per-run')).fill('10');
			await page.locator(field0('plan-max-bytes-per-run')).fill('200G');
			await page.locator(test0('plan-save')).click();
			await expect(page).toHaveURL(/\/sync\/plans\/[0-9a-f-]{36}/);

			const planId = /\/sync\/plans\/([0-9a-f-]{36})/.exec(page.url())![1];
			const token = await apiToken(request);
			const stored = await (await request.get(`${API_URL}/sync/plans/${planId}`, {
				headers: { Authorization: `Bearer ${token}` },
			})).json();
			expect(stored.maxItemsPerRun).toBe(10);
			expect(stored.maxBytesPerRun).toBe(200 * 1024 ** 3);

			// Shown back the way it was typed, which is what makes the next edit safe.
			await page.reload();
			await expect(page.locator(field0('plan-max-items-per-run'))).toHaveValue('10');
			await expect(page.locator(field0('plan-max-bytes-per-run'))).toHaveValue('200G');
		} finally {
			await removePlansNamed(request, name);
		}
	});

	/**
	 * The destination offer: what is in it, and what is missing from it and why.
	 *
	 * A library the gateway cannot write into accepts a preference it will silently
	 * pass over on every run — so it is not offered. But a name that simply vanishes
	 * from a list reads as a bug, so the ones left out are printed with the reason.
	 * Both halves are the same promise and both are checked against what the gateway
	 * actually holds, whatever that is: on a seeded runner it holds nothing, and then
	 * the form has to say *that* rather than show an empty menu.
	 */
	test('only libraries this gateway can write into are offered, and the rest are named', async ({ page, request }) => {
		const tag = journeyTag();
		const landing = await useOwnDestination(request, `offer-${tag}`);
		let media: MediaFixture | null = null;

		try {
			// A server whose shelves this gateway only reads, so there is something the
			// offer must leave out — and name — on a runner that otherwise holds nothing.
			media = await createMediaFixture(request, `offer-${tag}`);

			const token = await apiToken(request);
			const expected = await destinationsOf(request, token);
			expect(expected.rejected.length, 'the fixture left no library to refuse').toBeGreaterThan(0);

			await page.goto('/sync/plans/new');
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			if (expected.writable.length === 0) {
				// Nothing here can receive a file, and the form says which kind of thing a
				// destination has to be instead of leaving an empty menu to interpret.
				await expect(page.locator(test0('plan-target-none'))).toBeVisible();
			} else {
				await page.locator(test0('plan-target')).click();

				const options = page.locator('[data-test="plan-target-option"]');
				await expect(options).toHaveCount(expected.writable.length);

				const offered = await options.evaluateAll(
					nodes => nodes.map(node => (node as HTMLElement).dataset.library));
				expect(new Set(offered)).toEqual(new Set(expected.writable));
				for (const id of expected.rejected) {
					expect(offered, `a library that cannot receive files was offered: ${id}`)
						.not
						.toContain(id);
				}

				await page.keyboard.press('Escape');
			}

			// One line per library left out, each carrying its reason. The fixture's
			// shelves are named by what the fixture called them; the reason itself is a
			// translated sentence, so it is only required not to be missing.
			const rejected = page.locator(test0('plan-target-rejected'));
			await expect(rejected).toHaveCount(expected.rejected.length);
			await expect(rejected.filter({ hasText: `Journey Films offer-${tag}` })).toHaveCount(1);
			await expect(rejected.filter({ hasText: `Journey Shows offer-${tag}` })).toHaveCount(1);
		} finally {
			await media?.remove(request);
			await landing?.release(request);
		}
	});

	/** A key nothing answers to is refused by the gateway, not stored and ignored. */
	test('a preferred destination nothing answers to is refused by key', async ({ request }) => {
		const token = await apiToken(request);
		const posted = await request.post(`${API_URL}/sync/plans`, {
			headers: { Authorization: `Bearer ${token}` },
			data: {
				name: 'Journey plan · nowhere destination',
				trigger: 'manual',
				scope: { rootItemIds: [NOWHERE] },
				preferredLibraryId: NO_LIBRARY,
			},
		});

		expect(posted.status(), await posted.text()).toBe(404);
		expect((await posted.json()).message).toBe('error.library.not_found');
	});

	/**
	 * A shelf on somebody else's server, refused by key rather than by the menu.
	 *
	 * The form does not offer one, which is the first line; this is the second. A
	 * preference set from an older form, a script, or a request somebody wrote by hand
	 * would otherwise be stored, passed over on every run, and leave its author
	 * wondering why nothing ever goes there.
	 */
	test('a preferred destination on a server this gateway cannot write into is refused by key', async ({ request }) => {
		const media = await createMediaFixture(request);

		try {
			const token = await apiToken(request);
			const headers = { Authorization: `Bearer ${token}` };
			const libraries = await (await request.get(`${API_URL}/libraries`, { headers })).json();
			const theirs = (libraries as { id: string; serviceId: string }[])
				.find(one => one.serviceId === media.serviceId);
			expect(theirs, 'the fixture server was scanned into no library').toBeTruthy();

			const posted = await request.post(`${API_URL}/sync/plans`, {
				headers,
				data: {
					name: 'Journey plan · unwritable destination',
					trigger: 'manual',
					scope: { rootItemIds: [NOWHERE] },
					preferredLibraryId: theirs!.id,
				},
			});

			expect(posted.status(), await posted.text()).toBe(409);
			expect((await posted.json()).message).toBe('error.transfer.destination_invalid');
		} finally {
			await media.remove(request);
		}
	});
});

/**
 * A plan's own page: reaching it, reading it, editing it, and previewing a run.
 *
 * The round trip is the part worth pinning down. A form that posts a whole object
 * silently wipes what it does not render — the per-run ceilings, before they had a
 * control; every subtree but the first, still — and that is a loss nobody sees until
 * a schedule that was capped runs away, or a show stops arriving.
 */
test.describe('a plan\'s own page', () => {
	/**
	 * Addresses of this file's own, where nothing listens.
	 *
	 * The gateway refuses the same server twice, so these cannot be the port another
	 * journey registers — `services.spec.ts` takes `:1` — or a failure over there would
	 * surface here as a duplicate and name the wrong file.
	 */
	const SOURCE_ADDRESSES = ['http://127.0.0.1:7', 'http://127.0.0.1:9'];
	const LATE_ADDRESS = 'http://127.0.0.1:11';

	interface Fixture {
		token: string;
		planId: string;
		services: { id: string; name: string }[];
		name: string;
	}

	async function removeAll (request: APIRequestContext, token: string, planId: string | null, serviceIds: string[]): Promise<void> {
		const headers = { Authorization: `Bearer ${token}` };

		if (planId) {
			await request.delete(`${API_URL}/sync/plans/${planId}`, { headers });
		}
		for (const id of serviceIds) {
			await request.delete(`${API_URL}/services/${id}`, { headers });
		}
	}

	/**
	 * Two services and a plan that uses them, all created here and all taken back.
	 *
	 * Taken back even when the setup itself fails half way: a first service created and
	 * a second refused would otherwise outlive the run, and every later run would then
	 * be refused as a duplicate of it — a failure that names this file forever after
	 * for a reason nobody can see.
	 */
	async function setUp (
		request: APIRequestContext,
		name: string,
		preferredLibraryId: string | null = null,
	): Promise<Fixture> {
		const token = await apiToken(request);
		const headers = { Authorization: `Bearer ${token}` };
		const services: { id: string; name: string }[] = [];

		try {
			for (const [index, baseUrl] of SOURCE_ADDRESSES.entries()) {
				const label = `Journey source ${index + 1}`;
				const created = await request.post(`${API_URL}/services`, {
					headers,
					data: { name: label, type: 'jellyfin', shared: false, baseUrl },
				});
				expect(created.ok(), `create failed: ${created.status()} ${await created.text()}`).toBeTruthy();
				services.push({ id: (await created.json()).id as string, name: label });
			}

			const plan = await request.post(`${API_URL}/sync/plans`, {
				headers,
				data: {
					name,
					enabled: false,
					trigger: 'schedule',
					schedule: '0 4 * * *',
					sourceServiceIds: services.map(one => one.id),
					preferredLibraryId,
					scope: { rootItemIds: [NOWHERE] },
					filter: {
						kinds: ['movie'],
						missingOnly: false,
						replaceOutdated: true,
						minYear: 2010,
						maxBytes: 8 * 1024 ** 3,
						titleMatches: 'journey',
					},
					maxItemsPerRun: 5,
					maxBytesPerRun: 1024 ** 3,
				},
			});
			expect(plan.ok(), `create failed: ${plan.status()} ${await plan.text()}`).toBeTruthy();

			return { token, planId: (await plan.json()).id as string, services, name };
		} catch (error) {
			await removeAll(request, token, null, services.map(one => one.id));
			throw error;
		}
	}

	async function tearDown (request: APIRequestContext, fixture: Fixture): Promise<void> {
		await removeAll(request, fixture.token, fixture.planId, fixture.services.map(one => one.id));
	}

	async function readPlan (request: APIRequestContext, fixture: Fixture) {
		const read = await request.get(`${API_URL}/sync/plans/${fixture.planId}`, {
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		return await read.json() as {
			name: string;
			schedule: string | null;
			sourceServiceIds: string[];
			preferredLibraryId: string | null;
			maxItemsPerRun: number | null;
			maxBytesPerRun: number | null;
			filter: { kinds?: string[] };
			scope: { rootItemIds?: string[] };
		};
	}

	test.beforeEach(async ({ page }) => {
		await signIn(page);
	});

	test('it is reached from the list and carries everything the plan holds', async ({ page, request }) => {
		const failures = watchApi(page);
		const fixture = await setUp(request, 'Journey plan · round trip');

		try {
			// A fresh load, after the fixture exists: the ordinary way somebody arrives.
			// The other way — a tab opened before the sources were registered — is a
			// defect of its own, pinned down by the next journey.
			await page.goto('/sync');
			await expect(page.locator(test0('plan-list'))).toBeVisible();

			const row = page.locator(test0('plan-row')).filter({ hasText: fixture.name });
			await row.locator(test0('plan-edit')).click();

			await expect(page).toHaveURL(new RegExp(`/sync/plans/${fixture.planId}`));
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			await expect(page.locator(field0('plan-name'))).toHaveValue(fixture.name);
			await expect(page.locator(field0('plan-schedule'))).toHaveValue('0 4 * * *');
			await expect(page.locator(field0('plan-root'))).toHaveValue(NOWHERE);
			await expect(page.locator(field0('plan-min-year'))).toHaveValue('2010');
			// The field takes `8G` and the plan holds 8589934592; showing the byte count
			// back is how a limit ends up an order of magnitude out on the next edit.
			await expect(page.locator(field0('plan-max-bytes'))).toHaveValue('8G');
			await expect(page.locator(field0('plan-title-matches'))).toHaveValue('journey');
			await expect(page.locator(field0('plan-max-items-per-run'))).toHaveValue('5');
			await expect(page.locator(field0('plan-max-bytes-per-run'))).toHaveValue('1G');

			await expect(page.locator(field0('plan-enabled'))).not.toBeChecked();
			await expect(page.locator(field0('plan-missing-only'))).not.toBeChecked();
			await expect(page.locator(field0('plan-replace-outdated'))).toBeChecked();

			// Sources are an ordered list, and the order is the whole content of the
			// field: the same two servers the other way round is a different plan.
			const sources = page.locator(test0('plan-source'));
			await expect(sources).toHaveCount(2);
			await expect(sources.nth(0)).toContainText(fixture.services[0].name);
			await expect(sources.nth(1)).toContainText(fixture.services[1].name);

			await page.waitForLoadState('networkidle');
			expect(failures, failures.join('\n')).toHaveLength(0);
		} finally {
			await tearDown(request, fixture);
		}
	});

	/**
	 * A source registered after the tab was opened, and the plan that names it.
	 *
	 * This journey found a defect the first time it ran: both plan screens loaded the
	 * services only when the store had never been loaded, so a server registered after
	 * the application was opened — by another administrator, from a phone, or by this
	 * very journey after signing in — was shown on a plan as a raw identifier, and was
	 * not offered under "Add a source" until a full reload. A raw identifier on screen
	 * is read as corruption. Both halves of the fix are checked: entering the page asks
	 * again, and a page already open hears about a new server on the event stream.
	 */
	test('a source registered after the tab was opened is named on the plan, and offered', async ({ page, request }) => {
		// Signed in by `beforeEach` already, so the application has read the services
		// before these exist — exactly the order somebody meets in real use.
		const fixture = await setUp(request, 'Journey plan · late source');
		let lateId: string | null = null;

		try {
			await page.locator(test0('nav-sync')).click();
			await expect(page.locator(test0('plan-list'))).toBeVisible();
			const row = page.locator(test0('plan-row')).filter({ hasText: fixture.name });
			await row.locator(test0('plan-edit')).click();
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			await expect(page.locator(test0('plan-source')).nth(0)).toContainText(fixture.services[0].name);
			await expect(page.locator(test0('plan-source')).nth(1)).toContainText(fixture.services[1].name);

			// And with the page open, a server registered elsewhere — another tab,
			// here the API — reaches the menu without anybody reloading anything.
			const late = await request.post(`${API_URL}/services`, {
				headers: { Authorization: `Bearer ${fixture.token}` },
				data: { name: 'Journey source late', type: 'jellyfin', shared: false, baseUrl: LATE_ADDRESS },
			});
			expect(late.ok(), `create failed: ${late.status()} ${await late.text()}`).toBeTruthy();
			lateId = (await late.json()).id as string;

			await page.locator(test0('plan-add-source')).click();
			await expect(page.locator(`[data-test="plan-add-source-option"][data-value="${lateId}"]`))
				.toBeVisible();
		} finally {
			await tearDown(request, fixture);
			if (lateId) {
				await request.delete(`${API_URL}/services/${lateId}`, {
					headers: { Authorization: `Bearer ${fixture.token}` },
				});
			}
		}
	});

	/**
	 * Every subtree a plan covers survives an edit of the one the form shows.
	 *
	 * Keeping a second show in sync from its own page adds a root to the plan that
	 * already covers the first, and the form edits one root. It used to rebuild the
	 * scope from that one field on every save, so renaming such a plan silently stopped
	 * it covering every show but the first.
	 */
	test('a plan covering several subtrees keeps all of them through an edit', async ({ page, request }) => {
		const fixture = await setUp(request, 'Journey plan · several roots');
		const second = '00000000-0000-4000-8000-000000000e2f';

		try {
			await request.patch(`${API_URL}/sync/plans/${fixture.planId}`, {
				headers: { Authorization: `Bearer ${fixture.token}` },
				data: { scope: { rootItemIds: [NOWHERE, second] } },
			});

			await page.goto(`/sync/plans/${fixture.planId}`);
			await expect(page.locator(test0('plan-form'))).toBeVisible();
			await expect(page.locator(field0('plan-root'))).toHaveValue(NOWHERE);
			// Said on the screen, so nobody concludes the plan covers one show.
			await expect(page.locator(test0('plan-root-more'))).toContainText('1');

			await page.locator(field0('plan-name')).fill('Journey plan · several roots, renamed');
			await page.locator(test0('plan-save')).click();
			await expect(page.locator(test0('notify'))).toBeVisible();

			expect((await readPlan(request, fixture)).scope).toEqual({ rootItemIds: [NOWHERE, second] });
		} finally {
			await tearDown(request, fixture);
		}
	});

	test('editing it writes what was changed and keeps the ceilings it was given', async ({ page, request }) => {
		const fixture = await setUp(request, 'Journey plan · edited');
		const renamed = 'Journey plan · edited twice';

		try {
			await page.goto(`/sync/plans/${fixture.planId}`);
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			await page.locator(field0('plan-name')).fill(renamed);
			// Reordering through the interface, because the arrows are the only way
			// anybody can express "consult the second one first".
			await page.locator(test0('plan-source')).nth(0).locator(test0('plan-source-down')).click();
			// And a kind added through the menu, by its value rather than its label.
			await page.locator(test0('plan-kinds')).click();
			await page.locator('[data-test="plan-kind-option"][data-value="episode"]').click();
			await page.keyboard.press('Escape');
			await page.locator(test0('plan-save')).click();
			await expect(page.locator(test0('notify'))).toBeVisible();

			const saved = await readPlan(request, fixture);

			expect(saved.name).toBe(renamed);
			expect(saved.sourceServiceIds).toEqual([fixture.services[1].id, fixture.services[0].id]);
			expect(new Set(saved.filter.kinds)).toEqual(new Set(['episode', 'movie']));
			expect(saved.schedule).toBe('0 4 * * *');

			// Untouched by this edit. A save that wiped them would look exactly like a
			// save that worked, and the plan would lose its ceiling silently.
			expect(saved.maxItemsPerRun, 'the per-run item ceiling was lost by an edit').toBe(5);
			expect(saved.maxBytesPerRun, 'the per-run byte ceiling was lost by an edit').toBe(1024 ** 3);

			// And the screen agrees with the gateway after a full reload, which is the
			// half of a round trip a store holding the answer in memory would fake.
			await page.reload();
			await expect(page.locator(field0('plan-name'))).toHaveValue(renamed);
			await expect(page.locator(test0('plan-source')).nth(0)).toContainText(fixture.services[1].name);
		} finally {
			await tearDown(request, fixture);
		}
	});

	/**
	 * The preferred destination, through the screen and back.
	 *
	 * The preference is only worth anything if it survives the plan being edited by
	 * somebody who never touched it — and changing it has to write the new library,
	 * not the one the page was opened with. It needs a library this gateway can
	 * really write into, so the journey makes one of its own.
	 */
	test('the destination preference survives a round trip, and changing it sticks', async ({ page, request }) => {
		const landing = await useOwnDestination(request, `plan-${journeyTag()}`);
		test.skip(landing === null, NO_LANDING);
		const own = landing as OwnDestination;
		let fixture: Fixture | null = null;

		try {
			fixture = await setUp(request, 'Journey plan · destination', own.libraryId);

			await page.goto(`/sync/plans/${fixture.planId}`);
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			// The select shows the library by the name the journey gave it, which is
			// fixture data rather than interface wording.
			await expect(page.locator(test0('plan-target'))).toContainText(own.libraryName);

			// Saved by somebody who only renamed it: the preference stays.
			await page.locator(field0('plan-name')).fill('Journey plan · destination kept');
			await page.locator(test0('plan-save')).click();
			await expect(page.locator(test0('notify'))).toBeVisible();
			expect((await readPlan(request, fixture)).preferredLibraryId).toBe(own.libraryId);

			// And changed on purpose: the new one is what is written.
			await page.locator(test0('plan-target')).click();
			await page.locator(`[data-test="plan-target-option"][data-library="${own.otherLibraryId}"]`).click();
			await page.locator(test0('plan-save')).click();
			await expect.poll(async () => (await readPlan(request, fixture!)).preferredLibraryId)
				.toBe(own.otherLibraryId);

			await page.reload();
			await expect(page.locator(test0('plan-target'))).toContainText(own.otherLibraryName);
		} finally {
			if (fixture) {
				await tearDown(request, fixture);
			}
			await own.release(request);
		}
	});

	/**
	 * The preview, and the button that stays grey.
	 *
	 * A preview is asked with exactly the body a run would take, so a preview holding
	 * nothing means a run would do nothing — and offering to start it anyway is how
	 * somebody ends up watching an empty queue wondering what they did wrong.
	 */
	test('the preview refuses to start a run with nothing in it', async ({ page, request }) => {
		const fixture = await setUp(request, 'Journey plan · preview');

		try {
			await page.goto(`/sync/plans/${fixture.planId}`);
			await expect(page.locator(test0('plan-form'))).toBeVisible();

			await page.locator(test0('plan-preview')).click();
			await expect(page.locator(test0('sync-preview'))).toBeVisible();

			// The scope names a subtree nothing holds, so there is nothing to pull.
			await expect(page.locator(test0('sync-preview')).locator(test0('empty-state'))).toBeVisible();
			await expect(page.locator(test0('sync-run'))).toBeDisabled();
		} finally {
			await tearDown(request, fixture);
		}
	});
});
