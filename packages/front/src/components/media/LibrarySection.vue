<script lang="ts" setup>
	import type { ViewMode } from '@/composables/useViewMode';
	import type { MediaGroup } from '@mcs/shared';
	import { LibraryKind } from '@mcs/shared';
	import { computed } from 'vue';
	import MediaCard from '@/components/media/MediaCard.vue';
	import MediaGroupRow from '@/components/media/MediaGroupRow.vue';
	import { useMediaStore } from '@/stores/media';

	/**
	 * One band of the library: a heading, a count, and what is in it.
	 *
	 * The heading is a *library* — `Animes`, `Emissions`, `FilmsHD`, whatever the
	 * person called it on their media server. Two hard-wired bands called Films and
	 * Series would fold all of that into one word nobody uses, and the names are the
	 * only part of this screen that came from the viewer rather than from us.
	 *
	 * `LibraryKind` is kept for what it actually is — structure, not a category. It
	 * says whether the things inside open onto seasons or straight onto a file, and
	 * what shape their artwork is; it is never shown, because `shows` is our word and
	 * `Animes` is theirs.
	 *
	 * A band with nothing in it still renders its heading and says so. A library that
	 * disappears the day it is empty is one somebody will look for and not find, and
	 * "empty" is itself the answer to "why is nothing syncing from there".
	 */
	const props = withDefaults(defineProps<{
		title: string;
		/** Whose library it is, shown only where the name alone is ambiguous. */
		subtitle?: string | null;
		groups: MediaGroup[];
		/** The band's total, which is larger than `groups` when it is capped. */
		total: number;
		/** Structural, never rendered: it picks the icon and the artwork shape. */
		libraryKind?: LibraryKind | null;
		libraryId?: string | null;
		view?: ViewMode;
		selecting?: boolean;
		selection?: Set<string>;
		/** Offers the "see all" affordance when the band shows less than it holds. */
		truncated?: boolean;
		loading?: boolean;
	}>(), {
		subtitle: null,
		libraryKind: null,
		libraryId: null,
		view: 'grid',
		selecting: false,
		selection: () => new Set<string>(),
		truncated: false,
		loading: false,
	});

	const emit = defineEmits<{
		'update:selected': [id: string, value: boolean];
		'see-all': [];
	}>();

	// The store builds every URL, including this one; the band only decides which
	// item's artwork a given poster should show.
	const mediaStore = useMediaStore();

	const KIND_ICON: Record<LibraryKind, string> = {
		[LibraryKind.MOVIES]: 'mdi-movie-open-outline',
		[LibraryKind.SHOWS]: 'mdi-television-classic',
		[LibraryKind.MUSIC]: 'mdi-music-box-multiple-outline',
		[LibraryKind.OTHER]: 'mdi-folder-multiple-outline',
	};

	const icon = computed(() => (props.libraryKind
		? KIND_ICON[props.libraryKind]
		: 'mdi-view-grid-outline'));

	/** A record sleeve is square; everything else in a library is a poster. */
	const square = computed(() => props.libraryKind === LibraryKind.MUSIC);

	function artworkOf (group: MediaGroup): string | null {
		return mediaStore.artworkUrl(group.artworkItemId);
	}
</script>

<template>
	<section
		class="library-section"
		:data-kind="libraryKind ?? 'all'"
		:data-library="libraryId ?? ''"
		data-test="library-section"
	>
		<header class="library-section_header">
			<v-icon class="library-section_icon" :icon="icon" size="20" />

			<h2 class="library-section_title text-subtitle-1">{{ title }}</h2>

			<span v-if="subtitle" class="library-section_owner text-caption text-medium-emphasis">
				{{ subtitle }}
			</span>

			<span
				class="library-section_count text-caption text-medium-emphasis"
				data-test="library-section-count"
			>
				{{ $t('library.section_count', { count: total }, total) }}
			</span>

			<v-spacer />

			<v-btn
				v-if="truncated"
				append-icon="mdi-chevron-right"
				data-test="library-section-all"
				size="small"
				variant="text"
				@click="emit('see-all')"
			>
				{{ $t('library.see_all') }}
			</v-btn>
		</header>

		<p
			v-if="groups.length === 0 && !loading"
			class="library-section_empty text-body-2 text-medium-emphasis"
			data-test="library-section-empty"
		>
			{{ $t('library.section_empty') }}
		</p>

		<div v-else-if="view === 'grid'" class="library-section_grid" data-test="media-list">
			<MediaCard
				v-for="group of groups"
				:key="group.id"
				:artwork="artworkOf(group)"
				:group="group"
				:selected="selection.has(group.id)"
				:selecting="selecting"
				:square="square"
				@update:selected="emit('update:selected', group.id, $event)"
			/>
		</div>

		<v-table v-else class="library-section_table" data-test="media-list" density="compact">
			<thead>
				<tr>
					<th class="library-section_selectHead" />
					<th />
					<th>{{ $t('media.column.title') }}</th>
					<th>{{ $t('media.column.kind') }}</th>
					<th class="text-right">{{ $t('media.column.year') }}</th>
					<th>{{ $t('media.column.sources') }}</th>
					<th>{{ $t('media.column.quality') }}</th>
					<th class="text-right">{{ $t('media.column.size') }}</th>
				</tr>
			</thead>

			<tbody>
				<MediaGroupRow
					v-for="group of groups"
					:key="group.id"
					:group="group"
					selectable
					:selected="selection.has(group.id)"
					@update:selected="emit('update:selected', group.id, $event)"
				/>
			</tbody>
		</v-table>
	</section>
</template>

<style lang="scss">
	.library-section {
		margin-bottom: 28px;

		&_header {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 12px;
			padding-bottom: 6px;
			border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1);
		}

		&_title {
			font-weight: 600;
		}

		&_owner {
			padding: 1px 6px;
			border-radius: 4px;
			background: rgba(var(--v-theme-on-surface), 0.08);
		}

		&_grid {
			display: grid;
			// Tiles keep a readable size and the row reflows instead of stretching:
			// a fixed column count leaves 90-pixel posters on a phone and 400-pixel
			// ones on a television, and neither is a library anybody scans.
			grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
			gap: 18px 14px;
		}

		&_empty {
			padding: 10px 2px 2px;
		}

		&_selectHead {
			width: 42px;
		}

		&_table {
			font-size: 13px;
		}
	}
</style>
