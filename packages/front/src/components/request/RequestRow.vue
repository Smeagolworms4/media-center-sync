<script lang="ts" setup>
	import type { MediaRequestView } from '@mcs/shared';
	import { Right } from '@mcs/shared';
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import RequestArtwork from '@/components/request/RequestArtwork.vue';
	import RequestHoldings from '@/components/request/RequestHoldings.vue';
	import RequestStateChip from '@/components/request/RequestStateChip.vue';

	/**
	 * One ask, and what this gateway can say about it.
	 *
	 * The row exists to be acted on, so it says the two things an action depends on
	 * before it offers either: whether any copy of ours answers the ask, and which
	 * seasons of it nothing here holds. Neither button decides anything on its own —
	 * the API's `fulfillable` says whether closing the ask would be telling the truth,
	 * and the search is handed over as a suggestion for somebody to press.
	 *
	 * A request source hands over identifiers and frequently no title at all, so the
	 * nameless row is the normal case rather than the edge: it falls back to what the
	 * source says the work is, and failing that to the identifiers it was asked by,
	 * because a blank line nobody can act on is worse than a number somebody can look up.
	 */
	const props = withDefaults(defineProps<{
		request: MediaRequestView;
		/** Service identifier to display name, for naming the machine a copy sits on. */
		serviceNames?: Record<string, string>;
		/** True while this row's own fulfil call is in flight. */
		busy?: boolean;
	}>(), {
		serviceNames: () => ({}),
		busy: false,
	});

	const emit = defineEmits<{
		fulfil: [request: MediaRequestView];
		search: [request: MediaRequestView];
	}>();

	const { t } = useI18n();

	/*
	 * The API already fills `title` from the source's details, and this repeats the
	 * fallback rather than trusting it: the field is nullable on the contract, a source
	 * that names nothing is a documented case, and a row whose name silently depended on
	 * one layer having done the substitution would come out blank the day it did not.
	 */
	const name = computed(() => props.request.title ?? props.request.details?.title ?? null);

	const year = computed(() => props.request.details?.year ?? null);

	/**
	 * What the ask is, when nothing can name it.
	 *
	 * The identifiers are the only thing a request source is certain to carry, and they
	 * are what somebody pastes into a metadata site to find out what they are looking at.
	 */
	const identifiers = computed(() => {
		const parts: string[] = [];

		if (props.request.tmdbId !== null) {
			parts.push(t('request.tmdb', { id: props.request.tmdbId }));
		}
		if (props.request.tvdbId !== null) {
			parts.push(t('request.tvdb', { id: props.request.tvdbId }));
		}

		return parts.length > 0 ? parts.join(' · ') : t('request.no_identifier');
	});

	/** Every season the source says was asked for, which is empty for a film. */
	const askedSeasons = computed(
		() => [...new Set(props.request.seasons.map(season => season.seasonNumber))]);
</script>

<template>
	<div
		class="request-row"
		:data-held="request.heldAlready"
		:data-request="request.id"
		data-test="request-row"
	>
		<RequestArtwork
			:kind="request.kind"
			:title="name"
			:url="request.details?.artworkUrl ?? null"
		/>

		<div class="request-row_body">
			<div class="request-row_head">
				<!--
					Whether anything could name this at all, on the row itself: a request
					source that carries identifiers and no title is the ordinary case, and a
					journey has to be able to tell that row from one whose name is missing
					because a fallback broke.
				-->
				<span
					class="request-row_title"
					:data-named="name !== null"
					data-test="request-title"
				>
					{{ name ?? $t('request.unnamed') }}
				</span>

				<span
					v-if="year !== null"
					class="text-caption text-medium-emphasis"
					data-test="request-year"
				>
					{{ year }}
				</span>

				<v-chip data-test="request-kind" label size="small" variant="outlined">
					{{ $t(`media.kind.${request.kind}`) }}
				</v-chip>

				<RequestStateChip :state="request.state" />

				<!--
					Said on the row, because it changes what the name means: our own copy's
					title is a spelling a media server matched, while this one is whatever
					the request source believes the work is called.
				-->
				<v-chip
					v-if="request.details !== null"
					data-test="request-from-source"
					label
					size="x-small"
					variant="text"
				>
					{{ $t('request.from_source') }}
				</v-chip>
			</div>

			<p class="text-caption text-medium-emphasis mb-0" data-test="request-asker">
				{{ request.requestedBy === null
					? $t('request.asked_by_unknown')
					: $t('request.asked_by', { name: request.requestedBy }) }}
				· <RelativeDate :date="request.requestedAt" />
			</p>

			<p
				v-if="name === null"
				class="text-caption text-medium-emphasis mb-0"
				data-test="request-identifiers"
			>
				{{ identifiers }}
			</p>

			<p
				v-if="request.details?.overview"
				class="request-row_overview text-body-2 text-medium-emphasis mb-0"
				data-test="request-overview"
			>
				{{ request.details.overview }}
			</p>

			<RequestHoldings
				v-if="request.holdings.length > 0"
				:holdings="request.holdings"
				:service-names="serviceNames"
			/>

			<p v-else class="text-caption text-medium-emphasis mb-0" data-test="request-held-none">
				{{ $t('request.held_none') }}
			</p>

			<p
				v-if="request.missingSeasons.length > 0"
				class="text-caption mb-0"
				data-test="request-missing-seasons"
			>
				{{ $t('request.missing_seasons', { seasons: request.missingSeasons.join(', ') }) }}
			</p>

			<p
				v-else-if="askedSeasons.length > 0"
				class="text-caption text-medium-emphasis mb-0"
				data-test="request-asked-seasons"
			>
				{{ $t('request.asked_seasons', { seasons: askedSeasons.join(', ') }) }}
			</p>
		</div>

		<div class="request-row_actions">
			<!--
				Offered on the API's verdict alone. It is false for a request the source
				already considers available and for one we hold nothing for, and second
				guessing it here — on a season count, say — is how a screen closes an ask
				on half of what was asked for.
			-->
			<v-btn
				v-if="request.fulfillable && $isGranted(Right.TRANSFER_MANAGE)"
				color="state-in-sync"
				data-test="request-fulfil"
				:loading="busy"
				prepend-icon="mdi-check-decagram-outline"
				size="small"
				variant="tonal"
				@click="emit('fulfil', request)"
			>
				{{ $t('request.fulfil') }}
			</v-btn>

			<!--
				A suggestion, and nothing more: the press opens a search panel, and no
				request anywhere causes anything to be fetched. Wiring the two together
				would let anybody with an account on somebody else's Seerr spend this
				gateway's disk.
			-->
			<v-btn
				v-if="request.suggestion !== null"
				data-test="request-search"
				prepend-icon="mdi-magnify"
				size="small"
				variant="tonal"
				@click="emit('search', request)"
			>
				{{ $t('request.search') }}
			</v-btn>

			<span v-else class="text-caption text-medium-emphasis" data-test="request-no-search">
				{{ $t('request.no_search') }}
			</span>
		</div>
	</div>
</template>

<style lang="scss">
	.request-row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 10px 0;

		& + & {
			border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
		}

		&_body {
			display: flex;
			flex-direction: column;
			gap: 4px;
			min-width: 0;
			flex: 1 1 auto;
		}

		&_head {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}

		&_title {
			font-weight: 500;
			overflow-wrap: anywhere;
		}

		&_overview {
			// Three lines of it: enough to recognise a work somebody else asked for,
			// without a paragraph pushing the actions of the next row off the screen.
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 3;
			overflow: hidden;
		}

		&_actions {
			display: flex;
			flex-direction: column;
			align-items: flex-end;
			gap: 6px;
			flex: 0 0 auto;
		}
	}
</style>
