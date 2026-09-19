import { getCurrentInstance } from 'vue';

export function useInstance<T = any>(): T {
	return (getCurrentInstance() as any).proxy;
}
