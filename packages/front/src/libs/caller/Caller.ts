import type { Pinia } from 'pinia';
import { SimpleObserver } from '@/libs/observer';
import { useI18nStore } from '@/stores/i18n';
import { useTokenStore } from '@/stores/token';

export interface CallerOptions extends Omit<RequestInit, 'body'> {
	/**
	 * Anything at all: `request` serialises a body that is not already a string.
	 *
	 * `RequestInit` only admits a `BodyInit`, which is narrower than what this class
	 * has always accepted — `post`, `put` and `patch` take their body as a separate
	 * `any` and sidestep it. `delete` has no such parameter, so a request that carries
	 * one (unlinking a peer, which says whether to ban them too) had nowhere to put it
	 * that typechecked, for a call the runtime handles perfectly well.
	 */
	body?: any;
	/** Attach the bearer, refreshing it first when it is about to expire. */
	useAuth?: boolean;
	/** Do not fan the failure out to the global error observers. */
	silentError?: boolean;
	/** Starting a call under this key aborts the one already in flight under it. */
	abortKey?: string;
	/** Only the most recent call under this key is allowed to resolve. */
	keepLastKey?: string;
	onAbort?: () => any;
	/**
	 * Internal: this call has already been replayed once after a refusal.
	 *
	 * Set by `request` on the retry it makes itself, and read to stop there. Without it
	 * a gateway answering 401 to everything — a signing key changed, a session revoked
	 * server-side — would be asked the same question for ever.
	 */
	retried?: boolean;
}

export class AbortCallerException extends Error {
	constructor () {
		super('Abort call url');
	}
}

export class Caller {
	/**
	 * Hooks on the whole call lifecycle.
	 *
	 * This is how cross-cutting behaviour is attached without every caller knowing
	 * about it: the global loading bar subscribes to start and complete, the
	 * notifier to errors. `register.ts` fans them out to application-wide
	 * subscribers.
	 */
	public readonly startObserver = new SimpleObserver();
	public readonly beforeObserver = new SimpleObserver();
	public readonly successObserver = new SimpleObserver();
	public readonly errorObserver = new SimpleObserver();
	public readonly completeObserver = new SimpleObserver();

	private _baseUrl: string;
	private _pinia: Pinia;
	private _defaultOptions: CallerOptions;

	private _abortCtrls: Record<string, AbortController> = {};
	private _keepLasts: Record<string, { sequence: number; abortCtrl: AbortController }[]> = {};

	/**
	 * The order calls were started in, which is what a keep-last key compares.
	 *
	 * A counter and not the clock. Two calls started within one millisecond read the
	 * same `Date.now()`, and with equal stamps the older call was neither aborted nor
	 * kept — both were dropped from the list, so its answer still arrived and could
	 * overwrite the newer one on screen: the exact race a keep-last key exists to stop.
	 * A fast machine starts two calls in one millisecond routinely.
	 */
	private _sequence = 0;

	public constructor (
		baseUrl: string,
		pinia: Pinia,
		defaultOptions: CallerOptions = {},
	) {
		this._baseUrl = baseUrl;
		this._pinia = pinia;
		this._defaultOptions = defaultOptions;
	}

	public async request<T = any>(url: string, options: CallerOptions = {}): Promise<T> {
		const event = { url, options };
		await this.startObserver.trigger(event);
		url = event.url;
		options = event.options;

		try {
			const sequence = ++this._sequence;
			const abortCtrl = new AbortController();
			options.signal ??= abortCtrl.signal;

			if (options.abortKey) {
				if (this._abortCtrls[options.abortKey]) {
					this._abortCtrls[options.abortKey].abort();
				}
				this._abortCtrls[options.abortKey] = abortCtrl;
			}

			if (options.keepLastKey) {
				if (!this._keepLasts[options.keepLastKey]) {
					this._keepLasts[options.keepLastKey] = [];
				}
				this._keepLasts[options.keepLastKey].push({ sequence, abortCtrl });
			}

			options = {
				...this._defaultOptions,
				...options,
				headers: await this.buildHeaders({ ...this._defaultOptions, ...options }),
			};

			if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') {
				options.body = JSON.stringify(options.body);
			}

			const finalUrl = this._baseUrl + url;

			const beforeEvent = { url: finalUrl, options };
			await this.beforeObserver.trigger(beforeEvent);

			const response = await fetch(beforeEvent.url, beforeEvent.options);

			/*
			 * Refused, so the session is renewed once and the call is made again.
			 *
			 * The token store refreshes on its own clock, which answers the ordinary case
			 * — a token about to expire is replaced before it is used. It cannot answer
			 * the other one: the gateway checks the session on **every** authenticated
			 * request, so a session that stops being accepted while the tab believes its
			 * token good — the gateway restarted, the session revoked from another
			 * device, a clock a minute out — produced a 401 that nothing recovered from.
			 * Every screen then failed until somebody reloaded the page, which reads as
			 * being signed out at random.
			 *
			 * Once, and never for the refresh itself: `useAuth` is false on that call, so
			 * it cannot reach here and a gateway refusing everything costs one extra
			 * request rather than a loop.
			 */
			if (
				response.status === 401
				&& options.useAuth
				&& !options.retried
				&& await this.renew()
			) {
				return await this.request<T>(url, { ...options, retried: true, headers: undefined });
			}

			if (response.ok) {
				if (options.keepLastKey && this._keepLasts[options.keepLastKey]) {
					this._keepLasts[options.keepLastKey] = this._keepLasts[options.keepLastKey].filter(keep => {
						if (keep.sequence < sequence) {
							keep.abortCtrl.abort();
							return false;
						}
						return keep.sequence !== sequence;
					});
				}

				const text = await response.text();
				const result = (text ? JSON.parse(text) : null) as T;

				await this.successObserver.trigger({ url: finalUrl, options, result });

				return result;
			}

			throw response;
		} catch (error: any) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				options.onAbort?.();
				throw new AbortCallerException();
			}
			if (!options.silentError) {
				await this.errorObserver.trigger(error);
			}
			throw error;
		} finally {
			await this.completeObserver.trigger();
		}
	}

	public get<T = any>(url: string, options: CallerOptions = {}): Promise<T> {
		return this.request<T>(url, { ...options, method: 'GET' });
	}

	public post<T = any>(url: string, body?: any, options: CallerOptions = {}): Promise<T> {
		return this.request<T>(url, { ...options, method: 'POST', body });
	}

	public put<T = any>(url: string, body?: any, options: CallerOptions = {}): Promise<T> {
		return this.request<T>(url, { ...options, method: 'PUT', body });
	}

	public patch<T = any>(url: string, body?: any, options: CallerOptions = {}): Promise<T> {
		return this.request<T>(url, { ...options, method: 'PATCH', body });
	}

	public delete<T = any>(url: string, options: CallerOptions = {}): Promise<T> {
		return this.request<T>(url, { ...options, method: 'DELETE' });
	}

	/**
	 * Trade the refresh token for a new pair, and say whether it worked.
	 *
	 * Swallowed rather than thrown: a refusal here means the session is over, and the
	 * call that provoked it should report its own 401 to the screen that made it — which
	 * is what signs somebody out. A throw would replace that with whatever the refresh
	 * route happened to answer.
	 */
	private async renew (): Promise<boolean> {
		try {
			return (await useTokenStore(this._pinia).refresh()) !== null;
		} catch {
			return false;
		}
	}

	private async buildHeaders (options: CallerOptions = {}): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			...options.headers as Record<string, string>,
		};

		if (!headers['Content-Type'] && options.body) {
			headers['Content-Type'] = 'application/json';
		}

		const i18nStore = useI18nStore(this._pinia);
		headers['X-Locale'] = i18nStore.locale;

		if (options.useAuth) {
			const tokenStore = useTokenStore(this._pinia);
			const accessToken = await tokenStore.getAccessToken();
			if (accessToken) {
				headers['Authorization'] = `Bearer ${accessToken}`;
			}
		}

		return headers;
	}
}
