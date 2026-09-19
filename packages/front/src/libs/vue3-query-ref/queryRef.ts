import type { WritableComputedRef } from 'vue';
import type { Router } from 'vue-router';
import { computed, ref, watch } from 'vue';
import { queryTypes } from './queryTypes';
import { useRouter } from '@/hooks';

export interface QueryRefParser<T = string> {
	parse: (value: string|string[]) => T | null;
	serialize: (value: T) => string|string[];
	defaultValue: T|null;
}
export interface QueryRefHistory {
	history: 'replace'|'push';
}
export interface QueryRefOptions<T= string> extends QueryRefParser<T>, QueryRefHistory {
}

function getParamByRouter(router: Router, name: string): string|string[]|null  {
	const query = getRouterQuery(router);
	return name in query ? query[name] as any : null;
}

function setParam(
	name: string,
	value: string|string[]|null,
	query: Nullable<any> = null,
): any  {
	query = { ...query };
	if (value === null) {
		delete query[name];
	} else
	if (Array.isArray(value)) {
		query[name] = value;
	} else {
		query[name] = value;
	}
	return query;
}

function getRouterQuery(router: Router) {
	return (router as any).__queryRef__?.query || router.currentRoute.value.query;
}

async function setUrl(router: Router, query: any, options: Partial<QueryRefHistory>) {
	let routerQueryRef: any = (router as any).__queryRef__;
	if (!routerQueryRef) {
		routerQueryRef = {
			push: router.push,
			replace: router.replace,
			query: null,
		};
		router.push = function (...args: any) {
			routerQueryRef.query = null;
			return routerQueryRef.push.call(this, ...args);
		};
		router.replace = function (...args: any) {
			routerQueryRef.query = null;
			return routerQueryRef.replace.call(this, ...args);
		};
		(router as any).__queryRef__ = routerQueryRef;
	}

	if (options.history === 'push') {
		routerQueryRef.query = query;
		await routerQueryRef.push.call(router, { query });
		routerQueryRef.query = null;
	} else {
		routerQueryRef.query = query;
		await routerQueryRef.replace.call(router, { query });
		routerQueryRef.query = null;
	}
}

export function queryRef<T = string>(name: string, options: Partial<QueryRefOptions<T>> = {}) {
	const router = useRouter();

	options = {
		history: 'replace',
		...queryTypes.string as any,
		defaultValue: null,
		...options
	};

	const get = (): T|null => {
		const value = getParamByRouter(router, name);
		const defaultValue = options.defaultValue ?? null;
		if (value !== null) {
			return options.parse ? options.parse(value) : defaultValue;
		}
		return defaultValue;
	};

	const set = (value: T|null) => {
		const valueString = value !== null && typeof value !== 'undefined' ? (options.serialize ? options.serialize(value) : String(value)) : null;
		const query = setParam(name, valueString, getRouterQuery(router));
		setUrl(router, query, options);
	};

	const value = ref(get());
	let syncingFromRoute = false;
	watch(value, () => {
		if (syncingFromRoute) return;
		set(value.value);
	});
	watch(
		() => router.currentRoute.value.fullPath,
		() => {
			const newValue = get();
			if (value.value !== newValue) {
				syncingFromRoute = true;
				value.value = newValue;
				syncingFromRoute = false;
			}
		}
	);

	return value;
}

export type QueriesRefOptions<KeyMap extends Record<string, any>> = {
	[K in keyof KeyMap]: QueryRefParser<KeyMap[K]>;
};

type KeyMapNullable<T> = {
	[K in keyof T]: T[K] | null;
};

export function queriesRef<const KeyMap extends Record<string, any>>(keyMap: QueriesRefOptions<KeyMap>, options: { prefixQuery? :string } & Partial<QueryRefHistory> = {}): WritableComputedRef<KeyMapNullable<KeyMap>> {
	const router = useRouter();

	options = {
		prefixQuery: '',
		history: 'replace',
		...options
	};
	const dirty = ref(false);
	const keys = Object.keys(keyMap);
	const keySet = new Set(keys);

	function getKey(name: keyof KeyMap): any|null {
		const value = getParamByRouter(router, options!.prefixQuery! + (name as string));
		const defaultValue = keyMap[name]!.defaultValue ?? null;
		const parse = keyMap[name]?.parse ?? null;
		if (value !== null) {
			return parse ? parse(value) : defaultValue;
		}
		return defaultValue;
	}

	function setKey(
		name: keyof KeyMap,
		value: any,
		query: any|null = null,
	) {
		query = query || getRouterQuery(router);
		const serialize = keyMap[name]?.serialize ?? null;
		const valueString = value !== null && typeof value !== 'undefined' ? (serialize ? serialize(value) : String(value)) : null;
		return setParam(options!.prefixQuery! + (name as string), valueString, query);
	}

	const proxy = () => new Proxy({}, {
		get(target: any, key) {
			if (typeof key === 'string' && keySet.has(key)) {
				return getKey(key as keyof KeyMap);
			}
			return target[key];
		},
		set: function (target: any, key, value) {
			if (typeof key === 'string' && keySet.has(key)) {
				const query = setKey(key as keyof KeyMap, value);
				setUrl(router, query, options);
				dirty.value = !dirty.value;
			}
			target[key] = value;
			return true;
		},
		has: function (_, key) {
			return typeof key === 'string' && keySet.has(key);
		},
		ownKeys: function () {
			return keys;
		},
		getOwnPropertyDescriptor(_target: any, key: PropertyKey) {
			if (typeof key === 'string' && keySet.has(key)) {
				return { enumerable: true, configurable: true }
			}
			return undefined
		},
	});

	return computed<KeyMapNullable<KeyMap>>({
		get(): KeyMapNullable<KeyMap> {
			void dirty.value;
			void router.currentRoute.value.fullPath;
			return proxy() as any;
		},
		set(value: KeyMapNullable<KeyMap>) {
			let query = getRouterQuery(router);
			for (const key of keys) {
				const v = (value as any)?.[key] ?? null;
				query = setKey(key as keyof KeyMap, v, query);
			}
			setUrl(router, query, options);
			dirty.value = !dirty.value;
		}
	});
}
