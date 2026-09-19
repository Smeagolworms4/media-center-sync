import type { MediaGroup } from '@mcs/shared';
import type { RouteLocationRaw } from 'vue-router';
import { ref, type Ref, watch } from 'vue';
import { useLibrariesStore } from '@/stores/libraries';
import { useMediaStore } from '@/stores/media';

export interface TrailStep {
	/** Stable across a redraw: the group's identifier, or the step's own name. */
	key: string;
	label: string;
	/** Null on the step somebody is already looking at. */
	to: RouteLocationRaw | null;
}

/**
 * How deep a trail is walked before it is called a cycle.
 *
 * Category, series, season, episode is four; anything past this is a parent chain
 * that points back at itself, and one request per level would then never stop.
 */
const MAX_DEPTH = 8;

/**
 * Where a media sits, from the category down to itself.
 *
 * Somebody four levels into a library knows what they are looking at and not where
 * it came from: the third season of a show reached from a search looks exactly like
 * the third season reached from the wall. The trail is what answers that, and it is
 * built from what a group already carries — `libraryId` says which category it
 * belongs to, `parentId` is the step above — so nothing here needs an endpoint that
 * does not exist.
 *
 * The ancestors are fetched one at a time rather than in one call because there is
 * no route that answers "the parents of this": `GET /media/groups/:id` is the walk,
 * and a series is one request deep, a season two. The result is cheap enough and
 * the alternative is inventing a route.
 */
export function useMediaTrail (group: Ref<MediaGroup | null>) {
	const mediaStore = useMediaStore();
	const librariesStore = useLibrariesStore();

	const ancestors = ref<MediaGroup[]>([]);
	const walking = ref(false);

	async function walk (from: MediaGroup | null): Promise<void> {
		if (!from?.parentId) {
			ancestors.value = [];
			return;
		}
		walking.value = true;
		const found: MediaGroup[] = [];
		const seen = new Set<string>([from.id]);
		let parentId: string | null = from.parentId;
		try {
			while (parentId && !seen.has(parentId) && found.length < MAX_DEPTH) {
				seen.add(parentId);
				// A parent the gateway no longer knows leaves a shorter trail rather than
				// no trail: the steps already walked are still the way back out.
				const parent: MediaGroup | null = await mediaStore.group(parentId).catch(() => null);
				if (!parent) {
					break;
				}
				found.unshift(parent);
				parentId = parent.parentId;
			}
			ancestors.value = found;
		} finally {
			walking.value = false;
		}
	}

	watch(group, value => {
		void walk(value);
	}, { immediate: true });

	/**
	 * The steps, in the order they are read.
	 *
	 * Not a computed: the category is read from the store, the ancestors are fetched,
	 * and both are already reactive — what this assembles is a plain list over the two.
	 */
	function steps (rootLabel: string): TrailStep[] {
		const current = group.value;
		const trail: TrailStep[] = [
			{ key: 'root', label: rootLabel, to: { name: 'library' } },
		];
		if (!current) {
			return trail;
		}
		const category = current.libraryId
			? librariesStore.categoryOfLibrary[current.libraryId] ?? null
			: null;
		if (category) {
			trail.push({
				key: `category-${category.key}`,
				label: category.name,
				to: { name: 'library', query: { category: category.key } },
			});
		}
		for (const ancestor of ancestors.value) {
			trail.push({
				key: ancestor.id,
				label: ancestor.title,
				to: { name: 'library-item', params: { itemId: ancestor.id } },
			});
		}
		trail.push({ key: current.id, label: current.title, to: null });
		return trail;
	}

	return { ancestors, walking, steps };
}
