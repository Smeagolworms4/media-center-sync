import type { Ref } from 'vue';
import { onMounted, onUnmounted, ref } from 'vue';

export function useInterval (callback: (...args: any) => any, interval = 0): Ref<any> {
	const handle = ref<any>(null);
	onMounted(() => {
		handle.value = setInterval(callback, interval);
	});

	onUnmounted(() => {
		clearInterval(handle.value);
	});

	return handle;
}
