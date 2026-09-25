import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortCallerException, getCaller } from '@/libs/caller';
import { useTokenStore } from '@/stores/token';
import { createStoreContext } from './helpers';

/** Reads one recorded `fetch` call; the mock's own tuple type says nothing useful. */
function callArgs (stub: { mock: { calls: unknown[][] } }, index: number): { url: string; init: RequestInit } {
	const call = stub.mock.calls[index] ?? [];
	return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

/** Lets every pending microtask run, so a call has actually reached `fetch`. */
function flush (): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 0);
	});
}

function session (overrides: Record<string, unknown> = {}) {
	return {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresIn: 900,
		user: { id: 'u1', username: 'ada' },
		rights: [],
		...overrides,
	};
}

/** Resolves only when the call is aborted, so an abort is observable. */
function neverResolvingFetch () {
	return vi.fn((_url: string, options: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
		options.signal?.addEventListener('abort', () => {
			reject(new DOMException('aborted', 'AbortError'));
		});
	}));
}

describe('Caller', () => {
	let context: ReturnType<typeof createStoreContext>;

	beforeEach(() => {
		context = createStoreContext();
	});

	it('prefixes the configured base URL', async () => {
		const stub = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		const result = await getCaller('api', context.pinia).get('/health', { useAuth: false });

		expect(result).toEqual({ ok: true });
		expect(callArgs(stub, 0).url).toBe('/api/health');
	});

	it('attaches the bearer when the session is valid', async () => {
		useTokenStore().store(session() as never);
		const stub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).get('/services');

		const headers = callArgs(stub, 0).init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer access-1');
		expect(headers['X-Locale']).toBe('en');
	});

	it('sends no bearer when the call opts out of authentication', async () => {
		useTokenStore().store(session() as never);
		const stub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).get('/auth/providers', { useAuth: false });

		const headers = callArgs(stub, 0).init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it('refreshes an expired access token before attaching it', async () => {
		const tokenStore = useTokenStore();
		tokenStore.store(session({ expiresIn: -60 }) as never);

		const stub = vi.fn((url: string) => {
			if (url === '/api/auth/refresh') {
				return Promise.resolve(Response.json(session({ accessToken: 'access-2' }), { status: 200 }));
			}
			return Promise.resolve(new Response('{}', { status: 200 }));
		});
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).get('/services');

		expect(callArgs(stub, 0).url).toBe('/api/auth/refresh');
		const headers = callArgs(stub, 1).init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer access-2');
	});

	/*
	 * The gateway checks the session on every authenticated request, so the client's own
	 * clock is not the only thing that can end one: a gateway restarted, a session
	 * revoked from another device, a clock a minute out. Refreshing on expiry answers
	 * none of those, and a 401 that nothing recovered from failed every screen until
	 * somebody reloaded the page — which reads as being signed out at random.
	 */
	it('renews the session and makes the call again when the gateway refuses it', async () => {
		const tokenStore = useTokenStore();
		tokenStore.store(session() as never);

		let refused = true;
		const stub = vi.fn((url: string) => {
			if (url === '/api/auth/refresh') {
				return Promise.resolve(Response.json(session({ accessToken: 'access-2' }), { status: 200 }));
			}

			if (refused) {
				refused = false;

				return Promise.resolve(new Response('{}', { status: 401 }));
			}

			return Promise.resolve(Response.json({ ok: true }, { status: 200 }));
		});
		globalThis.fetch = stub as unknown as typeof fetch;

		await expect(getCaller('api', context.pinia).get('/services')).resolves.toEqual({ ok: true });

		expect(callArgs(stub, 1).url).toBe('/api/auth/refresh');
		// The replay carries the new bearer, which is the whole point: the same call
		// with the same token would be refused again.
		expect((callArgs(stub, 2).init.headers as Record<string, string>).Authorization)
			.toBe('Bearer access-2');
	});

	it('gives up after one renewal rather than asking for ever', async () => {
		// A gateway answering 401 to everything — a signing key changed, an account
		// disabled — must cost one extra request and not a loop.
		const tokenStore = useTokenStore();
		tokenStore.store(session() as never);

		const stub = vi.fn((url: string) => Promise.resolve(
			url === '/api/auth/refresh'
				? Response.json(session({ accessToken: 'access-2' }), { status: 200 })
				: new Response('{}', { status: 401 }),
		));
		globalThis.fetch = stub as unknown as typeof fetch;

		const call = getCaller('api', context.pinia).get('/services', { silentError: true });

		await expect(call).rejects.toBeInstanceOf(Response);
		// The call, the refresh, the replay: three, and no fourth.
		expect(stub).toHaveBeenCalledTimes(3);
	});

	it('does not renew for a call that carries no bearer', async () => {
		// The refresh itself is such a call. Retrying it here would be a loop with the
		// one request that can end it in the middle.
		const stub = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		const call = getCaller('api', context.pinia).get('/health', { useAuth: false, silentError: true });

		await expect(call).rejects.toBeInstanceOf(Response);
		expect(stub).toHaveBeenCalledTimes(1);
	});

	it('serialises a body and declares its type', async () => {
		const stub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).post('/services', { name: 'attic' }, { useAuth: false });

		const init = callArgs(stub, 0).init;
		expect(init.method).toBe('POST');
		expect(init.body).toBe('{"name":"attic"}');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
	});

	it('throws the response itself when the API refuses', async () => {
		globalThis.fetch = vi.fn(() => Promise.resolve(
			new Response('{"statusCode":404,"message":"error.media.not_found"}', { status: 404 }),
		)) as unknown as typeof fetch;

		const error = await getCaller('api', context.pinia)
			.get('/media/nope', { useAuth: false, silentError: true })
			.catch((error_: unknown) => error_);

		expect(error).toBeInstanceOf(Response);
		expect((error as Response).status).toBe(404);
	});

	it('notifies the error observers unless the call asked for silence', async () => {
		const caller = getCaller('api', context.pinia);
		const seen: unknown[] = [];
		caller.errorObserver.subscribe((error: unknown) => seen.push(error));

		globalThis.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))) as unknown as typeof fetch;

		await caller.get('/a', { useAuth: false }).catch(() => undefined);
		expect(seen).toHaveLength(1);

		await caller.get('/b', { useAuth: false, silentError: true }).catch(() => undefined);
		expect(seen).toHaveLength(1);
	});

	it('aborts the call already in flight under the same abort key', async () => {
		const stub = neverResolvingFetch();
		globalThis.fetch = stub as unknown as typeof fetch;
		const caller = getCaller('api', context.pinia);

		const first = caller.get('/search?q=a', { useAuth: false, abortKey: 'search' }).catch((error: unknown) => error);
		await flush();
		const second = caller.get('/search?q=ab', { useAuth: false, abortKey: 'search' }).catch((error: unknown) => error);
		await flush();

		await expect(first).resolves.toBeInstanceOf(AbortCallerException);
		expect(await Promise.race([second, Promise.resolve('pending')])).toBe('pending');
	});

	it('calls onAbort when a call is replaced', async () => {
		globalThis.fetch = neverResolvingFetch() as unknown as typeof fetch;
		const caller = getCaller('api', context.pinia);
		const onAbort = vi.fn();

		const first = caller.get('/x', { useAuth: false, abortKey: 'k', onAbort }).catch(() => undefined);
		await flush();
		caller.get('/x', { useAuth: false, abortKey: 'k' }).catch(() => undefined);
		await first;

		expect(onAbort).toHaveBeenCalledOnce();
	});

	it('drops answers older than the last one under a keep-last key', async () => {
		const resolvers: ((value: Response) => void)[] = [];
		globalThis.fetch = vi.fn((_url: string, options: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
			resolvers.push(resolve);
			options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		})) as unknown as typeof fetch;

		const caller = getCaller('api', context.pinia);
		const slow = caller.get('/page?p=1', { useAuth: false, keepLastKey: 'page' }).catch((error: unknown) => error);
		await flush();
		const fast = caller.get('/page?p=2', { useAuth: false, keepLastKey: 'page' });

		await flush();
		// The newer call answers first, which is exactly the race this guards.
		resolvers[1](new Response('{"page":2}', { status: 200 }));
		await expect(fast).resolves.toEqual({ page: 2 });

		resolvers[0](new Response('{"page":1}', { status: 200 }));
		await expect(slow).resolves.toBeInstanceOf(AbortCallerException);
	});

	it('still drops the older answer when both calls start in the same millisecond', async () => {
		// Calls used to be ordered by `Date.now()`. Two started within one millisecond
		// shared a stamp, the older was neither aborted nor kept, and its answer arrived
		// anyway — so this suite failed whenever a fast runner happened to start both
		// in the same millisecond. The clock is frozen here to make that certain rather
		// than a matter of timing: the ordering must not depend on it at all.
		vi.spyOn(Date, 'now').mockReturnValue(1_758_000_000_000);

		const resolvers: ((value: Response) => void)[] = [];
		globalThis.fetch = vi.fn((_url: string, options: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
			resolvers.push(resolve);
			options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		})) as unknown as typeof fetch;

		const caller = getCaller('api', context.pinia);
		const slow = caller.get('/page?p=1', { useAuth: false, keepLastKey: 'page' }).catch((error: unknown) => error);
		const fast = caller.get('/page?p=2', { useAuth: false, keepLastKey: 'page' });

		await flush();
		resolvers[1](new Response('{"page":2}', { status: 200 }));
		await expect(fast).resolves.toEqual({ page: 2 });

		resolvers[0](new Response('{"page":1}', { status: 200 }));
		await expect(slow).resolves.toBeInstanceOf(AbortCallerException);

		vi.restoreAllMocks();
	});

	it('refuses to build a caller nobody registered', () => {
		expect(() => getCaller('nope', context.pinia)).toThrow(/not registered/);
	});
});
