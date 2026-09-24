<script lang="ts" setup>
	import type { MediaGroupSource, MediaService, MediaVersion, TransferProgress } from '@mcs/shared';
	import { FINISHED_TRANSFER_STATES, SyncState } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import CompanionMarks from '@/components/media/CompanionMarks.vue';
	import QualityChip from '@/components/media/QualityChip.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';
	import { type MediaOriginDescriptor, useMediaOrigin } from '@/composables/useMediaOrigin';

	/**
	 * What there is to hold, and which of it to pull.
	 *
	 * The list is versions rather than servers, because those are two different
	 * questions and only one of them is the one being asked. Three friends holding the
	 * same file are one thing to fetch; a 1080p and a 2160p under one title are two,
	 * and somebody who asked for the extended cut and received the theatrical one has
	 * been given the wrong film. So a row is a version, with the copies of it
	 * underneath, and several rows can be chosen at once — which is the whole point:
	 * holding two of the three cuts is an ordinary thing to want.
	 *
	 * Each row says whether we already have it, because that is the first thing anybody
	 * looks for, and a version only we hold has nothing to offer — it is listed, marked
	 * and not selectable, rather than hidden, since "you already have this one" is an
	 * answer and an empty list is not.
	 *
	 * Each copy also says what sits beside it — the `.nfo`, the artwork, the subtitles —
	 * because a copy that is bigger and better encoded but has no metadata is not
	 * obviously the one to pull. And each says how far away it is: a copy on a friend's
	 * server and a copy on somebody their friend introduced are not the same offer.
	 *
	 * Each row carries the one action that makes sense for it, and that is what this
	 * screen is for. A checkbox said nothing: neither what ticking it would do, nor when
	 * it would happen, and it sat beside copies with nothing to fetch — "we alone have
	 * this one" with a box to tick next to it. So a copy only somebody else has offers
	 * to be fetched, a copy being fetched shows how far along it is, and a copy on our
	 * own disk offers to be erased, behind a confirmation that names the file.
	 *
	 * Scheduling stays where it was, on the button above this list: "fetch this now" and
	 * "fetch this whenever it appears" are two different intentions and were never the
	 * same control.
	 */
	const props = withDefaults(defineProps<{
		sources?: MediaGroupSource[];
		/**
		 * The distinct versions the gateway could tell apart, ours first.
		 *
		 * Empty is ordinary rather than an error: a copy nobody has fingerprinted cannot
		 * be said to be the same as, or different from, anything, so the list falls back
		 * to one row per copy — which is what it always was.
		 */
		versions?: MediaVersion[];
		/** The registered services, read only for the priority they are ranked by. */
		services?: MediaService[];
		/** Peer names by identifier, for the sources reached through a friend. */
		peerNames?: Record<string, string>;
		/**
		 * What is being fetched right now, by the item being fetched.
		 *
		 * Keyed by item rather than by transfer because that is the question a row asks:
		 * a row knows which copy it is, and has no reason to know what the transfer that
		 * carries it is called.
		 */
		transfers?: Record<string, TransferProgress>;
		disabled?: boolean;
	}>(), {
		sources: () => [],
		versions: () => [],
		services: () => [],
		peerNames: () => ({}),
		transfers: () => ({}),
		disabled: false,
	});

	const emit = defineEmits<{
		download: [itemId: string];
		remove: [source: MediaGroupSource];
	}>();

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

	const defaultSource = computed(() => ordered.value.find(one => !one.local) ?? ordered.value[0] ?? null);

	/** One thing to hold: a version when we can tell versions apart, a copy otherwise. */
	interface SourceOffer {
		key: string;
		edition: string | null;
		heldLocally: boolean;
		/** Every copy of it, in the order the gateway would consult them. */
		copies: MediaGroupSource[];
		/** The copy a pull would use, or null when only we have it. */
		from: MediaGroupSource | null;
	}

	const offers = computed<SourceOffer[]>(() => {
		const grouped: SourceOffer[] = [];
		const taken = new Set<string>();

		for (const version of props.versions) {
			const copies = ordered.value.filter(one => one.versionId === version.versionId);
			if (copies.length === 0) {
				continue;
			}
			for (const copy of copies) {
				taken.add(copy.itemId);
			}
			grouped.push({
				key: version.versionId,
				edition: version.edition,
				heldLocally: version.heldLocally,
				copies,
				from: copies.find(one => !one.local) ?? null,
			});
		}

		// Whatever the fingerprints could not place: one row each, which is what this
		// list was before versions existed. Folding them together on their titles would
		// be a guess, and the guess costs a file.
		for (const source of ordered.value) {
			if (taken.has(source.itemId)) {
				continue;
			}
			grouped.push({
				key: source.itemId,
				edition: source.edition,
				heldLocally: source.local,
				copies: [source],
				from: source.local ? null : source,
			});
		}

		return grouped;
	});

	const heldCount = computed(() => offers.value.filter(offer => offer.heldLocally).length);

	function labelOf (offer: SourceOffer): string {
		return offer.from?.serviceName ?? offer.copies[0]?.serviceName ?? '';
	}

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

	/**
	 * The transfer carrying one of this row's copies, or none.
	 *
	 * Any copy of the version, because a row is a version and fetching any of its copies
	 * is fetching the row. A finished transfer is not one: the row it left behind lives
	 * on the transfers screen, and a progress bar stuck at a hundred per cent under a
	 * media that now simply exists says nothing.
	 */
	function transferOf (offer: SourceOffer): TransferProgress | null {
		for (const copy of offer.copies) {
			const found = props.transfers[copy.itemId];

			if (found && !FINISHED_TRANSFER_STATES.includes(found.state)) {
				return found;
			}
		}

		return null;
	}

	function percentOf (transfer: TransferProgress): number {
		return transfer.bytesTotal > 0
			? Math.min(100, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100))
			: 0;
	}

	/** The copy of this row that sits on a disk we can write to, if there is one. */
	function ourCopy (offer: SourceOffer): MediaGroupSource | null {
		return offer.copies.find(one => one.local && one.path !== null) ?? null;
	}
</script>

<template>
	<div class="group-sources" data-test="source-picker">
		<p class="text-caption text-medium-emphasis mb-1">{{ $t('media.source.title') }}</p>

		<!--
			Which copy a scheduled run would take, stated rather than offered as a choice.
			The button above this list builds a schedule and follows the configured
			priority; the rows below are for acting on one copy now.
		-->
		<p v-if="offers.length > 0" class="text-caption text-medium-emphasis mb-2" data-test="source-default">
			{{ $t('media.source.follow_priority') }}
			<span v-if="defaultSource">
				{{ $t('media.source.follow_priority_hint', { name: defaultSource.serviceName }) }}
			</span>
		</p>

		<div class="group-sources_group">
			<div
				v-for="offer of offers"
				:key="offer.key"
				class="group-sources_option"
				:data-held="offer.heldLocally"
				:data-local="offer.copies[0].local"
				:data-state="offer.copies[0].sync"
				data-test="group-source"
			>
				<div class="group-sources_row">
					<span class="group-sources_label">
						<!--
							Only when the copy actually carries a state. A row of question
							marks beside a state the header already gives says nothing, and
							an older gateway simply does not send this field.
						-->
						<SyncStateIcon
							v-if="offer.copies[0].sync && offer.copies[0].sync !== SyncState.UNKNOWN"
							:size="16"
							:state="offer.copies[0].sync"
						/>

						<span class="group-sources_name">{{ labelOf(offer) }}</span>

						<v-chip
							v-if="offer.edition"
							data-test="group-source-edition"
							label
							size="x-small"
							variant="tonal"
						>
							{{ offer.edition }}
						</v-chip>

						<QualityChip :quality="offer.copies[0].quality" size="x-small" />

						<span v-if="offer.copies[0].bytes !== null" class="text-caption text-medium-emphasis">
							<ByteSize :bytes="offer.copies[0].bytes" />
						</span>

						<!--
							Holding a version is a fact worth stating and never a failure:
							a media whose three cuts we hold two of is finished business,
							not a half-broken sync, so this is a mark and not a warning.
						-->
						<v-chip
							v-if="offer.heldLocally"
							color="state-in-sync"
							data-test="group-source-ours"
							label
							size="x-small"
							variant="tonal"
						>
							{{ $t('media.version.held') }}
						</v-chip>

						<!--
							Only where the copy is not ours: the chip beside it already says
							so, and two chips saying the same word is noise on every row of
							a gateway with one server.
						-->
						<template v-for="copy of offer.copies" :key="copy.itemId">
							<v-chip
								v-if="!copy.local && originOfItem(copy)"
								:data-origin="originOfItem(copy)!.origin"
								data-test="group-source-origin"
								label
								:prepend-icon="originOfItem(copy)!.icon"
								size="x-small"
								variant="outlined"
							>
								{{ $t(originOfItem(copy)!.labelKey) }}
							</v-chip>

							<span v-if="peerNameOf(copy)" class="text-caption text-medium-emphasis">
								{{ $t('media.source.via_peer', { peer: peerNameOf(copy) }) }}
							</span>
						</template>

						<CompanionMarks :companions="offer.copies[0].companions" />
					</span>

					<!--
						One action per row, and the state of the copy decides which. A
						transfer in flight outranks both buttons: offering to fetch
						something already being fetched is how somebody ends up with two
						of it.
					-->
					<div class="group-sources_action">
						<div
							v-if="transferOf(offer)"
							class="group-sources_progress"
							data-test="group-source-progress"
							:title="$t(`transfer.state.${transferOf(offer)!.state}`)"
						>
							<v-progress-linear
								:aria-label="$t(`transfer.state.${transferOf(offer)!.state}`)"
								height="6"
								:model-value="percentOf(transferOf(offer)!)"
								rounded
							/>

							<span class="text-caption text-medium-emphasis">
								{{ percentOf(transferOf(offer)!) }}%
							</span>
						</div>

						<!--
							Not for a version already on our disk, however many servers also
							carry it. Fetching it would write a second copy of bytes we hold,
							which is the very offer that cost the owner twenty gigabytes — and
							it only became reachable here once two rows of one server could be
							related, which is what put a local and a remote copy on one row.
						-->
						<v-btn
							v-else-if="offer.from && !offer.heldLocally"
							data-test="group-source-download"
							:disabled="disabled"
							prepend-icon="mdi-download"
							size="small"
							variant="tonal"
							@click="emit('download', offer.from.itemId)"
						>
							{{ $t('media.source.download') }}
						</v-btn>

						<!--
                            Stated rather than left blank: "you already have this one" is
                            an answer, and an empty cell reads like something failed to
                            load.
                        -->
						<span
							v-else-if="!ourCopy(offer)"
							class="text-caption text-medium-emphasis"
							data-test="group-source-nothing"
						>
							{{ $t('media.version.nothing_to_pull') }}
						</span>

						<v-btn
							v-if="ourCopy(offer) && !transferOf(offer)"
							color="error"
							data-test="group-source-delete"
							:disabled="disabled"
							icon="mdi-trash-can-outline"
							size="small"
							:title="$t('media.source.delete')"
							variant="text"
							@click="emit('remove', ourCopy(offer)!)"
						/>
					</div>
				</div>
			</div>
		</div>

		<p
			v-if="offers.length > 0"
			class="text-caption text-medium-emphasis"
			data-test="source-selection"
		>
			{{ $t('media.version.here_count', { count: heldCount, total: offers.length }) }}
		</p>

		<p v-if="offers.length === 0" class="text-caption text-medium-emphasis">
			{{ $t('media.source.none') }}
		</p>
	</div>
</template>

<style lang="scss">
	.group-sources {
		&_group {
			margin-top: 0;
		}

		&_row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			flex-wrap: wrap;
			gap: 8px;
			padding: 4px 0;
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

		&_action {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			// Enough for a progress bar to read as one rather than as a dash, and
			// little enough that a row of one server does not look padded out.
			min-width: 120px;
			justify-content: flex-end;
		}

		&_progress {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			width: 100%;
		}
	}
</style>
