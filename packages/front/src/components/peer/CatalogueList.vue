<script lang="ts" setup>
	import type { CatalogueEntry } from '@mcs/shared';
	import ByteSize from '@/components/common/ByteSize.vue';
	import EmptyState from '@/components/common/EmptyState.vue';

	/**
	 * What a friend shares, as they describe it.
	 *
	 * Thinner than a media row on purpose: no path, no library, no local state —
	 * those are ours and mean nothing here. An entry with no `contentId` is one
	 * they share as a catalogue only, which is why the pull button is missing
	 * rather than present and failing.
	 */
	withDefaults(defineProps<{
		entries: CatalogueEntry[];
		loading?: boolean;
		busy?: boolean;
	}>(), {
		loading: false,
		busy: false,
	});

	const emit = defineEmits<{ pull: [entry: CatalogueEntry] }>();
</script>

<template>
	<div class="catalogue-list" data-test="catalogue-list">
		<div v-if="loading" class="text-center py-6">
			<v-progress-circular color="primary" indeterminate size="28" />
		</div>

		<EmptyState
			v-else-if="entries.length === 0"
			icon="mdi-book-off-outline"
			:text="$t('peer.catalogue.empty_text')"
			:title="$t('peer.catalogue.empty_title')"
		/>

		<v-table v-else density="compact">
			<thead>
				<tr>
					<th>{{ $t('media.column.title') }}</th>
					<th>{{ $t('media.column.kind') }}</th>
					<th class="text-right">{{ $t('media.column.year') }}</th>
					<th>{{ $t('media.column.quality') }}</th>
					<th class="text-right">{{ $t('media.column.size') }}</th>
					<th />
				</tr>
			</thead>

			<tbody>
				<tr
					v-for="entry of entries"
					:key="entry.externalId"
					:data-shared="entry.contentId !== null"
					data-test="catalogue-row"
				>
					<td>
						{{ entry.title }}

						<span
							v-if="entry.seasonNumber !== null"
							class="text-caption text-medium-emphasis ml-2"
						>
							{{ $t('media.season_episode', {
								season: entry.seasonNumber,
								episode: entry.episodeNumber ?? 0,
							}) }}
						</span>
					</td>

					<td class="text-caption">{{ $t(`media.kind.${entry.kind}`) }}</td>

					<td class="text-caption text-right">{{ entry.year ?? '—' }}</td>

					<td class="text-caption">{{ entry.quality ?? $t('quality.unknown') }}</td>

					<td class="text-caption text-right"><ByteSize :bytes="entry.size" /></td>

					<td class="text-right">
						<v-btn
							v-if="entry.contentId"
							data-test="catalogue-pull"
							:disabled="busy"
							icon="mdi-cloud-download-outline"
							size="small"
							variant="text"
							@click="emit('pull', entry)"
						/>

						<v-tooltip v-else location="top" :text="$t('peer.catalogue.metadata_only')">
							<template #activator="{ props: tooltipProps }">
								<v-icon
									v-bind="tooltipProps"
									class="mr-2"
									icon="mdi-eye-outline"
									size="18"
								/>
							</template>
						</v-tooltip>
					</td>
				</tr>
			</tbody>
		</v-table>
	</div>
</template>
