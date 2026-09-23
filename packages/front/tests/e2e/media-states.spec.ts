import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
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
 * A file on our disk that the media server has not indexed yet.
 *
 * Neither missing nor present, and both would be a lie somebody acts on. Calling it
 * missing is the bug the state was added for: a pull finished, the file was in the
 * right folder, every screen still offered to fetch it — so it was fetched again.
 * What this file checks is that the interface draws it as its own thing everywhere a
 * media is drawn: the badge and its words, the row among the episodes still missing,
 * the count that no longer includes it, and the filter that is supposed to find it.
 *
 * The landing is real. The journey serves a show from a media server of its own
 * (`fake-jellyfin.ts`), gives the gateway a library of its own to pull into, and
 * presses the button on the episode's page — the gateway downloads the bytes, moves
 * them into the fixture's directory and records the landing exactly as it would for
 * anybody. The fake server never indexes anything, so the landing stays waiting for
 * as long as the journey needs it to.
 *
 * Read in English on purpose, and against the catalogue rather than a sentence typed
 * here: the point is that the words on the badge are the words the catalogue has for
 * this state and not those it has for `missing`, and a rewording of either should
 * move this journey along with it rather than break it.
 */
test.use({ locale: 'en-US' });

const CATALOGUE = JSON.parse(readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), '../../src/locales/en.json'),
	'utf8',
)) as { sync: { state: Record<string, string> } };

const LABEL = CATALOGUE.sync.state;

/**
 * The grace the gateway under test was started with, when it was shortened.
 *
 * The journeys cannot ask the gateway — it is a test hook, not something any route
 * reports — so the runner sets the same variable on both sides. Unset here, the
 * `not_indexed` journey skips rather than wait twelve hours.
 */
const GRACE_MS = Number(process.env.MCS_LANDING_GRACE_MS ?? 0);

/** One row of a list, found by the media it opens rather than by a title somebody shares. */
function rowOf (page: Page, groupId: string): Locator {
	return page.locator(test0('media-row')).filter({
		has: page.locator(`a[href$="/library/${groupId}"]`),
	});
}

test.describe.serial('a media that has landed and is waiting to be indexed', () => {
	let fixture: MediaFixture;
	let destination: OwnDestination | null = null;

	test.beforeAll(async ({ request }) => {
		fixture = await createMediaFixture(request);
		destination = await useOwnDestination(request, `states-${fixture.tag}`);
	});

	test.afterAll(async ({ request }) => {
		await destination?.release(request);
		await fixture.remove(request);
	});

	test.beforeEach(() => {
		test.skip(
			destination === null,
			'no library this journey owns to pull into: the gateway cannot write where the '
			+ 'journey can create a directory — set E2E_LANDING_PATH to the gateway\'s view of it',
		);
	});

	/**
	 * From the page, with the button — the way it happens to somebody.
	 *
	 * What matters is the moment after: the page that offered the download a second ago
	 * must stop saying `missing`, or the next person to open it presses the button again.
	 */
	test('pulling an episode from its page lands it, and the page stops calling it missing', async ({ page, request }) => {
		const failures = watchApi(page);
		const episode = fixture.episodes[0];

		await signIn(page);
		await page.goto(`/library/${episode.id}`);

		const badge = page.locator(`.library-item_chips ${test0('sync-state')}`);
		await expect(badge).toHaveAttribute('data-state', 'missing');

		// Fetched from the row that holds it rather than from a button above the list:
		// a copy is what a transfer is about, and the header never knew which one.
		await page.locator(test0('group-source-download')).first().click();
		await expect(page.locator(test0('notify')).first()).toHaveAttribute('data-type', 'success');

		// The transfer runs behind a 202; what proves it landed is the state the gateway
		// now reports for the media, not a delay.
		await until(
			async () => {
				const read = await request.get(`${API_URL}/media/groups/${episode.id}`, {
					headers: await authorized(request),
				});
				return (await read.json() as { sync: string }).sync;
			},
			state => state === 'awaiting_index',
			'the pull never landed: the episode is not awaiting its index',
		);

		// And the bytes are where the gateway says, in the fixture's own directory —
		// never on somebody's shelf.
		const transfers = await request.get(`${API_URL}/transfers/unconfigured`, {
			headers: await authorized(request),
		});
		const placed = (await transfers.json() as { itemId: string; targetPath: string }[])
			.find(one => one.itemId === episode.sourceItemId);
		expect(placed, 'the pull left no placement behind').toBeTruthy();
		expect(placed!.targetPath.startsWith(destination!.path), placed!.targetPath).toBe(true);

		await page.reload();
		await expect(badge).toHaveAttribute('data-state', 'awaiting_index');
		// Labelled, and in the catalogue's words for this state: an unlabelled icon in
		// the place a `missing` badge sat reads as "still missing, different colour".
		await expect(badge).toHaveText(LABEL.awaiting_index);
		expect(LABEL.awaiting_index).not.toBe(LABEL.missing);

		// The download is no longer offered as if nothing had happened.
		await expect(page.locator(test0('item-sync-missing'))).toHaveCount(0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * One season, both states side by side — the comparison a glance actually makes.
	 *
	 * The row of the landed episode must not look like its missing neighbours: not the
	 * same icon, not the same emphasis, and not in the count of what is missing.
	 */
	test('the season draws it apart from the episodes still missing', async ({ page }) => {
		const failures = watchApi(page);
		const [landed, missing] = fixture.episodes;

		await signIn(page);
		await page.goto(`/library/${fixture.season.id}`);

		const landedRow = rowOf(page, landed.id);
		const missingRow = rowOf(page, missing.id);
		await expect(landedRow).toHaveAttribute('data-state', 'awaiting_index');
		await expect(missingRow).toHaveAttribute('data-state', 'missing');

		// Compared with each other rather than with icon names: what is under test is
		// that the two are told apart, and the shapes chosen for them may change.
		const iconOf = async (row: Locator): Promise<string> =>
			await row.locator(`${test0('sync-state')} .v-icon`).getAttribute('class') ?? '';
		expect(await iconOf(landedRow), 'the landed episode wears the missing icon')
			.not
			.toBe(await iconOf(missingRow));

		// The missing emphasis — dimmed, struck — belongs to the rows still to fetch.
		await expect(missingRow).toHaveClass(/media-row--missing/);
		await expect(landedRow).not.toHaveClass(/media-row--missing/);

		// Two missing out of three, not three: the count is what the "sync what is
		// missing" button offers, and counting a landed file there is the double pull.
		await expect(page.locator(test0('item-missing-count'))).toContainText('2');
		await expect(page.locator(test0('item-sync-missing'))).toContainText('2');

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * The filter is how somebody asks "what have I downloaded that is not showing up".
	 *
	 * Here at the level the gateway answers — episodes, named as such — which proves
	 * the state is filterable at all and that the wall draws it with its own state.
	 */
	test('the state filter finds it among the episodes', async ({ page }) => {
		const failures = watchApi(page);
		const landed = fixture.episodes[0];

		await signIn(page);
		await page.goto('/library?states=awaiting_index&kind=episode&all=true');

		const card = page.locator(test0('media-card')).filter({
			has: page.locator(`a[href$="/library/${landed.id}"]`),
		});
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-state', 'awaiting_index');
		await expect(card.locator(test0('sync-state'))).toHaveText(LABEL.awaiting_index);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * The state and nothing else — the way a person uses the filter, and the address
	 * the dashboard's "downloaded, waiting" line sends them to.
	 *
	 * The wall shows whole media unless a kind is chosen, and a series is never itself
	 * `awaiting_index` — its episodes are. Before the gateway learnt to match a poster
	 * by what is beneath it, this screen said "nothing matches" while an episode had
	 * really landed. Films are whole media and were always found, which is how it hid.
	 */
	test('the state filter alone finds a show whose episode has landed', async ({ page }) => {
		const failures = watchApi(page);

		await signIn(page);
		await page.goto(`/library?states=awaiting_index&category=${fixture.showsCategoryKey}`);

		const series = page.locator(test0('media-card')).filter({
			has: page.locator(`a[href$="/library/${fixture.series.id}"]`),
		});
		await expect(
			series,
			'a wall filtered on awaiting_index shows nothing of a show whose episode has landed',
		).toBeVisible();

		// And only that show: its sibling film has landed nothing.
		await expect(page.locator(`a[href$="/library/${fixture.film.id}"]`)).toHaveCount(0);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * The terminal state: on the disk, and no media server ever took it.
	 *
	 * Reached by waiting out the grace period — which a gateway started with
	 * `MCS_LANDING_GRACE_MS` makes a matter of seconds, and which this journey is told
	 * through the same variable — and then letting a scan settle the landing, because
	 * a scan is the only thing that can say a file was not indexed. The fake server
	 * never indexes anything, so the file is exactly the case the state exists for.
	 *
	 * Last in the file on purpose: once stale, the landing no longer reads
	 * `awaiting_index`, which is what every journey above is about.
	 */
	test('a landing no server ever indexed reads never indexed, and the dashboard names it', async ({ page, request }) => {
		test.skip(
			!(GRACE_MS > 0 && GRACE_MS <= 120_000),
			'needs a gateway started with a short MCS_LANDING_GRACE_MS (seconds, not the default 12 h), '
			+ 'and the same variable set here',
		);
		test.setTimeout(GRACE_MS + 90_000);
		const failures = watchApi(page);
		const episode = fixture.episodes[0];
		const headers = await authorized(request);

		// Past the deadline the landing was given, and then a scan to act on it — asked
		// again until it has, because a scan answers 202 before it has reconciled.
		await new Promise(resolve => setTimeout(resolve, GRACE_MS + 1000));
		await until(
			async () => {
				await request.post(`${API_URL}/services/${fixture.serviceId}/scan`, { headers });
				const read = await request.get(`${API_URL}/media/groups/${episode.id}`, { headers });
				return (await read.json() as { sync: string }).sync;
			},
			state => state === 'not_indexed',
			'the landing never went stale: the episode does not read not_indexed',
		);

		await signIn(page);
		await page.goto(`/library/${episode.id}`);

		// Its own words — neither "missing", which would offer the same download again,
		// nor "resyncing", which would promise something that is not going to happen.
		const badge = page.locator(`.library-item_chips ${test0('sync-state')}`);
		await expect(badge).toHaveAttribute('data-state', 'not_indexed');
		await expect(badge).toHaveText(LABEL.not_indexed);
		expect(LABEL.not_indexed).not.toBe(LABEL.missing);
		expect(LABEL.not_indexed).not.toBe(LABEL.awaiting_index);

		// The one row of "needs attention" nothing else in the product reports: the
		// transfer succeeded, so there is no error anywhere else to find.
		await page.goto('/');
		const problem = page.locator(`${test0('dashboard-problem')}[href*="states=not_indexed"]`);
		await expect(problem).toBeVisible();
		await expect(problem).not.toContainText('dashboard.');

		// And it leads to what it counts: the show whose episode was never indexed.
		await problem.click();
		await expect(page).toHaveURL(/states=not_indexed/);
		await expect(page.locator(`a[href$="/library/${fixture.series.id}"]`).first()).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
