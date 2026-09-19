import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortCallerException, getCaller } from '@/libs/caller';
import { useTokenStore } from '@/stores/token';
import { createStoreContext } from './helpers';

/** Lets every pending microtask run, so a call has actually reached `fetch`. */
function flush (): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, 0); });
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
		expect(stub.mock.calls[0][0]).toBe('/api/health');
	});

	it('attaches the bearer when the session is valid', async () => {
		useTokenStore().store(session() as never);
		const stub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).get('/services');

		const headers = (stub.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer access-1');
		expect(headers['X-Locale']).toBe('en');
	});

	it('sends no bearer when the call opts out of authentication', async () => {
		useTokenStore().store(session() as never);
		const stub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).get('/auth/providers', { useAuth: false });

		const headers = (stub.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it('refreshes an expired access token before attaching it', async () => {
		const tokenStore = useTokenStore();
		tokenStore.store(session({ expiresIn: -60 }) as never);

		const stub = vi.fn((url: string) => {
			if (url === '/api/auth/refresh') {
				return Promise.resolve(new Response(JSON.stringify(session({ accessToken: 'access-2' })), { status: 200 }));
			}
			return Promise.resolve(new Response('{}', { status: 200 }));
		});
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).get('/services');

		expect(stub.mock.calls[0][0]).toBe('/api/auth/refresh');
		const headers = (stub.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer access-2');
	});

	it('serialises a body and declares its type', async () => {
		const stub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
		globalThis.fetch = stub as unknown as typeof fetch;

		await getCaller('api', context.pinia).post('/services', { name: 'attic' }, { useAuth: false });

		const init = stub.mock.calls[0][1] as RequestInit;
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
			.catch((thrown: unknown) => thrown);

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

		const first = caller.get('/search?q=a', { useAuth: false, abortKey: 'search' }).catch((e: unknown) => e);
		await flush();
		const second = caller.get('/search?q=ab', { useAuth: false, abortKey: 'search' }).catch((e: unknown) => e);
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
		const slow = caller.get('/page?p=1', { useAuth: false, keepLastKey: 'page' }).catch((e: unknown) => e);
		// Two calls started in the same millisecond cannot be ordered, and ordering
		// is the whole point of a keep-last key.
		await flush();
		const fast = caller.get('/page?p=2', { useAuth: false, keepLastKey: 'page' });

		await flush();
		// The newer call answers first, which is exactly the race this guards.
		resolvers[1](new Response('{"page":2}', { status: 200 }));
		await expect(fast).resolves.toEqual({ page: 2 });

		resolvers[0](new Response('{"page":1}', { status: 200 }));
		await expect(slow).resolves.toBeInstanceOf(AbortCallerException);
	});

	it('refuses to build a caller nobody registered', () => {
		expect(() => getCaller('nope', context.pinia)).toThrow(/not registered/);
	});
});
