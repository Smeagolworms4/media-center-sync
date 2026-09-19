<script lang="ts" setup>
	import type { MediaGroupSource, MediaService } from '@mcs/shared';
	import { SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import CompanionMarks from '@/components/media/CompanionMarks.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';
	import { type MediaOriginDescriptor, useMediaOrigin } from '@/composables/useMediaOrigin';

	/**
	 * Every server that holds this media, and which one a pull should use.
	 *
	 * The card upstairs says "we have it" or "a friend has it" in two marks; this is
	 * where that becomes something to act on — each copy with its quality and its
	 * size, ours marked, in the order the gateway itself would consult them. Seeing
	 * that a friend's copy is the 2160p one and ours is the 720p is the whole reason
	 * somebody opens this page.
	 *
	 * Each copy also says what sits beside it — the `.nfo`, the artwork, the
	 * subtitles — because a copy that is bigger and better encoded but has no
	 * metadata is not obviously the one to pull, and that is a choice somebody can
	 * only make if the list says so.
	 *
	 * Each copy carries its own state as well as the group's: the group says the
	 * media is outdated, and only the per-copy state says which one is the old one —
	 * without it somebody is told to pull without being told from where.
	 *
	 * And each says how far away it is. A copy on a friend's server and a copy on
	 * somebody their friend introduced are not the same offer — the second is a
	 * gateway nobody here ever agreed to — and the row is where that has to be
	 * readable, because this is the list a pull is chosen from.
	 *
	 * Left alone the pull follows the priority configured once in the administration
	 * screen, and the list says so rather than showing an empty selection: pinning a
	 * source into every run would mean revisiting them all the day a friend's server
	 * moves.
	 */
	const props = withDefaults(defineProps<{
		sources?: MediaGroupSource[];
		/** The registered services, read only for the priority they are ranked by. */
		services?: MediaService[];
		/** Peer names by identifier, for the sources reached through a friend. */
		peerNames?: Record<string, string>;
		disabled?: boolean;
	}>(), {
		sources: () => [],
		services: () => [],
		peerNames: () => ({}),
		disabled: false,
	});

	const selected = defineModel<string | null>({ default: null });

	const priorities = computed(() => {
		const map: Record<string, number> = {};
		for (const service of props.services) {
			map[service.id] = service.priority;
		}
		return map;
	});

	/**
	 * Lowest priority first — the order the gateway itself would consult them in.
	 *
	 * A source whose service is not in the list keeps a rank below every known one
	 * rather than jumping to the top: it is a service this browser has not loaded,
	 * not a service that was ranked first.
	 */
	const ordered = computed(() => {
		// `toSorted` would be cleaner, but it is not in the library version this
		// build targets; the copy is what keeps `sort` from reordering the array
		// under everything that renders it.
		// eslint-disable-next-line unicorn/no-array-sort
		return [...props.sources].sort((a, b) => (
			(priorities.value[a.serviceId] ?? Number.MAX_SAFE_INTEGER)
			- (priorities.value[b.serviceId] ?? Number.MAX_SAFE_INTEGER)
		));
	});

	const defaultSource = computed(() => ordered.value[0] ?? null);

	const { originOf, describeMediaOrigin } = useMediaOrigin();

	/** Resolved once per source rather than once per binding that reads it. */
	const originsByItem = computed(() => {
		const map = new Map<string, MediaOriginDescriptor>();
		for (const source of props.sources) {
			const origin = originOf(source);
			if (origin) {
				map.set(source.itemId, describeMediaOrigin(origin));
			}
		}
		return map;
	});

	function originOfItem (source: MediaGroupSource): MediaOriginDescriptor | null {
		return originsByItem.value.get(source.itemId) ?? null;
	}

	function peerNameOf (source: MediaGroupSource): string | null {
		return source.peerId ? props.peerNames[source.peerId] ?? null : null;
	}
</script>

<template>
	<div class="group-sources" data-test="source-picker">
		<p class="text-caption text-medium-emphasis mb-1">{{ $t('media.source.title') }}</p>

		<v-radio-group
			v-model="selected"
			class="group-sources_group"
			:disabled="disabled"
			hide-details
		>
			<v-radio class="group-sources_default" data-test="source-default" :value="null">
				<template #label>
					<span>
						{{ $t('media.source.follow_priority') }}
						<span v-if="defaultSource" class="text-medium-emphasis">
							{{ $t('media.source.follow_priority_hint', { name: defaultSource.serviceName }) }}
						</span>
					</span>
				</template>
			</v-radio>

			<v-radio
				v-for="source of ordered"
				:key="source.itemId"
				class="group-sources_option"
				:data-local="source.local"
				:data-state="source.sync"
				data-test="group-source"
				:value="source.serviceId"
			>
				<template #label>
					<span class="group-sources_label">
						<!--
							Only when the copy actually carries a state. A row of question
							marks beside a state the header already gives says nothing, and
							an older gateway simply does not send this field.
						-->
						<SyncStateIcon
							v-if="source.sync && source.sync !== SyncState.UNKNOWN"
							:size="16"
							:state="source.sync"
						/>

						<span class="group-sources_name">{{ source.serviceName }}</span>

						<v-chip
							v-if="source.local"
							color="state-in-sync"
							data-test="group-source-ours"
							label
							size="x-small"
							variant="tonal"
						>
							{{ $t('media.source.ours') }}
						</v-chip>

						<!--
							Only where the copy is not ours: the chip beside it already says
							`ours`, and two chips saying the same word is noise on every row of
							a gateway with one server.
						-->
						<v-chip
							v-if="!source.local && originOfItem(source)"
							:data-origin="originOfItem(source)!.origin"
							data-test="group-source-origin"
							label
							:prepend-icon="originOfItem(source)!.icon"
							size="x-small"
							variant="outlined"
						>
							{{ $t(originOfItem(source)!.labelKey) }}
						</v-chip>

						<span v-if="peerNameOf(source)" class="text-caption text-medium-emphasis">
							{{ $t('media.source.via_peer', { peer: peerNameOf(source) }) }}
						</span>

						<QualityChip :quality="source.quality" size="x-small" />

						<span v-if="source.bytes !== null" class="text-caption text-medium-emphasis">
							<ByteSize :bytes="source.bytes" />
						</span>

						<CompanionMarks :companions="source.companions" />
					</span>
				</template>
			</v-radio>
		</v-radio-group>

		<p v-if="ordered.length === 0" class="text-caption text-medium-emphasis">
			{{ $t('media.source.none') }}
		</p>
	</div>
</template>

<style lang="scss">
	.group-sources {
		&_group {
			margin-top: 0;
		}

		&_label {
			display: inline-flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}

		&_name {
			font-weight: 500;
		}
	}
</style>
