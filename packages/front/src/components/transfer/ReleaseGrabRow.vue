<script lang="ts" setup>
	import type { ReleaseGrab } from '@mcs/shared';
	import { GrabState } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Rate from '@/components/common/Rate.vue';
	import { useLibrariesStore } from '@/stores/libraries';

	/**
	 * A torrent in the queue, beside the transfers.
	 *
	 * On one screen and not two, which was the first instinct and was wrong: "where are
	 * my downloads" is one question, and a household that has to look in two places to
	 * answer it will eventually look in only one. A torrent is not one of our transfers
	 * — nothing about it has chunks, sources or a revalidation — so it carries the facts
	 * it has and offers only the actions that mean something for it, rather than being
	 * bent into a shape with buttons that cannot work.
	 *
	 * **Only what this gateway started.** The client is filtered on a category of ours,
	 * so somebody's own torrents are never listed here, never tracked, and never filed
	 * into a library.
	 *
	 * Two phases, and the row says which. The bytes are the torrent's while it is
	 * downloading and the copy's once the client has finished — a twenty-gigabyte season
	 * takes a while to land in the library, and a row that sat on "fetched" with nothing
	 * moving is a row anybody would read as stuck.
	 */
	const props = withDefaults(defineProps<{
		grab: ReleaseGrab;
		busy?: boolean;
	}>(), {
		busy: false,
	});

	const emit = defineEmits<{ retarget: [grab: ReleaseGrab] }>();

	const librariesStore = useLibrariesStore();

	/** Still moving, or waiting to be filed — the states a progress bar belongs on. */
	const LIVE: Set<GrabState> = new Set([GrabState.SENT, GrabState.DOWNLOADING, GrabState.FETCHED]);

	const live = computed(() => LIVE.has(props.grab.state));

	/** Which of the two things the bytes are counting, said rather than implied. */
	const phase = computed(() =>
		props.grab.state === GrabState.FETCHED ? 'release.phase.copying' : 'release.phase.fetching');

	const percent = computed(() =>
		props.grab.bytesTotal > 0
			? Math.min(100, Math.round((props.grab.bytesDone / props.grab.bytesTotal) * 100))
			: 0);

	/**
	 * Where it will land, named rather than left to be guessed.
	 *
	 * The folder somebody chose, then the library, then nothing — and nothing is honest:
	 * until the placement runs there is no path, because which library receives it
	 * depends on what the gateway finds when it looks.
	 */
	const destination = computed(() => {
		if (props.grab.targetPath) {
			return props.grab.targetPath;
		}

		if (props.grab.targetFolder) {
			return props.grab.targetFolder;
		}

		return props.grab.targetLibraryId === null
			? null
			: (librariesStore.libraries.find(one => one.id === props.grab.targetLibraryId)?.name ?? null);
	});
</script>

<template>
	<v-card class="release-grab-row" :data-state="grab.state" data-test="release-grab-row" variant="tonal">
		<v-card-text class="py-3">
			<div class="release-grab-row_head">
				<v-icon icon="mdi-magnet" size="20" />

				<div class="release-grab-row_identity">
					<strong data-test="release-grab-row-title">{{ grab.title }}</strong>

					<span class="text-caption text-medium-emphasis">
						{{ grab.indexer }}
					</span>
				</div>

				<v-chip data-test="release-grab-row-state" label size="x-small" variant="tonal">
					{{ $t(`release.state.${grab.state}`) }}
				</v-chip>

				<span v-if="grab.bytesTotal > 0" class="text-caption text-medium-emphasis">
					<ByteSize :bytes="grab.bytesDone" /> / <ByteSize :bytes="grab.bytesTotal" />
				</span>

				<span v-if="grab.rate > 0" class="text-caption text-medium-emphasis">
					<Rate :rate="grab.rate" />
				</span>
			</div>

			<div v-if="live" class="mt-2">
				<v-progress-linear
					data-test="release-grab-row-progress"
					height="6"
					:model-value="percent"
					rounded
				/>

				<!--
					Which phase, because the same bar means two different things: the bytes
					are the torrent's while it downloads and the copy's afterwards, and a
					season landing in a library is not a second download.
				-->
				<span class="text-caption text-medium-emphasis" data-test="release-grab-row-phase">
					{{ $t(phase) }}
				</span>
			</div>

			<p
				v-if="destination"
				class="release-grab-row_path text-caption text-medium-emphasis mb-0 mt-1"
				data-test="release-grab-row-destination"
			>
				{{ $t('transfer.retarget.into', { path: destination }) }}
			</p>

			<!--
				Each file of a pack against its own episode. A season pack taken for two
				episodes brings two files, and one path could not say where either went.
			-->
			<div v-if="grab.placements.length > 1" class="release-grab-row_files mt-2">
				<p
					v-for="one of grab.placements"
					:key="one.itemId"
					class="text-caption text-medium-emphasis mb-0"
					data-test="release-grab-row-file"
				>
					{{ one.title }}
					<span v-if="one.fileName" class="release-grab-row_path">— {{ one.fileName }}</span>
				</p>
			</div>

			<p
				v-if="grab.error"
				class="text-caption text-error mb-0 mt-1"
				data-test="release-grab-row-error"
			>
				{{ grab.error }}
			</p>

			<div class="release-grab-row_actions mt-2">
				<!--
					Offered until it is filed, and not afterwards: once the copy is in the
					library it is a file like any other, and moving it is the media's own
					business rather than this row's.
				-->
				<v-btn
					v-if="grab.state !== GrabState.PLACED"
					data-test="release-grab-row-retarget"
					:disabled="busy"
					prepend-icon="mdi-folder-move-outline"
					size="small"
					variant="text"
					@click="emit('retarget', grab)"
				>
					{{ $t('transfer.retarget.action') }}
				</v-btn>
			</div>
		</v-card-text>
	</v-card>
</template>

<style lang="scss">
	.release-grab-row {
		&_head {
			display: flex;
			align-items: center;
			gap: 10px;
		}

		&_identity {
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-width: 0;
		}

		&_path {
			font-family: monospace;
			overflow-wrap: anywhere;
		}

		&_actions {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
	}
</style>
