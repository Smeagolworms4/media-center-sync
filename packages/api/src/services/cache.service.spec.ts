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

	it('stores nothing at all for undefined', async () => {
		// `undefined` does not survive a round trip through JSON, and a caller storing
		// it is asking for a hole that reads back as a miss anyway — so it is refused
		// at the door rather than written as the string "undefined".
		await cache.set('nothing', undefined);

		expect(await cache.get('nothing')).toBeNull();
	});

	it('forgets a key under the prefix that a factory is still filling', async () => {
		// The in-flight map is what collapses ten tabs into one request, and it has to
		// be cleared along with the values. Left behind, a caller arriving after an
		// invalidation is handed the answer to the question that was just invalidated —
		// a poster from before a rescan, served as though it were after one.
		let release = (): void => {};
		const held = new Promise<string>((resolve) => {
			release = () => {
				resolve('before');
			};
		});
		const first = jest.fn(() => held);
		const second = jest.fn(async () => 'after');

		const pending = cache.wrap('plex:part:1', 60, first);

		// The entry is registered only once the read that missed has come back, which
		// takes more than one turn of the loop.
		await new Promise((resolve) => setImmediate(resolve));
		await cache.clear('plex:');

		// Without the clear this call would join the first and answer `before`, which
		// is the stale answer the invalidation was for.
		expect(await cache.wrap('plex:part:1', 60, second)).toBe('after');
		expect(second).toHaveBeenCalledTimes(1);

		release();
		await pending;
	});

	it('releases the memory of a key nobody ever reads again', async () => {
		// Expiry is checked on read as well, so this sweep is the only thing standing
		// between a gateway left running for a month and a map full of entries that
		// expired weeks ago. Its effect is invisible from the outside by definition —
		// a read would have expired the entry anyway — so the store is inspected.
		jest.useFakeTimers();

		// Built under the fake clock: the sweep is registered in the constructor, and
		// one built beforehand holds a real timer no amount of advancing will fire.
		const swept = new CacheService();

		try {
			const entries = (
				swept as unknown as { _backend: { _entries: Map<string, unknown> } }
			)._backend._entries;

			await swept.set('forgotten', 'value', 1);
			expect(entries.size).toBe(1);

			jest.advanceTimersByTime(60_000);

			expect(entries.size).toBe(0);
		} finally {
			await swept.onModuleDestroy();
			jest.useRealTimers();
		}
	});
});

/**
 * A Redis that answers badly, which is the state it is in when it matters.
 *
 * A cache that is down must not take the gateway with it: a miss is always a correct
 * answer, only a slower one. These are the paths where that promise is kept.
 */
describe('CacheService (a Redis that will not co-operate)', () => {
	let cache: CacheService;
	let store: Map<string, string>;

	beforeEach(() => {
		store = new Map();

		jest.resetModules();
		jest.doMock('ioredis', () => ({
			__esModule: true,
			default: class SickRedis {
				public async get(key: string): Promise<string | null> {
					if (key.includes('unreadable')) {
						throw new Error('connection refused');
					}

					return store.get(key) ?? null;
				}

				public async set(key: string): Promise<void> {
					if (key.includes('unwritable')) {
						throw new Error('read only replica');
					}
				}

				public async del(...keys: string[]): Promise<void> {
					for (const key of keys) {
						store.delete(key);
					}
				}

				public async scan(): Promise<[string, string[]]> {
					return ['0', []];
				}

				public async quit(): Promise<void> {}

				public on(): unknown {
					return this;
				}
			},
		}));

		process.env.REDIS_HOST = 'redis';

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

	it('answers a miss rather than throwing when the read fails', async () => {
		await expect(cache.get('unreadable')).resolves.toBeNull();
	});

	it('carries on when the write fails', async () => {
		await expect(cache.set('unwritable', 'value')).resolves.toBeUndefined();
	});

	it('drops a value it cannot parse instead of failing on it for ever', async () => {
		// Written by an older version of the code, or truncated. Keeping it would fail
		// the same way on every read until somebody flushed the cache by hand.
		store.set('mcs:stale', '{ not json');

		await expect(cache.get('stale')).resolves.toBeNull();
		expect(store.has('mcs:stale')).toBe(false);
	});
});

describe('CacheService (a Redis that cannot be built)', () => {
	afterEach(() => {
		delete process.env.REDIS_HOST;
		jest.dontMock('ioredis');
	});

	it('falls back to memory rather than refusing to start', async () => {
		// The driver is required rather than imported so a gateway with no Redis never
		// loads it at all — and a `REDIS_HOST` pointing at something unusable must cost
		// a warning, not the whole application.
		jest.resetModules();
		jest.doMock('ioredis', () => {
			throw new Error('module is not installed');
		});

		process.env.REDIS_HOST = 'redis';

		const { CacheService: Reloaded } = jest.requireActual<typeof import('./cache.service')>(
			'./cache.service',
		);
		const cache = new Reloaded();

		await cache.set('key', 'value');

		expect(await cache.get('key')).toBe('value');

		await cache.onModuleDestroy();
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
