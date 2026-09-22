import type {
	CategoryKeyword,
	Library,
	LibraryCheck,
	LibraryHint,
	MediaCategory,
	UpdateLibraryRequest,
} from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useSettingsStore } from '@/stores/settings';

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
	const keywords = ref<CategoryKeyword[]>([]);
	const hints = ref<LibraryHint[]>([]);
	const hintsLoaded = ref(false);
	const loading = ref(false);
	const loaded = ref(false);
	const categoriesLoaded = ref(false);
	const keywordsLoaded = ref(false);
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

	/**
	 * The names plugged into each category.
	 *
	 * Read separately from the categories and always reloaded with them, because the
	 * two are one answer seen from two sides: a keyword is what folded a shelf, and a
	 * screen showing a category without the keyword that produced it cannot say why
	 * two shelves became one band.
	 */
	async function loadKeywords (): Promise<CategoryKeyword[]> {
		const loadedKeywords = await caller('api').get<CategoryKeyword[]>('/libraries/keywords', {
			keepLastKey: 'libraries|keywords',
		});
		// An empty body parses to `null`, and the mapping screen reads this as a list.
		keywords.value = Array.isArray(loadedKeywords) ? loadedKeywords : [];
		keywordsLoaded.value = true;
		return keywords.value;
	}

	/**
	 * Both halves, after a mapping changed.
	 *
	 * Re-read rather than patched in place: which libraries a keyword folds is the
	 * gateway's answer, and working it out again here is how two clients start
	 * disagreeing about what is in the pool.
	 */
	async function reloadMapping (): Promise<void> {
		await Promise.all([loadKeywords(), loadCategories()]);
	}

	async function addKeyword (categoryKey: string, keyword: string): Promise<CategoryKeyword> {
		const created = await caller('api')
			.post<CategoryKeyword>(`/libraries/categories/${categoryKey}/keywords`, { keyword });
		await reloadMapping();
		return created;
	}

	async function moveKeyword (id: string, categoryKey: string): Promise<CategoryKeyword> {
		const moved = await caller('api')
			.patch<CategoryKeyword>(`/libraries/keywords/${id}`, { categoryKey });
		await reloadMapping();
		return moved;
	}

	/**
	 * The undo, and the only one there is.
	 *
	 * Exact because plugging a keyword in wrote nothing on any library: the shelves it
	 * was folding read as their own names again from the very next request, with no
	 * alias to guess at and none to type back by hand.
	 */
	async function removeKeyword (id: string): Promise<void> {
		await caller('api').delete(`/libraries/keywords/${id}`);
		await reloadMapping();
	}

	/**
	 * Ways this gateway is set up that make the library read wrongly.
	 *
	 * Read as its own call and never folded into `load`, because the two answer
	 * different questions and the screens that want one rarely want the other: the
	 * settings screen edits libraries one at a time and has nothing to say about the
	 * shape of a folder, while the wall and the dashboard show the line and never name
	 * a library at all.
	 *
	 * A gateway that cannot answer is not a reason to take a page down. The hints are
	 * the explanation beside the data, so failing to read them leaves the screen exactly
	 * as it was before they existed.
	 */
	async function loadHints (): Promise<LibraryHint[]> {
		const loadedHints = await caller('api').get<LibraryHint[]>('/libraries/hints', {
			keepLastKey: 'libraries|hints',
		});
		// An empty body parses to `null`, and both screens read this as a list.
		hints.value = Array.isArray(loadedHints) ? loadedHints : [];
		hintsLoaded.value = true;
		return hints.value;
	}

	/**
	 * Put one hint away for good.
	 *
	 * Stored on the gateway rather than in this browser, because a hint is about the
	 * gateway and not about whoever happened to be looking at it: dismissed on the
	 * laptop and back on the phone is a notice nobody can get rid of, which is worse
	 * than one that was never shown.
	 *
	 * The row is dropped here as well as sent, so the line goes the moment it is
	 * clicked. Waiting for the reload would leave it on screen for a round trip, which
	 * reads as a button that did nothing.
	 */
	async function dismissHint (key: string): Promise<void> {
		const settings = useSettingsStore();

		// The whole list is sent, so it has to be the whole list. On a screen that never
		// needed the settings — the wall is one — the store is still empty, and sending
		// this one key over an unread list would wake every hint somebody had already put
		// away, with nothing anywhere saying why they came back.
		if (!settings.loaded) {
			await settings.load();
		}

		const already = settings.settings?.dismissedLibraryHints ?? [];

		hints.value = hints.value.filter(one => one.key !== key);
		await settings.save({ dismissedLibraryHints: [...new Set([...already, key])] });
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
		keywords,
		hints,
		hintsLoaded,
		loading,
		loaded,
		categoriesLoaded,
		keywordsLoaded,
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
		loadKeywords,
		addKeyword,
		moveKeyword,
		removeKeyword,
		get,
		update,
		loadChecks,
		loadHints,
		dismissHint,
		ofService,
	};
});
