import type { Library, LibraryCheck, MediaCategory, UpdateLibraryRequest } from '@mcs/shared';
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
	const categories = ref<MediaCategory[]>([]);
	const checks = ref<LibraryCheck[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const categoriesLoaded = ref(false);
	const checking = ref(false);
	const error = ref<unknown>(null);

	const byId = computed(() => {
		const map: Record<string, Library> = {};
		for (const library of libraries.value) {
			map[library.id] = library;
		}
		return map;
	});

	/**
	 * The categories, in the order they are meant to be shown.
	 *
	 * `position` is the lowest of the merged libraries', so it is also the answer to
	 * which category a media belongs to when it is filed in two. Ours comes first on
	 * a tie: two categories that were never ordered against each other are ordered by
	 * whether we hold any of it, because a band nobody in this house can write into
	 * is not the one to open with.
	 */
	const orderedCategories = computed(() => {
		// `toSorted` would be cleaner, but it is not in the library version this build
		// targets; the copy is what keeps `sort` from reordering the store's own array.
		// eslint-disable-next-line unicorn/no-array-sort
		return [...categories.value].sort((a, b) => (
			a.position - b.position
			|| Number(b.local) - Number(a.local)
			|| a.name.localeCompare(b.name)
		));
	});

	const categoryByKey = computed(() => {
		const map: Record<string, MediaCategory> = {};
		for (const category of categories.value) {
			map[category.key] = category;
		}
		return map;
	});

	/**
	 * Which category a library belongs to, which is what a breadcrumb needs.
	 *
	 * A media knows its library and nothing above it; the step a person reads is the
	 * category — the name they see on the wall — and this is the only mapping between
	 * the two. First wins, for the same reason the wall shows a media once: the
	 * categories are already in the order that settles it.
	 */
	const categoryOfLibrary = computed(() => {
		const map: Record<string, MediaCategory> = {};
		for (const category of orderedCategories.value) {
			// A gateway that answers a category without its libraries is odd and not a
			// reason to take a page down: a breadcrumb missing one step still works.
			for (const libraryId of category.libraryIds ?? []) {
				map[libraryId] ??= category;
			}
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
		// An alias or a position changes which libraries merge and in which order, so
		// the categories every browsing screen is built from are no longer the ones
		// that were loaded. Re-read rather than patched: the merge is the gateway's
		// answer, and recomputing it here is how two clients start disagreeing.
		if (categoriesLoaded.value && ('alias' in request || 'position' in request)) {
			await loadCategories().catch(() => undefined);
		}
		return library;
	}

	/**
	 * The merged view the browsing screens are built from.
	 *
	 * Separate from `load` because they answer different questions and not every
	 * screen wants both: the settings screen edits libraries one by one — that is
	 * where an alias is set — while the wall never names a library at all.
	 */
	async function loadCategories (): Promise<MediaCategory[]> {
		const loadedCategories = await caller('api').get<MediaCategory[]>('/libraries/categories', {
			keepLastKey: 'libraries|categories',
		});
		// An empty body parses to `null`, and the wall reads this as a list.
		categories.value = Array.isArray(loadedCategories) ? loadedCategories : [];
		categoriesLoaded.value = true;
		return categories.value;
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
		categories,
		checks,
		loading,
		loaded,
		categoriesLoaded,
		checking,
		error,
		byId,
		orderedCategories,
		categoryByKey,
		categoryOfLibrary,
		checkById,
		writableLibraries,
		unwritableChecks,
		load,
		loadCategories,
		get,
		update,
		loadChecks,
		ofService,
	};
});
