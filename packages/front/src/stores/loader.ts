import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * The application-wide "something is happening" flag.
 *
 * It counts rather than toggles, because several calls overlap all the time and
 * a boolean would be switched off by the first one to finish while three others
 * are still running.
 *
 * `start`/`stop` rather than `push`/`pop`: the latter reads as an array
 * everywhere it is called, to people and to static analysis alike.
 */
export const useLoaderStore = defineStore('loader', () => {
	const loading = ref(false);
	let pending = 0;

	const start = (): void => {
		pending += 1;
		loading.value = pending > 0;
	};

	const stop = (): void => {
		pending = Math.max(0, pending - 1);
		loading.value = pending > 0;
	};

	return {
		loading,
		start,
		stop,
	};
});
