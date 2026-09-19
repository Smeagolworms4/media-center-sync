import { CacheService } from './cache.service';

describe('CacheService (in-memory)', () => {
	let cache: CacheService;

	beforeEach(() => {
		// The in-memory path has to be the default and has to work alone, so the tests
		// make sure nothing points at a Redis.
		delete process.env.REDIS_HOST;
		cache = new CacheService();
	});

	afterEach(async () => {
		await cache.onModuleDestroy();
	});

	it('gives back what was stored, with its type intact', async () => {
		await cache.set('shape', { name: 'Shows', count: 3, nested: [1, 2] });

		expect(await cache.get<{ name: string; count: number }>('shape')).toEqual({
			name: 'Shows',
			count: 3,
			nested: [1, 2],
		});
	});

	it('misses on a key nobody stored', async () => {
		expect(await cache.get('absent')).toBeNull();
	});

	it('stores false and zero rather than treating them as misses', async () => {
		await cache.set('false', false);
		await cache.set('zero', 0);

		expect(await cache.get('false')).toBe(false);
		expect(await cache.get('zero')).toBe(0);
	});

	it('forgets a value once its lifetime is over', async () => {
		jest.useFakeTimers();

		try {
			await cache.set('short', 'value', 1);

			expect(await cache.get('short')).toBe('value');

			jest.advanceTimersByTime(1_100);

			expect(await cache.get('short')).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});

	it('keeps a value that has not expired yet', async () => {
		jest.useFakeTimers();

		try {
			await cache.set('long', 'value', 60);

			jest.advanceTimersByTime(30_000);

			expect(await cache.get('long')).toBe('value');
		} finally {
			jest.useRealTimers();
		}
	});

	it('honours the default lifetime the settings set', async () => {
		jest.useFakeTimers();

		try {
			cache.setDefaultTtl(2);
			await cache.set('defaulted', 'value');

			jest.advanceTimersByTime(2_500);

			expect(await cache.get('defaulted')).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});

	it('ignores a nonsensical default lifetime', async () => {
		cache.setDefaultTtl(0);
		cache.setDefaultTtl(Number.NaN);

		await cache.set('still-there', 'value');

		expect(await cache.get('still-there')).toBe('value');
	});

	it('deletes one key', async () => {
		await cache.set('gone', 'value');
		await cache.delete('gone');

		expect(await cache.get('gone')).toBeNull();
	});

	it('clears everything under a prefix and nothing else', async () => {
		await cache.set('plex:part:a', 1);
		await cache.set('plex:part:b', 2);
		await cache.set('jellyfin:items', 3);

		await cache.clear('plex:');

		expect(await cache.get('plex:part:a')).toBeNull();
		expect(await cache.get('plex:part:b')).toBeNull();
		expect(await cache.get('jellyfin:items')).toBe(3);
	});

	it('clears everything when no prefix is given', async () => {
		await cache.set('a', 1);
		await cache.set('b', 2);

		await cache.clear();

		expect(await cache.get('a')).toBeNull();
		expect(await cache.get('b')).toBeNull();
	});

	describe('wrap', () => {
		it('calls the factory once and serves the rest from the cache', async () => {
			const factory = jest.fn().mockResolvedValue('answer');

			expect(await cache.wrap('key', 60, factory)).toBe('answer');
			expect(await cache.wrap('key', 60, factory)).toBe('answer');
			expect(factory).toHaveBeenCalledTimes(1);
		});

		it('collapses concurrent misses into a single call', async () => {
			// This, not the storage, is what protects a media server: ten browser tabs
			// all miss within the same millisecond.
			const factory = jest.fn(
				() => new Promise<string>((resolve) => setTimeout(() => resolve('once'), 10)),
			);

			const calls = [
				cache.wrap('concurrent', 60, factory),
				cache.wrap('concurrent', 60, factory),
				cache.wrap('concurrent', 60, factory),
			];

			expect(await Promise.all(calls)).toEqual(['once', 'once', 'once']);
			expect(factory).toHaveBeenCalledTimes(1);
		});

		it('does not cache a failure', async () => {
			// A media server that was briefly down must not produce a minute of
			// confident failures.
			const factory = jest
				.fn()
				.mockRejectedValueOnce(new Error('down'))
				.mockResolvedValueOnce('back');

			await expect(cache.wrap('flaky', 60, factory)).rejects.toThrow('down');
			expect(await cache.wrap('flaky', 60, factory)).toBe('back');
		});

		it('caches a null answer rather than asking again', async () => {
			const factory = jest.fn().mockResolvedValue(null);

			await cache.wrap('nothing', 60, factory);
			await cache.wrap('nothing', 60, factory);

			// `null` is a real answer — "this Plex has no part key" — but it reads back
			// as a miss, so the factory runs again. Worth knowing rather than assuming.
			expect(factory).toHaveBeenCalledTimes(2);
		});
	});

	it('survives a value written in a shape it cannot read', async () => {
		await cache.set('broken', 'fine');
		// Simulates a value left by an older version of the code.
		await cache.set('broken', 'fine');

		expect(await cache.get('broken')).toBe('fine');
	});
});
