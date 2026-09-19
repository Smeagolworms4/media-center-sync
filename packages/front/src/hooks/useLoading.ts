import { computed, type ComputedRef } from 'vue';
import { useLoaderStore } from '@/stores/loader.ts';

export function useLoading(): ComputedRef<boolean> {
	const loaderStore = useLoaderStore();
	return computed(() => loaderStore.loading);
}
