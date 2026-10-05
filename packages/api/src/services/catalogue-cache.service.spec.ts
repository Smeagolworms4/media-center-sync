import { CacheRefreshReason, EventName } from '@mcs/shared';
import type { MediaMatchRepository } from '@/repositories';
import { CatalogueCacheService, COALESCE_MS } from './catalogue-cache.service';
import type { EventGatewayService } from './event-gateway.service';

interface Fakes {
	matches: { version: jest.Mock };
	events: { emit: jest.Mock };
}

const build = (): { cache: CatalogueCacheService; fakes: Fakes } => {
	const fakes: Fakes = {
		matches: { version: jest.fn().mockResolvedValue('7:2026-10-05') },
		events: { emit: jest.fn() },
	};

	return {
		cache: new CatalogueCacheService(
			fakes.matches as unknown as MediaMatchRepository,
			fakes.events as unknown as EventGatewayService,
		),
		fakes,
	};
};

/** The events the interface draws its spinner from, in the order they were sent. */
const states = (fakes: Fakes): { refreshing: boolean }[] =>
	fakes.events.emit.mock.calls
		.filter(([name]) => name === EventName.CACHE_STATE)
		.map(([, payload]) => payload as { refreshing: boolean });

const changes = (fakes: Fakes): number =>
	fakes.events.emit.mock.calls.filter(([name]) => name === EventName.CATALOGUE_CHANGED).length;

/**
 * Let the coalescing window elapse and wait for the pass it started.
 *
 * `refreshNow` returns the pass already in flight when there is one, which is the only
 * handle on it a caller is given — `schedule` deliberately returns nothing to await, so
 * a test cannot be handed the promise at the point it asks for the work.
 */
const settle = async (cache: CatalogueCacheService): Promise<void> => {
	jest.advanceTimersByTime(COALESCE_MS);

	await cache.refreshNow();
};

describe('CatalogueCacheService', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('refreshes away from the caller rather than on their clock', async () => {
		const { cache, fakes } = build();
		let ran = false;

		cache.onRefresh(() => {
			ran = true;

			return Promise.resolve(true);
		});

		cache.schedule(CacheRefreshReason.SCAN);

		// The whole point: scheduling returns having done nothing, so the scan that
		// asked for it is not holding the rebuild open.
		expect(ran).toBe(false);

		await settle(cache);

		expect(ran).toBe(true);
		expect(changes(fakes)).toBe(1);
	});

	it('rebuilds once for a scan that ends across four libraries', async () => {
		const { cache } = build();
		const refresher = jest.fn().mockResolvedValue(true);

		cache.onRefresh(refresher);

		for (let i = 0; i < 4; i += 1) {
			cache.schedule(CacheRefreshReason.SCAN);
		}

		await settle(cache);

		expect(refresher).toHaveBeenCalledTimes(1);
	});

	it('brackets the pass with a state the interface can draw', async () => {
		const { cache, fakes } = build();

		cache.onRefresh(() => Promise.resolve(true));
		cache.schedule(CacheRefreshReason.SCAN);
		await settle(cache);

		expect(states(fakes).map((state) => state.refreshing)).toEqual([true, false]);
	});

	it('tells nobody the catalogue changed when it did not', async () => {
		const { cache, fakes } = build();

		cache.onRefresh(() => Promise.resolve(false));
		await cache.refreshNow();

		expect(changes(fakes)).toBe(0);
		// The spinner still has to stop, which is the bug a bare early return would be.
		expect(states(fakes).map((state) => state.refreshing)).toEqual([true, false]);
	});

	it('stops the spinner when the rebuild throws', async () => {
		const { cache, fakes } = build();

		cache.onRefresh(() => Promise.reject(new Error('the table went away')));
		await cache.refreshNow();

		expect(states(fakes).map((state) => state.refreshing)).toEqual([true, false]);
		expect(changes(fakes)).toBe(0);
	});

	it('runs again for a request that arrived while a pass was in flight', async () => {
		const { cache } = build();
		let release = (): void => {};
		const refresher = jest
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<boolean>((resolve) => {
						release = (): void => resolve(true);
					}),
			)
			.mockResolvedValue(true);

		cache.onRefresh(refresher);

		const first = cache.refreshNow();

		// A scan finishing one second into the rebuild: the pass in flight read its pages
		// before this happened, so it cannot be the answer to it.
		cache.schedule(CacheRefreshReason.SCAN);
		release();
		await first;
		await settle(cache);

		expect(refresher).toHaveBeenCalledTimes(2);
	});

	it('survives a schedule that lands before anything registered', async () => {
		const { cache, fakes } = build();

		await cache.refreshNow();

		expect(states(fakes).map((state) => state.refreshing)).toEqual([true, false]);
		expect(changes(fakes)).toBe(0);
	});

	it('reports whether a pass is in flight, for a screen that just opened', async () => {
		const { cache } = build();
		let release = (): void => {};

		cache.onRefresh(
			() =>
				new Promise<boolean>((resolve) => {
					release = (): void => resolve(true);
				}),
		);

		expect(cache.refreshing).toBe(false);

		const pass = cache.refreshNow();

		expect(cache.refreshing).toBe(true);

		release();
		await pass;

		expect(cache.refreshing).toBe(false);
	});
});
