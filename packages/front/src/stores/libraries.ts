import type { Library, LibraryCheck, UpdateLibraryRequest } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * Libraries and the state of the directories behind them.
 *
 * The checks are kept next to the libraries on purpose: a library whose local
 * path is not writable accepts transfers the media server will never see, and
 * nothing anywhere reports an error. Any screen that offers a library as a
 * destination has to be able to say so, which means having the check at hand.
 */
export const useLibrariesStore = defineStore('libraries', () => {
	const { caller } = useCaller();

	const libraries = ref<Library[]>([]);
	const checks = ref<LibraryCheck[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const checking = ref(false);
	const error = ref<unknown>(null);

	const byId = computed(() => {
		const map: Record<string, Library> = {};
		for (const library of libraries.value) {
			map[library.id] = library;
		}
		return map;
	});

	const checkById = computed(() => {
		const map: Record<string, LibraryCheck> = {};
		for (const check of checks.value) {
			map[check.libraryId] = check;
		}
		return map;
	});

	/** Where a transfer can actually land: a path that exists and can be written. */
	const writableLibraries = computed(
		() => libraries.value.filter(one => checkById.value[one.id]?.writable ?? one.writable));

	/** What the dashboard calls unhealthy: declared, checked, and not writable. */
	const unwritableChecks = computed(
		() => checks.value.filter(one => !one.writable));

	function replace (library: Library): void {
		const index = libraries.value.findIndex(one => one.id === library.id);
		if (index === -1) {
			libraries.value = [...libraries.value, library];
		} else {
			libraries.value[index] = library;
		}
	}

	async function load (): Promise<Library[]> {
		loading.value = true;
		error.value = null;
		try {
			const loadedList = await caller('api').get<Library[]>('/libraries', {
				keepLastKey: 'libraries|list',
			});
			// An empty body parses to `null`, and a gateway that answers nothing must
			// not leave a page rendering a list that is not one.
			libraries.value = Array.isArray(loadedList) ? loadedList : [];
			loaded.value = true;
			return libraries.value;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	async function get (id: string): Promise<Library> {
		const library = await caller('api').get<Library>(`/libraries/${id}`);
		replace(library);
		return library;
	}

	async function update (id: string, request: UpdateLibraryRequest): Promise<Library> {
		const library = await caller('api').patch<Library>(`/libraries/${id}`, request);
		replace(library);
		// A path that just changed says nothing about whether it can be written to,
		// and that is the whole question this screen exists to answer.
		await loadChecks().catch(() => undefined);
		return library;
	}

	async function loadChecks (): Promise<LibraryCheck[]> {
		checking.value = true;
		try {
			const loadedChecks = await caller('api').get<LibraryCheck[]>('/libraries/check', {
				keepLastKey: 'libraries|check',
			});
			// An empty body parses to `null`, and every screen that warns about a
			// library reads this as a list.
			checks.value = Array.isArray(loadedChecks) ? loadedChecks : [];
			return checks.value;
		} finally {
			checking.value = false;
		}
	}

	function ofService (serviceId: string): Library[] {
		return libraries.value.filter(one => one.serviceId === serviceId);
	}

	return {
		libraries,
		checks,
		loading,
		loaded,
		checking,
		error,
		byId,
		checkById,
		writableLibraries,
		unwritableChecks,
		load,
		get,
		update,
		loadChecks,
		ofService,
	};
});
