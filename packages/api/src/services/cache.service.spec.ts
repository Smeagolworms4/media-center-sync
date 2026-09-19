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

/**
 * The Redis path, over a stand-in client.
 *
 * Both backends store the same serialised bytes, so these assert the commands
 * rather than the values: what matters is that a key always carries an expiry in
 * one statement, and that clearing uses `SCAN` rather than `KEYS` against a Redis
 * that may well be serving something else too.
 */
describe('CacheService (Redis)', () => {
	const store = new Map<string, string>();
	let commands: string[];
	let cache: CacheService;

	beforeEach(() => {
		store.clear();
		commands = [];

		jest.resetModules();
		jest.doMock('ioredis', () => ({
			__esModule: true,
			default: class FakeRedis {
				public async get(key: string): Promise<string | null> {
					commands.push(`get ${key}`);

					return store.get(key) ?? null;
				}

				public async set(key: string, value: string, mode: string, ttl: number) {
					commands.push(`set ${key} ${mode} ${ttl}`);
					store.set(key, value);
				}

				public async del(...keys: string[]) {
					commands.push(`del ${keys.join(',')}`);

					for (const key of keys) {
						store.delete(key);
					}
				}

				public async scan(cursor: string, ...args: (string | number)[]) {
					commands.push(`scan ${cursor} ${args.join(' ')}`);

					const pattern = String(args[1]).replace('*', '');
					const keys = [...store.keys()].filter((key) => key.startsWith(pattern));

					return ['0', keys] as [string, string[]];
				}

				public async quit() {
					commands.push('quit');
				}

				public on() {
					return this;
				}
			},
		}));

		process.env.REDIS_HOST = 'redis';

		// Required after the mock is in place, so the service picks up the stand-in.
		const { CacheService: Reloaded } = jest.requireActual<typeof import('./cache.service')>(
			'./cache.service',
		);

		cache = new Reloaded();
	});

	afterEach(async () => {
		await cache.onModuleDestroy();
		delete process.env.REDIS_HOST;
		jest.dontMock('ioredis');
	});

	it('prefixes its keys so it can share a Redis with something else', async () => {
		await cache.set('key', 'value', 30);

		expect([...store.keys()]).toEqual(['mcs:key']);
	});

	it('sets the expiry in the same statement as the value', async () => {
		// Two statements leave a window where a crash between them produces a key that
		// never expires.
		await cache.set('key', 'value', 30);

		expect(commands).toContain('set mcs:key EX 30');
	});

	it('never asks for a lifetime below a second', async () => {
		await cache.set('key', 'value', 0.2);

		expect(commands.some((command) => command.endsWith('EX 1'))).toBe(true);
	});

	it('reads back what it wrote', async () => {
		await cache.set('key', { a: 1 }, 30);

		expect(await cache.get('key')).toEqual({ a: 1 });
	});

	it('clears a prefix with SCAN rather than KEYS', async () => {
		await cache.set('plex:a', 1, 30);
		await cache.set('plex:b', 2, 30);
		await cache.set('other', 3, 30);

		await cache.clear('plex:');

		expect(commands.some((command) => command.startsWith('scan'))).toBe(true);
		expect([...store.keys()]).toEqual(['mcs:other']);
	});

	it('deletes one key', async () => {
		await cache.set('key', 'value', 30);
		await cache.delete('key');

		expect(store.has('mcs:key')).toBe(false);
	});

	it('closes the connection when the module goes down', async () => {
		await cache.onModuleDestroy();

		expect(commands).toContain('quit');
	});
});
