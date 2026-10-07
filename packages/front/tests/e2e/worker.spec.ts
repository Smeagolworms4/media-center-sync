import { type APIRequestContext, expect, test } from '@playwright/test';
import { authorized, createMediaFixture, journeyTag, type MediaFixture, until } from './fake-jellyfin';
import { API_URL, signIn } from './helpers';

/**
 * The heavy pass, and the thread it runs on.
 *
 * `better-sqlite3` is synchronous. A correlation over a real catalogue does not slow this
 * gateway, it *stops* it — measured on the owner's: eight seconds to answer an API call
 * while a static file from the same proxy, in the same second, came back in a tenth of
 * one. The event loop was not busy; it was gone. So the pass runs on a worker thread,
 * which has no Nest container in it and builds the five objects it needs by hand.
 *
 * None of that can be proven by a unit test, and the reason is the point of this file:
 * the suite runs on `:memory:`, a database that belongs to the connection that opened
 * it, so a worker there would open its own, find an empty schema and correlate nothing —
 * which is why the pool refuses to delegate over one, and why the pass runs in process in
 * every unit run and is tested there. Only a stack with a real database has both halves.
 *
 * Three things, and they do not all prove the same amount — which was checked rather
 * than assumed, by making `WorkerPoolService._lookUp` answer null and running them
 * again:
 *
 * 1. **The gateway says it has a thread.** Red without one. This is the line that would
 *    have caught v0.26.0, an image that shipped unable to start because a file was not
 *    where the build expected it, with the whole suite green.
 * 2. **Two servers holding one film come back as one group.** Green either way, and
 *    worth keeping anyway: it is the correlation working, read back by the gateway over
 *    a second connection — a journal that cannot be shared would fail exactly here.
 *    What it is *not* is evidence about the thread.
 * 3. **The pass reports itself on the stream the screens read.** Red without the thread,
 *    and the only one of the three that is: progress under `job.progress` exists on the
 *    worker's path alone, because the in-process call passes no reporter at all.
 */
test.describe('the worker', () => {
	test('reports a thread of its own for the heavy passes', async ({ request }) => {
		const health = (await (await request.get(`${API_URL}/health`)).json()) as {
			checks: { name: string; ok: boolean; detail: string | null }[];
		};

		const worker = health.checks.find(one => one.name === 'worker');

		expect(worker, 'health should report a worker check at all').toBeTruthy();
		expect(
			worker?.ok,
			`the built image must have a worker to delegate to — ${worker?.detail ?? 'no detail'}`,
		).toBe(true);
	});

	test('folds two servers holding one film into one group, from the thread', async ({ request }) => {
		/*
		 * The same catalogue twice, which is the whole fixture.
		 *
		 * One tag, two servers: identical titles on two services the gateway reads as
		 * separate. Nothing but the correlation can bring those together, and the
		 * correlation runs on the worker — so a group with two sources is the thread's
		 * work, read back by the gateway.
		 */
		const tag = journeyTag();
		const fixtures: MediaFixture[] = [];

		/*
		 * Registered for teardown as it is created, never afterwards: the second scan can
		 * fail, and a fixture collected only once both exist would leave the first
		 * server running and its service on the gateway for every later journey to trip
		 * over.
		 */
		const add = async (): Promise<MediaFixture> => {
			const made = await createMediaFixture(request, tag);

			fixtures.push(made);

			return made;
		};

		try {
			const first = await add();
			const second = await add();
			const headers = await authorized(request);

			const group = await until(
				async () => {
					const listed = await request.get(
						`${API_URL}/media/groups?rootsOnly=false&limit=100&search=${encodeURIComponent(first.film.title)}`,
						{ headers },
					);

					const body = (await listed.json()) as {
						items: { id: string; title: string; sources: { serviceId: string }[] }[];
					};

					return body.items.find(one => one.title === first.film.title);
				},
				found => (found?.sources.length ?? 0) >= 2,
				'the correlation never joined the two copies of the film',
			);

			// Both services, under one group: the pass paired them and the gateway can see it.
			const services = new Set(group?.sources.map(one => one.serviceId));

			expect(services).toContain(first.serviceId);
			expect(services).toContain(second.serviceId);
		} finally {
			// Each fixture takes its own server and service away, whatever happened above.
			await teardown(request, fixtures);
		}
	});

	test('reports the pass from the thread, on the stream the screens read', async ({ page, request }) => {
		/*
		 * The one check here that cannot pass without a worker.
		 *
		 * A gateway running the pass on its own thread would still fold two copies into
		 * one group — just slowly, and while answering nothing. Progress under
		 * `job.progress` exists on the worker's path alone, because the in-process call
		 * passes no reporter, so a frame naming the correlation is the thread saying it
		 * did the work. Verified by removing the worker and watching this go red.
		 */
		const fixture = await createMediaFixture(request);

		try {
			const headers = await authorized(request);
			const opened = page.waitForEvent('websocket', {
				predicate: socket => socket.url().includes('/api/events'),
				timeout: 20_000,
			});

			await signIn(page);

			const socket = await opened;
			const correlating: unknown[] = [];

			socket.on('framereceived', frame => {
				try {
					const parsed = JSON.parse(frame.payload as string) as {
						event?: string;
						payload?: { kind?: string };
					};

					if (parsed.event === 'job.progress' && parsed.payload?.kind === 'correlate') {
						correlating.push(parsed.payload);
					}
				} catch {
					// A frame this journey has nothing to say about. The stream carries
					// everything every screen listens to, and most of it is not this.
				}
			});

			const scanned = await request.post(`${API_URL}/services/${fixture.serviceId}/scan`, { headers });

			expect(scanned.ok(), `rescan failed: ${scanned.status()}`).toBeTruthy();

			await until(
				async () => correlating.length,
				count => count > 0,
				'no correlation progress ever arrived: the pass did not run on a worker',
				45_000,
			);
		} finally {
			await fixture.remove(request);
		}
	});
});

async function teardown (request: APIRequestContext, fixtures: MediaFixture[]): Promise<void> {
	for (const fixture of fixtures) {
		await fixture.remove(request);
	}
}
