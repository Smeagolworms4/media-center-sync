import { SimpleObserver } from '@/libs/observer'
import type { Pinia } from 'pinia';
import { useTokenStore } from '@/stores/token';
import { hToken } from '@/models';
import { useI18nStore } from '@/stores/i18n.ts';

export interface CallerOptions extends RequestInit {
	useAuth?: boolean,
	silentError?: boolean
	abortKey?: string
	keepLastKey?: string
	onAbort?: () => any
}

export class AbortCallerException extends Error {
	constructor() {
		super('Abort call url')
	}
}

export class Caller {

	private _baseUrl: string;
	private _pinia: Pinia;
	private _defaultOptions: CallerOptions;

	private _abortCtrls: Record<string, AbortController> = {};
	private _keepLasts: Record<string, { time: number, abortCtrl: AbortController }[]> = {};

	public readonly startObserver = new SimpleObserver();
	public readonly beforeObserver = new SimpleObserver();
	public readonly successObserver = new SimpleObserver();
	public readonly errorObserver = new SimpleObserver();
	public readonly completeObserver = new SimpleObserver();

	public constructor(
		baseUrl: string,
		pinia: Pinia,
		defaultOptions: CallerOptions = {},
	) {
		this._baseUrl = baseUrl
		this._pinia = pinia
		this._defaultOptions = defaultOptions
	}

	private async buildHeaders(options: CallerOptions = {}): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			...(options.headers as Record<string, string> ?? {}),
		};

		if (!headers['Content-Type'] && options.body) {
			headers['Content-Type'] = 'application/json';
		}

		const i18nStore = useI18nStore(this._pinia);
		headers['X-Locale'] = i18nStore.locale;

		if (options.useAuth) {
			const tokenStore = useTokenStore(this._pinia);
			let token = hToken(tokenStore.token);
			if (token) {
				if (!token.isValid) {
					token = hToken(await tokenStore.refresh());
				}
				if (token?.isValid) {
					headers['Authorization'] = `Bearer ${token?.id}`;
				}
			}
		}

		return headers;
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

			if (typeof options.body !== 'undefined' && options.body !== null && typeof options.body !== 'string') {
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
					})
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
}
