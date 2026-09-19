import type { QueryRefParser } from '@/libs/vue3-query-ref/queryRef';
import { ref, watch } from 'vue';
import { queryTypes } from './queryTypes';

export interface StorageRefStorage {
	storage: 'local' | 'session';
}
export interface StorageRefOptions<T = string> extends QueryRefParser<T>, StorageRefStorage {
}

function getStorage (name: string, storage: 'local' | 'session'): any {
	if (storage === 'local') {
		try {
			return JSON.parse(window.localStorage.getItem(name) as any);
		} catch {
			return null;
		}
	} else {
		try {
			return JSON.parse(window.sessionStorage.getItem(name) as any);
		} catch {
			return null;
		}
	}
}
function setStorage (name: string, value: any, storage: 'local' | 'session'): void {
	if (storage === 'local') {
		window.localStorage.setItem(name, JSON.stringify(value));
	} else {
		window.sessionStorage.setItem(name, JSON.stringify(value));
	}
}

export function storageRef<T = string> (name: string, options: Partial<StorageRefOptions<T>> = {}) {
	options = {
		storage: 'local',
		// Called, not spread: `queryTypes.string` is a factory, and spreading the
		// function itself leaves `parse` and `serialize` undefined — which makes every
		// read return the default and silently erases what was just written.
		...queryTypes.string() as any,
		defaultValue: null,
		...options,
	};

	const get = (): T | null => {
		if (typeof window === 'undefined') {
			return (options as any).defaultValue;
		}
		const value = getStorage(name, options.storage!);
		const defaultValue = (options as any).defaultValue ?? null;
		if (value !== null) {
			return (options as any).parse ? (options as any).parse(value) : defaultValue;
		}
		return defaultValue;
	};

	const set = (value: T | null) => {
		if (typeof window === 'undefined') {
			return;
		}
		const valueFinal = value !== null && value !== undefined ? ((options as any).serialize ? (options as any).serialize(value) : value) : null;
		setStorage(name, valueFinal, options.storage!);
	};

	const value = ref(get());
	watch(value, () => {
		set(value.value);
	});

	return value;
}
