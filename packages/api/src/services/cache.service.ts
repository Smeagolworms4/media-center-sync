import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * Default lifetime, overridden at boot from the `cacheTtlSeconds` setting.
 *
 * A minute is the compromise the setting exists to move: short enough that an
 * episode added a moment ago appears, long enough that ten browser tabs opening the
 * same series page cost one request to the media server instead of ten.
 */
const DEFAULT_TTL_SECONDS = 60;

/** How often the in-memory backend sweeps expired entries. */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * What a backend has to do. Values cross it as strings, already serialised.
 *
 * Keeping serialisation above this line means both backends store exactly the same
 * bytes, so moving a running gateway from memory to Redis cannot change what comes
 * back out — including the fact that a `Date` comes back as a string.
 */
interface CacheBackend {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlSeconds: number): Promise<void>;
	delete(key: string): Promise<void>;
	/** Everything, or everything under a prefix. */
	clear(prefix?: string): Promise<void>;
	dispose(): Promise<void>;
}

/** The slice of ioredis we use, so the dependency stays optional at runtime. */
interface RedisLike {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
	del(...keys: string[]): Promise<unknown>;
	scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
	quit(): Promise<unknown>;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
}

class MemoryBackend implements CacheBackend {
	private readonly _entries = new Map<string, { value: string; expiresAt: number }>();
	private readonly _sweep: NodeJS.Timeout;

	public constructor() {
		// Expiry is checked on read as well, so the sweep only exists to stop keys
		// nobody reads again from holding memory forever. `unref` keeps it from
		// pinning the process open, which would hang every test run.
		this._sweep = setInterval(() => this._evict(), SWEEP_INTERVAL_MS);
		this._sweep.unref?.();
	}

	public async get(key: string): Promise<string | null> {
		const entry = this._entries.get(key);

		if (!entry) {
			return null;
		}

		if (entry.expiresAt <= Date.now()) {
			this._entries.delete(key);

			return null;
		}

		return entry.value;
	}

	public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		this._entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
	}

	public async delete(key: string): Promise<void> {
		this._entries.delete(key);
	}

	public async clear(prefix?: string): Promise<void> {
		if (prefix === undefined) {
			this._entries.clear();

			return;
		}

		for (const key of this._entries.keys()) {
			if (key.startsWith(prefix)) {
				this._entries.delete(key);
			}
		}
	}

	public async dispose(): Promise<void> {
		clearInterval(this._sweep);
		this._entries.clear();
	}

	private _evict(): void {
		const now = Date.now();

		for (const [key, entry] of this._entries) {
			if (entry.expiresAt <= now) {
				this._entries.delete(key);
			}
		}
	}
}

class RedisBackend implements CacheBackend {
	public constructor(
		private readonly _redis: RedisLike,
		private readonly _prefix: string,
	) {}

	public async get(key: string): Promise<string | null> {
		return this._redis.get(this._prefix + key);
	}

	public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		// `EX` rather than a separate `EXPIRE`: two commands leave a window where a
		// crash between them produces a key that never expires.
		await this._redis.set(this._prefix + key, value, 'EX', Math.max(1, Math.round(ttlSeconds)));
	}

	public async delete(key: string): Promise<void> {
		await this._redis.del(this._prefix + key);
	}

	public async clear(prefix?: string): Promise<void> {
		// `SCAN` rather than `KEYS`: this runs against whatever Redis the person
		// already had, which may well be serving something else, and `KEYS` on a large
		// database blocks it for everybody.
		const pattern = `${this._prefix}${prefix ?? ''}*`;
		let cursor = '0';

		do {
			const [next, keys] = await this._redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);

			cursor = next;

			if (keys.length > 0) {
				await this._redis.del(...keys);
			}
		} while (cursor !== '0');
	}

	public async dispose(): Promise<void> {
		await this._redis.quit().catch(() => undefined);
	}
}

/**
 * A small typed cache with a lifetime, in memory or in Redis.
 *
 * In-process is the default and works alone, because the gateway is one container
 * on somebody's machine far more often than it is a cluster. A Redis or Valkey is
 * picked up when `REDIS_SOCKET` or `REDIS_HOST` is set — the production image starts
 * one on a socket under `/data` and exports the path — and that is the only
 * difference between the two deployments: nothing above this class knows which one
 * it is talking to.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
	private readonly _logger = new Logger(CacheService.name);
	private readonly _backend: CacheBackend;

	/**
	 * Calls in flight, so concurrent misses on one key produce one call.
	 *
	 * This, not the storage, is what actually protects a media server: ten tabs
	 * opening at once all miss the cache within the same millisecond, and without
	 * this they all ask Jellyfin.
	 */
	private readonly _inFlight = new Map<string, Promise<unknown>>();

	private _defaultTtl = DEFAULT_TTL_SECONDS;

	public constructor() {
		this._backend = this._createBackend();
	}

	/** Called once the settings are readable; before that the default stands. */
	public setDefaultTtl(seconds: number): void {
		if (Number.isFinite(seconds) && seconds > 0) {
			this._defaultTtl = seconds;
		}
	}

	public async get<T>(key: string): Promise<T | null> {
		const raw = await this._backend.get(key).catch((error: unknown) => {
			// A cache that is down must not take the gateway with it: a miss is always
			// a correct answer, only a slower one.
			this._logger.warn(`Cache read failed for "${key}": ${String(error)}`);

			return null;
		});

		if (raw === null) {
			return null;
		}

		try {
			return JSON.parse(raw) as T;
		} catch {
			// A value written by an older version of the code, or truncated. Dropping
			// it is safe; keeping it would fail the same way on every read.
			await this.delete(key);

			return null;
		}
	}

	public async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
		// `undefined` does not survive a round trip through JSON, and a caller storing
		// it is asking for a hole that reads back as a miss anyway.
		if (value === undefined) {
			return;
		}

		await this._backend
			.set(key, JSON.stringify(value), ttlSeconds ?? this._defaultTtl)
			.catch((error: unknown) => {
				this._logger.warn(`Cache write failed for "${key}": ${String(error)}`);
			});
	}

	public async delete(key: string): Promise<void> {
		this._inFlight.delete(key);

		await this._backend.delete(key).catch(() => undefined);
	}

	/** Drops everything, or everything under a prefix — `plex:part:` after a rescan. */
	public async clear(prefix?: string): Promise<void> {
		for (const key of this._inFlight.keys()) {
			if (prefix === undefined || key.startsWith(prefix)) {
				this._inFlight.delete(key);
			}
		}

		await this._backend.clear(prefix).catch(() => undefined);
	}

	/**
	 * Read through: the cached value, or the factory's, stored for next time.
	 *
	 * A factory that throws is not cached — a media server that was briefly down must
	 * not produce a minute of confident failures — and the in-flight entry is dropped
	 * so the next caller retries rather than awaiting a rejected promise.
	 */
	public async wrap<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
		const cached = await this.get<T>(key);

		if (cached !== null) {
			return cached;
		}

		const pending = this._inFlight.get(key) as Promise<T> | undefined;

		if (pending) {
			return pending;
		}

		const promise = factory()
			.then(async (value) => {
				await this.set(key, value, ttlSeconds);

				return value;
			})
			.finally(() => {
				this._inFlight.delete(key);
			});

		this._inFlight.set(key, promise);

		return promise;
	}

	public async onModuleDestroy(): Promise<void> {
		await this._backend.dispose();
	}

	private _createBackend(): CacheBackend {
		// The socket wins over the host: the production image starts a Valkey of its
		// own and exports `REDIS_SOCKET`, and a deployment that also carries a
		// `REDIS_HOST` left over from an earlier compose file must reach the cache that
		// is actually running rather than the one that used to be.
		const socket = process.env.REDIS_SOCKET;
		const host = process.env.REDIS_HOST;

		if (!socket && !host) {
			return new MemoryBackend();
		}

		try {
			// Required rather than imported so that a gateway with no Redis never loads
			// the client at all, and so the in-memory path stays the one that works
			// with nothing installed beyond what the API already needs. A top-level
			// import would pull the driver into every process, including the one that
			// will never speak to a Redis.
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
			const { default: Redis } = require('ioredis') as {
				default: new (options: Record<string, unknown>) => RedisLike;
			};

			const redis = new Redis({
				// ioredis takes `path` and ignores `host`/`port` when both are given. The
				// two shapes stay mutually exclusive here anyway, so the options read the
				// way the connection behaves instead of relying on that precedence.
				...(socket ? { path: socket } : { host, port: Number(process.env.REDIS_PORT ?? 6379) }),
				password: process.env.REDIS_PASSWORD || undefined,
				db: Number(process.env.REDIS_DB ?? 0),
				lazyConnect: false,
				// Without this a Redis that is down turns every cached read into an
				// unhandled rejection storm instead of a miss.
				maxRetriesPerRequest: 1,
				enableOfflineQueue: false,
			});

			redis.on('error', (error: unknown) => {
				this._logger.warn(`Redis cache unavailable: ${String(error)}`);
			});

			this._logger.log(`Cache backed by Redis at ${socket || host}`);

			return new RedisBackend(redis, 'mcs:');
		} catch (error) {
			this._logger.warn(`Redis requested but unusable, falling back to memory: ${String(error)}`);

			return new MemoryBackend();
		}
	}
}
