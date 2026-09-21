import { existsSync } from 'node:fs';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import {
	authorized,
	createMediaFixture,
	type MediaFixture,
	type OwnDestination,
	until,
	useOwnDestination,
} from './fake-jellyfin';
import { API_URL, signIn, test0, watchApi } from './helpers';

/**
 * The home page, which is also the only screen that reports some things at all.
 *
 * Every tile is a link, because the figure is never the end of the thought: after
 * "seven missing" comes "which seven". So each journey here checks two things the
 * screen can get wrong independently — that a figure agrees with what the gateway
 * holds, and that following it lands somewhere that shows it.
 *
 * The zone of files placed by a step nobody chose is the part nothing else covers:
 * the transfer succeeded, so there is no error and no log line, and the library simply
 * grows a folder somebody did not plan. The journey makes one happen — a real pull
 * from a media server of its own into a library of its own, placed by the default
 * destination it pointed there — and then answers it from the dashboard the two ways
 * the zone offers: moving that file, and choosing where the category's next ones go.
 *
 * Everything is the journey's own and is removed afterwards (`fake-jellyfin.ts`). What
 * cannot be removed is the transfer row itself — there is no route that deletes one —
 * which is why the pull is one episode of a megabyte and not a season.
 */
interface Unconfigured {
	transferId: string;
	itemId: string;
	targetPath: string;
	targetLibraryId: string | null;
	categoryKey: string | null;
}

async function unconfigured (request: APIRequestContext): Promise<Unconfigured[]> {
	const response = await request.get(`${API_URL}/transfers/unconfigured`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `unconfigured failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Unconfigured[];
}

/** How many media the gateway counts in one state — the question each tile asks. */
async function countIn (request: APIRequestContext, state: string): Promise<number> {
	const response = await request.get(`${API_URL}/media?states=${state}&page=1&limit=1`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `count failed: ${response.status()}`).toBeTruthy();
	return (await response.json() as { pagination: { total: number } }).pagination.total;
}

async function lengthOf (request: APIRequestContext, path: string): Promise<number> {
	const response = await request.get(`${API_URL}${path}`, { headers: await authorized(request) });
	expect(response.ok(), `${path} failed: ${response.status()}`).toBeTruthy();
	return (await response.json() as unknown[]).length;
}

function valueOf (page: Page, tile: string): Locator {
	return page.locator(`${test0(tile)} ${test0('stat-tile-value')}`);
}

/*
 * Not serial, on purpose. The figures, the categories, the awaiting line and the zone
 * are separate promises the screen makes, and a defect in one must not hide whether
 * the others hold: in serial mode the first failure skips everything after it. A
 * failure restarts the worker, and the fixture is simply built again for the rest.
 */
test.describe('the dashboard', () => {
	let fixture: MediaFixture;
	let destination: OwnDestination | null = null;
	let placement: Unconfigured | null = null;

	test.beforeAll(async ({ request }) => {
		test.setTimeout(120_000);
		fixture = await createMediaFixture(request);
		destination = await useOwnDestination(request, `dash-${fixture.tag}`);

		if (destination === null) {
			return;
		}

		// The pull is not what this file checks — `media-states.spec.ts` presses that
		// button — so it goes through the API, and the journeys start from its result.
		const episode = fixture.episodes[0];
		const run = await request.post(`${API_URL}/sync/run`, {
			headers: await authorized(request),
			data: { scope: { itemIds: [episode.sourceItemId] } },
		});
		expect(run.ok(), `run failed: ${run.status()} ${await run.text()}`).toBeTruthy();

		const rows = await until(
			() => unconfigured(request),
			all => all.some(one => one.itemId === episode.sourceItemId),
			'the pull was never reported as placed by a step nobody chose',
		);
		placement = rows.find(one => one.itemId === episode.sourceItemId) ?? null;

		await until(
			async () => {
				const read = await request.get(`${API_URL}/media/groups/${episode.id}`, {
					headers: await authorized(request),
				});
				return (await read.json() as { sync: string }).sync;
			},
			state => state === 'awaiting_index',
			'the pulled episode never reached awaiting_index',
		);
	});

	test.afterAll(async ({ request }) => {
		// The release also takes back any category destination a journey below pointed
		// at the fixture's shelves — see `useOwnDestination`.
		await destination?.release(request);
		await fixture?.remove(request);
	});

	/**
	 * The figures, against what the gateway itself says, and where each one leads.
	 *
	 * Compared on a retry because this gateway is shared: another journey registering
	 * a service between the two reads is not a defect of this screen.
	 */
	test('counts what the gateway holds, and every tile leads to what it counts', async ({ page, request }) => {
		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/');

		await expect(async () => {
			await page.locator(test0('dashboard-refresh')).click();
			await expect(valueOf(page, 'tile-services'))
				.toHaveText(String(await lengthOf(request, '/services')));
			await expect(valueOf(page, 'tile-missing'))
				.toHaveText(String(await countIn(request, 'missing')));
			await expect(valueOf(page, 'tile-peers'))
				.toHaveText(String(await lengthOf(request, '/peers')));
		}).toPass({ timeout: 30_000 });

		// The fixture's own media are in that figure: two episodes, a season, a series
		// and a film of a server this gateway cannot reach, and never zero.
		expect(Number(await valueOf(page, 'tile-missing').textContent())).toBeGreaterThan(0);

		const links: [string, RegExp][] = [
			['tile-services', /\/services$/],
			['tile-missing', /\/library\?.*states=missing/],
			['tile-transfers', /\/transfers$/],
			['tile-peers', /\/peers$/],
		];
		for (const [tile, destinationUrl] of links) {
			await page.goto('/');
			await page.locator(test0(tile)).click();
			await expect(page, `${tile} leads nowhere it says`).toHaveURL(destinationUrl);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/** Every category, each one opening the wall on its own. */
	test('lists the categories, and opens the one clicked', async ({ page }) => {
		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/');

		const chip = page.locator(
			`${test0('dashboard-category')}[href*="category=${fixture.showsCategoryKey}"]`);
		await expect(chip).toBeVisible();
		// Five media under the show — the series, its season, three episodes — counted
		// the way the wall counts them.
		await expect(chip).toContainText(`Journey Shows ${fixture.tag}`);

		await chip.click();
		await expect(page).toHaveURL(new RegExp(`category=${fixture.showsCategoryKey}`));
		await expect(page.locator(`a[href$="/library/${fixture.series.id}"]`).first()).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * "Downloaded, waiting for the library to resync" — under the missing figure,
	 * because it answers the same question with "nothing, wait a moment".
	 */
	test('says what has landed and is waiting', async ({ page, request }) => {
		test.skip(placement === null, 'no library this journey owns to pull into — see useOwnDestination');
		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/');

		const line = page.locator(test0('tile-awaiting'));
		await expect(line).toBeVisible();
		await expect(line).toContainText(String(await countIn(request, 'awaiting_index')));
		await expect(line).not.toContainText('dashboard.');

		await line.locator('a').click();
		await expect(page).toHaveURL(/states=awaiting_index/);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * A line that counts it and a link that shows nothing are a screen contradicting
	 * itself — which is what this was, until the wall learnt to match a show by the
	 * state of the episodes beneath it.
	 */
	test('the awaiting line leads to what it counts', async ({ page }) => {
		test.skip(placement === null, 'no library this journey owns to pull into — see useOwnDestination');
		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/');

		await page.locator(`${test0('tile-awaiting')} a`).click();
		await expect(page).toHaveURL(/states=awaiting_index/);
		await expect(
			page.locator(`a[href$="/library/${fixture.series.id}"]`).first(),
			'the awaiting line counts a landed episode that the page it links to does not show',
		).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/** The zone's row for the fixture's pull, found by its transfer and nothing else. */
	function rowOfPlacement (page: Page): Locator {
		return page.locator(
			`${test0('dashboard-unconfigured-row')}[data-transfer="${placement!.transferId}"]`);
	}

	/**
	 * The file somebody did not plan, and why, in words about their own settings.
	 *
	 * "No destination is set for the category X" names the setting to change; the
	 * name of a placement step would leave them exactly where they were.
	 */
	test('lists a file placed by a step nobody chose, and says why', async ({ page }) => {
		test.skip(placement === null, 'no library this journey owns to pull into — see useOwnDestination');
		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/');

		await expect(page.locator(test0('dashboard-unconfigured'))).toBeVisible();

		const row = rowOfPlacement(page);
		await expect(row).toHaveCount(1);
		await expect(row).toHaveAttribute('data-placed-by', 'default_library');
		await expect(row).toContainText(destination!.libraryName);

		const reason = row.locator(test0('dashboard-unconfigured-reason'));
		await expect(reason).toContainText(`Journey Shows ${fixture.tag}`);
		await expect(reason).not.toContainText('transfer.unconfigured');

		// What "send it here from now on" also does, said before it is pressed: the
		// category is renamed after the library it is sent to.
		const renames = row.locator(test0('transfer-destination-renames'));
		await expect(renames).toBeVisible();
		await expect(renames).toContainText(`Journey Shows ${fixture.tag}`);
		await expect(renames).not.toContainText('transfer.unconfigured');

		// Nothing is chosen yet, so neither answer can be given yet: a button that looks
		// pressable and does nothing is the other way this zone could fail.
		await expect(row.locator(test0('transfer-destination-move'))).toBeDisabled();
		await expect(row.locator(test0('transfer-destination-remember'))).toBeDisabled();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * A file whose library is gone is no longer a decision anybody can make.
	 *
	 * Removing a service takes its libraries; the transfers that wrote into them stay,
	 * because they are history. Before, they also stayed in this zone for ever — no
	 * library, no category, nothing that could clear them — which is how a gateway
	 * accumulates rows nobody can act on. Its own pull and its own shelves, released
	 * halfway through, so the rest of the file is not disturbed.
	 *
	 * Before the journeys that answer the zone, because one of them sets a destination
	 * for the fixture's category, and a pull made after that is placed by a choice.
	 *
	 * The `not_indexed` row of "needs attention" is proven in `media-states.spec.ts`,
	 * where a landing is left in place long enough to go stale.
	 */
	test('stops offering a decision about a file whose library was removed', async ({ page, request }) => {
		test.setTimeout(90_000);
		const own = await useOwnDestination(request, `gone-${fixture.tag}`);
		test.skip(own === null, 'no library this journey owns to pull into — see useOwnDestination');

		const headers = await authorized(request);
		const episode = fixture.episodes[2];
		let released = false;

		try {
			const run = await request.post(`${API_URL}/sync/run`, {
				headers,
				data: { scope: { itemIds: [episode.sourceItemId] } },
			});
			expect(run.ok(), `run failed: ${run.status()}`).toBeTruthy();

			const rows = await until(
				() => unconfigured(request),
				all => all.some(one => one.itemId === episode.sourceItemId && one.targetLibraryId === own!.libraryId),
				'the second pull was never reported as placed by a step nobody chose',
			);
			const transferId = rows.find(one => one.itemId === episode.sourceItemId)!.transferId;

			await signIn(page);
			await page.goto('/');
			const row = page.locator(`${test0('dashboard-unconfigured-row')}[data-transfer="${transferId}"]`);
			await expect(row).toHaveCount(1);

			await own!.release(request);
			released = true;

			// Gone from the zone, on the screen and in the answer behind it…
			expect((await unconfigured(request)).map(one => one.transferId)).not.toContain(transferId);
			await page.locator(test0('dashboard-refresh')).click();
			await expect(row).toHaveCount(0);

			// …and still there as history.
			const kept = await request.get(`${API_URL}/transfers/${transferId}`, { headers });
			expect(kept.ok(), 'the transfer itself was deleted with its library').toBeTruthy();
		} finally {
			if (!released) {
				await own!.release(request);
			}
		}
	});
	/**
	 * Answering it for the next episode: a destination for the whole category.
	 *
	 * The file already on disk stays where it is — this answers "where do the next ones
	 * go" — and the row stays, so the move is still one click away.
	 *
	 * What is checked is the promise and not the storage: the gateway treats "this
	 * category goes to that library" as "this category *is* that library's", renames the
	 * category after its destination and moves the entry to the new key. So the proof
	 * is that the category the fixture's show now belongs to — whatever it is called —
	 * sends its next file to the library chosen here.
	 */
	test('sets where the category goes next, from the zone', async ({ page, request }) => {
		test.skip(placement === null, 'no library this journey owns to pull into — see useOwnDestination');
		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/');

		const row = rowOfPlacement(page);

		// Chosen by the library's name — a name this journey gave it, not a label of
		// ours — because every other entry of that menu is somebody's real shelf.
		await row.locator(test0('transfer-destination-library')).click();
		await page.getByRole('option').filter({ hasText: destination!.otherLibraryName }).click();

		await expect(row.locator(test0('transfer-destination-remember'))).toBeEnabled();
		await row.locator(test0('transfer-destination-remember')).click();
		await expect(page.locator(test0('notify')).first()).toHaveAttribute('data-type', 'success');

		const headers = await authorized(request);
		const libraries = await request.get(`${API_URL}/services/${fixture.serviceId}/libraries`, { headers });
		const shows = (await libraries.json() as { id: string; name: string }[])
			.find(one => one.name === `Journey Shows ${fixture.tag}`);
		const categories = await request.get(`${API_URL}/libraries/categories`, { headers });
		const category = (await categories.json() as { key: string; libraryIds: string[] }[])
			.find(one => one.libraryIds.includes(shows!.id));
		const read = await request.get(`${API_URL}/settings`, { headers });
		const targets = (await read.json() as { categoryTargets: Record<string, string> }).categoryTargets;

		expect(category, 'the show belongs to no category any more').toBeTruthy();
		expect(targets[category!.key], `no destination for ${category!.key}, where the show now is`)
			.toBe(destination!.otherLibraryId);

		// The file itself did not move: that would be a second, larger action nobody
		// asked for. And its row is still there to move it with.
		const still = (await unconfigured(request)).find(one => one.transferId === placement!.transferId);
		expect(still?.targetLibraryId).toBe(destination!.libraryId);
		await expect(row).toHaveCount(1);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/** Answering it for this file: moving the one already on the disk. */
	test('moves the file itself, from the zone', async ({ page, request }) => {
		test.skip(placement === null, 'no library this journey owns to pull into — see useOwnDestination');
		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/');

		const row = rowOfPlacement(page);
		await row.locator(test0('transfer-destination-library')).click();
		await page.getByRole('option').filter({ hasText: destination!.otherLibraryName }).click();
		await row.locator(test0('transfer-destination-move')).click();
		await expect(page.locator(test0('notify')).first()).toHaveAttribute('data-type', 'success');

		// Not merely a row rewritten: the bytes are on the other shelf, on the disk.
		const moved = await until(
			async () => {
				const read = await request.get(`${API_URL}/transfers/${placement!.transferId}`, {
					headers: await authorized(request),
				});
				return await read.json() as { targetPath: string };
			},
			transfer => transfer.targetPath.includes('/elsewhere/'),
			'the transfer still names the shelf it landed on',
		);
		const onOurSide = moved.targetPath.replace(
			destination!.path.replace(/\/landing$/, ''),
			destination!.localPath,
		);
		expect(existsSync(onOurSide), `no file at ${onOurSide}`).toBe(true);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
