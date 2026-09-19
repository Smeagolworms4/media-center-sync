import { onMounted, ref, watch } from 'vue';
import { usePageStore } from '@/stores/page';

export function useEndFirstRender() {

	const pageStore = usePageStore();
	const isEndFirstRender = ref(false);
	const callbacks: (() => any)[] = [];

	const onEndFirstRender = (callback: () => any) => {
		callbacks.push(callback);
	};

	let running = false;
	const checkAndRun = async () => {
		if (!running && pageStore.endFirstRender) {
			running = true;
			try {
				await Promise.all(
					callbacks.map(cb => cb()),
				);
			} catch (e) {
				console.error(e);
			}
			isEndFirstRender.value = true;
		}
	}
	onMounted(() => {
		checkAndRun().catch(console.error);
	});
	watch(() => pageStore.endFirstRender, checkAndRun);

	return { isEndFirstRender, onEndFirstRender };
}
