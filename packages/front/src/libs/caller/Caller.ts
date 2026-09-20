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
	private _keepLasts: Record<string, { time: number; abortCtrl: AbortController }[]> = {};

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
			const time = Date.now();
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
				this._keepLasts[options.keepLastKey].push({ time, abortCtrl });
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

			if (response.ok) {
				if (options.keepLastKey && this._keepLasts[options.keepLastKey]) {
					this._keepLasts[options.keepLastKey] = this._keepLasts[options.keepLastKey].filter(keep => {
						if (keep.time < time) {
							keep.abortCtrl.abort();
							return false;
						}
						return keep.time !== time;
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
