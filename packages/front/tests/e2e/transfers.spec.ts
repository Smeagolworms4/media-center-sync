import { stat } from 'node:fs/promises';
import { type APIRequestContext, expect, type Page, type Route, test } from '@playwright/test';
import {
	authorized,
	createMediaFixture,
	journeyTag,
	type MediaFixture,
	type OwnDestination,
	until,
	useOwnDestination,
} from './fake-jellyfin';
import { API_URL, apiToken, signIn, test0, watchApi } from './helpers';

test.describe('transfers', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
		await page.locator(test0('nav-transfers')).click();
	});

	test('an empty queue says so instead of showing an empty frame', async ({ page }) => {
		// A fresh gateway has no transfers, and that is the first thing anybody sees.
		// A blank page here reads as a broken one.
		await expect(page.locator(test0('empty-state'))).toBeVisible();
	});

	test('the progress stream is connected', async ({ page }) => {
		// The stream is what every progress bar depends on. When it is refused — a
		// missing attach, a proxy that drops the upgrade — nothing errors: the page
		// renders, the queue is right, and the bars simply never move. Only the
		// handshake itself distinguishes that from an idle gateway.
		//
		// Matched on the URL, because in development the first socket a page opens is
		// Vite's own hot-reload channel. Taking whichever arrives first passes against
		// the wrong connection, and would keep passing with the event stream switched
		// off entirely.
		const opened = page.waitForEvent('websocket', {
			predicate: socket => socket.url().includes('/api/events'),
			timeout: 15_000,
		});

		await page.reload();

		const socket = await opened;

		expect(socket.isClosed()).toBe(false);
	});
});

/**
 * Which half of the queue the screen actually asked the gateway for.
 *
 * Read off the request rather than off the toggle: a Vuetify button group marks its
 * selection with a class and nothing else, and the `data-test` contract of this
 * folder exists so that journeys never depend on one. "Did picking Failed widen what
 * is queried" is answered by the query string and by nothing on the screen.
 */
function recordQueueQueries (page: Page): URL[] {
	const asked: URL[] = [];

	page.on('request', one => {
		const url = new URL(one.url());
		if (url.pathname.endsWith('/api/transfers')) {
			asked.push(url);
		}
	});

	return asked;
}

/**
 * The live half of the queue, and the finished half it hides.
 *
 * What shipped last night: the queue opens on what is still moving, because on a
 * gateway a month old the first page is all finished work and the one transfer
 * actually moving is on page four. That is only acceptable if the finished work is
 * *visibly* reachable — somebody who believes their history was destroyed does not
 * trust the next screen either. These run on any gateway, a seeded one included:
 * what they check is what the screen asks for and what it offers, not what is in it.
 */
test.describe('the live and finished halves of the queue', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page);
	});

	test('it opens on what is moving, and the finished work is one visible click away', async ({ page }) => {
		const failures = watchApi(page);
		const asked = recordQueueQueries(page);

		await page.goto('/transfers');
		await expect(page.locator(test0('transfer-stats'))).toBeVisible();
		await expect.poll(() => asked.at(-1)?.searchParams.get('view')).toBe('live');

		/*
		 * One of the two roads out is on the screen, whichever state the queue is in.
		 *
		 * A seeded gateway has nothing moving, so it is the button inside the empty
		 * state; a busy one has rows, and then the caption under them carries the same
		 * message. A live row cannot be held on demand — a fixture pull lands a fraction
		 * of a second after it starts — so the journey takes the road the gateway gives
		 * it. The one outcome it refuses is the one that shipped before: neither of them.
		 */
		const button = page.locator(test0('transfer-see-finished'));
		const caption = page.locator(test0('transfer-history-hint'));

		await expect(button.or(caption)).toBeVisible();

		await (await button.isVisible()
			? button.click()
			: page.locator(test0('transfer-view-finished')).click());

		await expect.poll(() => asked.at(-1)?.searchParams.get('view')).toBe('finished');

		// In the URL too, so a link somebody sends carries the half they were looking at.
		await expect(page).toHaveURL(/view=finished/);

		await page.locator(test0('transfer-view-all')).click();
		await expect.poll(() => asked.at(-1)?.searchParams.get('view')).toBe('all');

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * "Live" and "Failed" describe no transfer at all.
	 *
	 * The gateway answers that contradiction honestly, with an empty page — and an
	 * empty page right after somebody asked to see their failures is the unexplained
	 * blank this screen was changed to avoid. So picking a finished state has to widen
	 * the view rather than intersect with it.
	 */
	test('picking a finished state widens the view rather than showing an empty list', async ({ page }) => {
		const asked = recordQueueQueries(page);

		await page.goto('/transfers');
		await expect.poll(() => asked.at(-1)?.searchParams.get('view')).toBe('live');

		await page.locator(test0('transfer-state-filter')).click();
		await page.locator('[data-test="transfer-state-option"][data-value="failed"]').click();

		await expect.poll(() => asked.at(-1)?.searchParams.get('state')).toBe('failed');
		expect(asked.at(-1)?.searchParams.get('view'), 'a finished state was intersected with the live half')
			.toBe('all');

		// And from a link, which is how most people arrive at a filtered queue: a
		// notification, a message from whoever runs the gateway. The widening is
		// computed rather than triggered by the click, so it has to hold here too.
		await page.goto('/transfers?view=live&state=done');
		await expect.poll(() => asked.at(-1)?.searchParams.get('state')).toBe('done');
		expect(asked.at(-1)?.searchParams.get('view')).toBe('all');

		// A live state keeps the live half: the widening is for finished states only,
		// and doing it for everything would put the month of history back on page one.
		await page.goto('/transfers?view=live&state=paused');
		await expect.poll(() => asked.at(-1)?.searchParams.get('state')).toBe('paused');
		expect(asked.at(-1)?.searchParams.get('view')).toBe('live');
	});
});

/**
 * Sending a pull somewhere else.
 *
 * Two operations behind one button, which the interface must tell apart *before* the
 * click: a transfer that has not landed yet is re-pointed — one row write, nothing
 * copied, nothing interrupted — while one already in a library is really moved between
 * two filesystems, which can take three quarters of an hour on a season. The same
 * unqualified "move" for both is how somebody starts forty gigabytes of disk traffic
 * believing they corrected a form field.
 *
 * ## Why the queue here is served by the journey
 *
 * Everything else in this folder builds its fixtures through the gateway, and this is
 * the one place that cannot. A landed transfer can be produced for real, and is — see
 * "a landed file, really moved" below. The other two states cannot be held on
 * demand: a fixture file lands a fraction of a second after it starts, long before
 * anybody could open a dialog on it while it is still downloading, and `placing` lasts
 * the few seconds a real move takes. So the queue list and the libraries it offers are
 * answered by the journey — three transfers, one per state that matters, and three
 * libraries, one per reason a library can or cannot receive a file — and everything
 * else is the real gateway: the session, the page, the event stream, and the
 * destination route, whose refusal of a transfer it does not know is checked against
 * the gateway itself.
 *
 * What is under test is a decision the interface makes from a transfer's state and
 * a library's service, which is exactly what those responses carry. Nothing is
 * written anywhere, so there is nothing to take back.
 */
test.describe('changing where a pull lands', () => {
	const MINE = '00000000-0000-4000-8000-00000000a001';
	const FRIEND = '00000000-0000-4000-8000-00000000a002';

	/** Ours, mounted, writable: the one library that may be offered. */
	const OURS = '00000000-0000-4000-8000-00000000b001';
	/** On a friend's server: writable for them, never for us. */
	const THEIRS = '00000000-0000-4000-8000-00000000b002';
	/** Ours, but the path is wrong: a mistake somebody can go and fix. */
	const BROKEN = '00000000-0000-4000-8000-00000000b003';

	const DOWNLOADING = '00000000-0000-4000-8000-00000000c001';
	const LANDED = '00000000-0000-4000-8000-00000000c002';
	const PLACING = '00000000-0000-4000-8000-00000000c003';

	const now = new Date().toISOString();

	function service (id: string, name: string, mode: 'local' | 'remote') {
		return {
			id,
			name,
			type: 'jellyfin',
			shared: false,
			filesMounted: mode === 'local',
			baseUrl: 'http://127.0.0.1:1',
			status: 'online',
			version: null,
			mode,
			remoteRoot: null,
			localRoot: null,
		};
	}

	function library (id: string, serviceId: string, name: string, localPath: string | null, writable: boolean) {
		return {
			id,
			serviceId,
			externalId: id,
			name,
			alias: null,
			position: 100,
			kind: 'movies',
			paths: ['/media/movies'],
			localPath,
			writable,
			isDefaultTarget: false,
			itemCount: 0,
			lastScanAt: null,
			lastRefreshAt: null,
			createdAt: now,
			updatedAt: now,
		};
	}

	function transfer (id: string, title: string, state: string) {
		const landed = state === 'done';
		return {
			id,
			jobId: null,
			itemId: id,
			contentId: null,
			title,
			kind: 'movie',
			state,
			targetPath: `/srv/movies/${title}.mkv`,
			targetLibraryId: OURS,
			placedBy: null,
			bytesTotal: 1024 ** 3,
			bytesDone: landed ? 1024 ** 3 : 1024 ** 2,
			rate: 0,
			etaSeconds: null,
			sources: [],
			chunkSize: 1024 ** 2,
			chunksTotal: 1024,
			chunksDone: landed ? 1024 : 1,
			error: null,
			errorKind: null,
			chunksRepaired: 0,
			lastVerifiedAt: null,
			startedAt: now,
			finishedAt: landed ? now : null,
			createdAt: now,
			updatedAt: now,
		};
	}

	const QUEUE = [
		transfer(DOWNLOADING, 'Journey still downloading', 'downloading'),
		transfer(LANDED, 'Journey already landed', 'done'),
		transfer(PLACING, 'Journey being placed', 'placing'),
	];

	/** Every destination change the dialog asked of the gateway, and the body it sent. */
	interface Asked {
		transferId: string;
		body: { libraryId?: string };
	}

	async function serveQueue (page: Page): Promise<Asked[]> {
		const asked: Asked[] = [];

		await page.route(/\/api\//, async (route: Route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
			const json = (body: unknown) => route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(body),
			});

			if (request.method() === 'GET' && path === '/transfers') {
				return json({ items: QUEUE, pagination: { page: 1, limit: 20, total: QUEUE.length, pages: 1 } });
			}
			if (request.method() === 'GET' && path === '/transfers/stats') {
				return json({ active: 1, queued: 0, paused: 0, failed: 0, rate: 0, bytesRemaining: 0 });
			}
			if (request.method() === 'GET' && path === '/services') {
				return json([service(MINE, 'Journey mine', 'local'), service(FRIEND, 'Journey friend', 'remote')]);
			}
			if (request.method() === 'GET' && path === '/libraries') {
				return json([
					library(OURS, MINE, 'Journey films', '/srv/movies', true),
					library(THEIRS, FRIEND, 'Journey their films', null, true),
					library(BROKEN, MINE, 'Journey broken films', '/nowhere', false),
				]);
			}
			if (request.method() === 'GET' && path === '/libraries/check') {
				// The probe overrules the stored flag, which is the case this exists for:
				// a disk unmounted since the last scan. Claimed writable here and probed
				// unwritable, so the stored flag alone would have offered it.
				return json([
					{ libraryId: OURS, localPath: '/srv/movies', writable: true, exists: true, readable: true },
					{ libraryId: BROKEN, localPath: '/nowhere', writable: false, exists: false, readable: false },
				]);
			}

			const destination = /^\/transfers\/([^/]+)\/destination$/.exec(path);
			if (request.method() === 'POST' && destination) {
				asked.push({ transferId: destination[1], body: request.postDataJSON() });
				const moved = QUEUE.find(one => one.id === destination[1]);
				return json({ ...moved, targetLibraryId: OURS });
			}

			return route.fallback();
		});

		return asked;
	}

	test.beforeEach(async ({ page }) => {
		await signIn(page);
	});

	test('the dialog says whether it re-points or moves, before anything is pressed', async ({ page }) => {
		const asked = await serveQueue(page);

		await page.goto('/transfers');
		const downloading = page.locator('[data-test="transfer-row"][data-state="downloading"]');
		const landed = page.locator('[data-test="transfer-row"][data-state="done"]');
		await expect(downloading).toBeVisible();
		await expect(landed).toBeVisible();

		// Still downloading: re-pointing, which copies nothing.
		await downloading.locator(test0('transfer-retarget')).click();
		const hint = page.locator(test0('retarget-hint'));
		const confirm = page.locator(test0('retarget-confirm'));
		await expect(hint).toBeVisible();
		const repointHint = (await hint.textContent() ?? '').trim();
		const repointLabel = (await confirm.textContent() ?? '').trim();

		// Nothing is chosen yet, so nothing can be confirmed: a default target would be
		// a move nobody picked.
		await expect(confirm).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(hint).toBeHidden();

		// Already landed: really moving bytes, and saying so.
		await landed.locator(test0('transfer-retarget')).click();
		await expect(hint).toBeVisible();
		const moveHint = (await hint.textContent() ?? '').trim();
		const moveLabel = (await confirm.textContent() ?? '').trim();

		/*
		 * Compared with each other rather than with sentences.
		 *
		 * The wording is translated, and this suite is read in French on a French
		 * machine; spelling it out would break on the first improvement to it. What
		 * matters is the property: the two operations are never described alike —
		 * neither the explanation nor the button that commits to it.
		 */
		expect(repointHint).not.toBe('');
		expect(moveHint).not.toBe('');
		expect(moveHint, 'a move and a re-point are described with the same words').not.toBe(repointHint);
		expect(moveLabel, 'a move and a re-point are confirmed with the same button').not.toBe(repointLabel);

		await page.keyboard.press('Escape');
		expect(asked, 'closing the dialog asked the gateway to change something').toHaveLength(0);
	});

	test('only libraries this gateway can write into are offered, the rest named with the reason', async ({ page }) => {
		const asked = await serveQueue(page);

		await page.goto('/transfers');
		const landed = page.locator('[data-test="transfer-row"][data-state="done"]');
		await landed.locator(test0('transfer-retarget')).click();

		await page.locator(test0('retarget-library')).click();

		const options = page.locator('[data-test="retarget-option"]');
		await expect(options).toHaveCount(1);
		await expect(options).toHaveAttribute('data-library', OURS);

		// Both left out, each on its own line: a friend's shelf, and one of ours whose
		// folder cannot be written — two reasons fixed in two different places, which
		// is why the line has to say which.
		const rejected = page.locator(test0('retarget-rejected'));
		await expect(rejected).toHaveCount(2);
		await expect(rejected.filter({ hasText: 'Journey their films' })).toHaveCount(1);
		await expect(rejected.filter({ hasText: 'Journey broken films' })).toHaveCount(1);

		// And the two reasons are not the same sentence.
		const reasons = await rejected.evaluateAll(
			nodes => nodes.map(node => (node.textContent ?? '').split('—').at(-1)?.trim() ?? ''));
		expect(reasons[0]).not.toBe('');
		expect(reasons[0], 'two different reasons were given the same words').not.toBe(reasons[1]);

		// Choosing it is what commits, and the request names this transfer and that
		// library — nothing is re-planned and nothing starts over from its sources.
		await options.click();
		await page.locator(test0('retarget-confirm')).click();

		await expect.poll(() => asked.length).toBe(1);
		expect(asked[0]).toEqual({ transferId: LANDED, body: { libraryId: OURS } });
		await expect(page.locator(test0('notify'))).toBeVisible();
	});

	/**
	 * Being placed is the one moment a destination cannot change.
	 *
	 * The file is being copied into the library in that second, and the gateway refuses
	 * to re-point it then (`error.transfer.being_placed`) rather than leave half a film
	 * in each of two places. A button that can only answer "not now" is worse than no
	 * button — so it is absent, and it is absent *only* there.
	 */
	test('the control is absent while a file is being placed, and only then', async ({ page }) => {
		await serveQueue(page);

		await page.goto('/transfers');
		const placing = page.locator('[data-test="transfer-row"][data-state="placing"]');
		await expect(placing).toBeVisible();
		await expect(placing.locator(test0('transfer-retarget'))).toHaveCount(0);

		// Present on the others, so the absence is about the state and not about the
		// button having gone missing from the page altogether.
		await expect(page.locator('[data-test="transfer-row"][data-state="downloading"]')
			.locator(test0('transfer-retarget'))).toHaveCount(1);
		await expect(page.locator('[data-test="transfer-row"][data-state="done"]')
			.locator(test0('transfer-retarget'))).toHaveCount(1);
	});

	/**
	 * The one half of this that can be asked of the real gateway.
	 *
	 * The route the dialog calls exists, and refuses a transfer it does not hold by key
	 * rather than creating one or answering a sentence. Without it, the three journeys
	 * above could keep passing against a route that had been renamed away.
	 */
	test('the gateway refuses to re-point a transfer it does not hold, by key', async ({ request }) => {
		const token = await apiToken(request);
		const answered = await request.post(`${API_URL}/transfers/${DOWNLOADING}/destination`, {
			headers: { Authorization: `Bearer ${token}` },
			data: { libraryId: OURS },
		});

		expect(answered.status(), await answered.text()).toBe(404);
		expect((await answered.json()).message).toBe('error.transfer.not_found');
	});
});

/**
 * A landed file, really moved — the one thing in this area that had never been proven.
 *
 * Everything above checks what the dialog says. This checks that what it says is true:
 * a file the gateway pulled for real, sitting in a library for real, ends up in the
 * other library when somebody picks it, and is no longer in the first. It runs on a
 * seeded gateway too, because both ends are the journey's own — the source is the
 * in-process fake of `fake-jellyfin.ts`, serving a film of a size this file states,
 * and the two libraries are a directory the journey made and deletes.
 *
 * Never the lab, and never a media picked by position: a real server holds whatever
 * somebody last dropped into it, and "the first film" once meant eight gigabytes.
 */
test.describe('a landed file, really moved', () => {
	/** What `journeyCatalogue` serves for its film. Checked before a byte moves. */
	const FILM_BYTES = 4_194_304;

	interface Pulled {
		id: string;
		itemId: string;
		title: string;
		state: string;
		targetPath: string;
		targetLibraryId: string | null;
		error: string | null;
	}

	async function transferOf (request: APIRequestContext, itemId: string): Promise<Pulled | undefined> {
		const listed = await request.get(`${API_URL}/transfers?view=all&limit=100`, {
			headers: await authorized(request),
		});
		return ((await listed.json()).items as Pulled[]).find(one => one.itemId === itemId);
	}

	/** Where the gateway says a file is, as this process reaches the same directory. */
	function onOurSide (landing: OwnDestination, gatewayPath: string): string {
		const gatewayRoot = landing.path.replace(/\/landing$/, '');
		return gatewayPath.replace(gatewayRoot, landing.localPath);
	}

	async function exists (path: string): Promise<boolean> {
		return stat(path).then(() => true, () => false);
	}

	test.beforeEach(async ({ page }) => {
		await signIn(page);
	});

	test('moving a landed file puts it in the other library, and the screen said it would', async ({ page, request }) => {
		test.setTimeout(180_000);

		const tag = `move-${journeyTag()}`;
		const landing = await useOwnDestination(request, tag);
		test.skip(
			landing === null,
			'no library this journey owns to pull into: the gateway cannot write where the '
			+ 'journey can create a directory — set E2E_LANDING_PATH to the gateway\'s view of it',
		);
		const own = landing as OwnDestination;
		let media: MediaFixture | null = null;

		try {
			media = await createMediaFixture(request, tag);
			const film = media.film;
			const headers = await authorized(request);
			const body = { scope: { itemIds: [film.sourceItemId] }, targetLibraryId: own.libraryId };

			// The size first, asked of the planner itself: a wrong pick fails here in a
			// second rather than in ten minutes of copying something nobody meant.
			const preview = await (await request.post(`${API_URL}/sync/preview`, { headers, data: body })).json();
			expect(preview.itemsPlanned, 'the run would not pull exactly the fixture film').toBe(1);
			expect(preview.bytesPlanned, 'the run would pull something other than the fixture film')
				.toBe(FILM_BYTES);

			const ran = await request.post(`${API_URL}/sync/run`, { headers, data: body });
			expect(ran.ok(), `run failed: ${ran.status()} ${await ran.text()}`).toBeTruthy();

			const landed = await until(
				() => transferOf(request, film.sourceItemId),
				one => one?.state === 'done' || one?.state === 'failed',
				'the fixture film never finished landing',
				90_000,
			);
			expect(landed?.state, `the pull failed: ${landed?.error}`).toBe('done');
			expect(landed!.targetLibraryId).toBe(own.libraryId);

			const before = onOurSide(own, landed!.targetPath);
			expect(await exists(before), `the gateway says ${landed!.targetPath}, and nothing is there`).toBe(true);

			// Through the screen from here on: the finished half, the row, the dialog.
			await page.goto('/transfers?view=finished');
			const row = page.locator('[data-test="transfer-row"][data-state="done"]').filter({ hasText: film.title });
			await expect(row).toBeVisible();
			await row.locator(test0('transfer-retarget')).click();

			await expect(page.locator(test0('retarget-hint'))).toBeVisible();
			await page.locator(test0('retarget-library')).click();

			// Both of the journey's own libraries are offered; the fake server's shelves,
			// which this gateway only reads, are not.
			const offered = await page.locator('[data-test="retarget-option"]').evaluateAll(
				nodes => nodes.map(node => (node as HTMLElement).dataset.library));
			expect(offered).toContain(own.otherLibraryId);
			const libraries = await (await request.get(`${API_URL}/libraries`, { headers })).json();
			for (const theirs of (libraries as { id: string; serviceId: string }[])
				.filter(one => one.serviceId === media!.serviceId)) {
				expect(offered, 'a shelf this gateway only reads was offered as a destination')
					.not
					.toContain(theirs.id);
			}

			await page.locator(`[data-test="retarget-option"][data-library="${own.otherLibraryId}"]`).click();
			await page.locator(test0('retarget-confirm')).click();
			await expect(page.locator(test0('notify'))).toBeVisible();

			const moved = await until(
				() => transferOf(request, film.sourceItemId),
				one => one?.targetLibraryId === own.otherLibraryId && (one.state === 'done' || one.state === 'failed'),
				'the move never finished',
				60_000,
			);
			expect(moved?.state, `the move failed: ${moved?.error}`).toBe('done');

			// The bytes, not the row: the file is in the other library and no longer in
			// the first. A row that changed while the file stayed put is the lie this
			// whole dialog was written to avoid telling.
			const after = onOurSide(own, moved!.targetPath);
			expect(after).not.toBe(before);
			expect(await exists(after), `the gateway says ${moved!.targetPath}, and nothing is there`).toBe(true);
			expect((await stat(after)).size).toBe(FILM_BYTES);
			expect(await exists(before), 'the file was copied, and the original left behind').toBe(false);
		} finally {
			await media?.remove(request);
			await own.release(request);
		}
	});

	/**
	 * A transfer really being placed, refused by the gateway itself.
	 *
	 * The refusal while placing is the design point of this whole feature, and the
	 * journeys on the served queue above only prove the interface hides the control.
	 * Proving the gateway refuses needs a transfer held in `placing`, which on a
	 * same-filesystem gateway lasts one rename. `MCS_PLACING_HOLD_MS` — a test hook in the gateway's
	 * file mover, set on both sides by `make e2e/ci` — holds it open for a few seconds;
	 * without it this journey skips and says so.
	 */
	test('a transfer really being placed is refused by the gateway', async ({ request }) => {
		const hold = Number(process.env.MCS_PLACING_HOLD_MS ?? 0);
		test.skip(
			!(hold >= 1000),
			'needs a gateway started with MCS_PLACING_HOLD_MS of a second or more, and the same variable set here',
		);
		test.setTimeout(180_000);

		const tag = `placing-${journeyTag()}`;
		const landing = await useOwnDestination(request, tag);
		test.skip(
			landing === null,
			'no library this journey owns to pull into: the gateway cannot write where the '
			+ 'journey can create a directory — set E2E_LANDING_PATH to the gateway\'s view of it',
		);
		const own = landing as OwnDestination;
		let media: MediaFixture | null = null;

		try {
			media = await createMediaFixture(request, tag);
			const film = media.film;
			const headers = await authorized(request);

			const ran = await request.post(`${API_URL}/sync/run`, {
				headers,
				data: { scope: { itemIds: [film.sourceItemId] }, targetLibraryId: own.libraryId },
			});
			expect(ran.ok(), `run failed: ${ran.status()} ${await ran.text()}`).toBeTruthy();

			// Caught inside the hold, which is what the hook is for: polled well inside it.
			const placing = await until(
				() => transferOf(request, film.sourceItemId),
				one => ['placing', 'done', 'failed'].includes(one?.state ?? ''),
				'the fixture film never reached the library',
				90_000,
			);
			expect(placing?.state, 'the transfer went past `placing` before it could be asked').toBe('placing');

			const refused = await request.post(`${API_URL}/transfers/${placing!.id}/destination`, {
				headers,
				data: { libraryId: own.otherLibraryId },
			});
			expect(refused.status(), await refused.text()).toBe(409);
			expect((await refused.json()).message).toBe('error.transfer.being_placed');

			// And the refusal changed nothing: the file lands where it was going.
			const landed = await until(
				() => transferOf(request, film.sourceItemId),
				one => one?.state === 'done' || one?.state === 'failed',
				'the fixture film never finished landing',
				60_000,
			);
			expect(landed?.state, `the pull failed: ${landed?.error}`).toBe('done');
			expect(landed!.targetLibraryId, 'the refused request moved the file anyway').toBe(own.libraryId);
			expect(await exists(onOurSide(own, landed!.targetPath)), 'nothing is where the gateway says').toBe(true);
		} finally {
			await media?.remove(request);
			await own.release(request);
		}
	});
});
