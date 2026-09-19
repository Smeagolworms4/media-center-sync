import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useLoaderStore = defineStore('loader', () => {
	const loading = ref(false);
	let counter = 0;

	const push = () => {
		counter++;
		loading.value = counter > 0;
	};
	const pop = () => {
		counter--;
		if (counter < 0) {
			counter = 0;
		}
		loading.value = counter > 0;
	};

	return {
		loading,
		push,
		pop,
	};
});
