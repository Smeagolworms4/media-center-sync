<script lang="ts" setup>
	import type { MediaRequestView } from '@mcs/shared';
	import { MediaRequestState } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RequestRow from '@/components/request/RequestRow.vue';
	import RequestSearchDialog from '@/components/request/RequestSearchDialog.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { queryRef, queryTypes } from '@/libs/vue3-query-ref';
	import { useRequestsStore } from '@/stores/requests';
	import { useServicesStore } from '@/stores/services';

	defineOptions({ name: 'RequestsPage' });

	/**
	 * What the household asked for, and what became of it.
	 *
	 * The screen exists for one judgement nothing else can make: most of a year's asks
	 * arrive by some other route, so an open request is usually one the household already
	 * holds and nobody has said so. Every row therefore leads with whether a copy of ours
	 * answers it and which seasons are still missing, and only then offers the two things
	 * somebody can do — close the ask over there, or look for what is missing.
	 *
	 * Nothing on this page fetches anything. The suggested search is opened and run by
	 * hand, which is the line the whole feature is drawn along: a stranger with an account
	 * on the household's Seerr must not be able to spend this gateway's disk.
	 */
	const requestsStore = useRequestsStore();
	const servicesStore = useServicesStore();
	const { t } = useI18n();
	const { notify, tryCallback } = useNotifier();

	/**
	 * In the address, so a link to this screen carries which half it was showing.
	 *
	 * Left empty by default rather than defaulted to a state, because the API's own
	 * default is the open asks — which is the list somebody came here to act on.
	 */
	const state = queryRef<MediaRequestState>('state', queryTypes.stringEnum({
		values: Object.values(MediaRequestState),
	}));

	const failed = ref(false);
	/** The row whose fulfil call is in flight, so one button spins and not all of them. */
	const busyId = ref<string | null>(null);
	const searching = ref<MediaRequestView | null>(null);
	const searchOpen = ref(false);

	// `item-props`, so an option carries a mark of its own: the labels are translated and
	// a journey that picked one by its wording would break the day somebody reads the
	// interface in another language.
	const stateItems = computed(() => Object.values(MediaRequestState).map(value => ({
		'value': value,
		'title': t(`request.state.${value}`),
		'data-test': 'request-state-option',
		'data-state': value,
	})));

	/** Identifier to name, so a holding can be traced to the machine it sits on. */
	const serviceNames = computed(() => Object.fromEntries(
		servicesStore.services.map(service => [service.id, service.name])));

	async function load (): Promise<void> {
		failed.value = false;

		/*
		 * The service names, which only decide how a holding reads. A gateway that cannot
		 * answer this costs a row the name of a machine and nothing else, so it is not
		 * allowed to be what makes the page an error state.
		 */
		void servicesStore.load().catch(() => undefined);

		try {
			await requestsStore.load(state.value === null ? {} : { state: state.value });
		} catch {
			// A gateway with no request source is not a failure and has its own words on
			// the screen; anything else is the generic one, with a way to try again.
			failed.value = !requestsStore.notConfigured;
		}
	}

	onMounted(() => {
		void load();
	});

	watch(state, () => {
		void load();
	});

	const fulfil = tryCallback(async (request: MediaRequestView) => {
		busyId.value = request.id;
		try {
			await requestsStore.markFulfilled(request.id);

			void notify('request.fulfilled');
		} finally {
			busyId.value = null;
		}
	});

	/**
	 * Hand the request's own suggestion to the search, unchanged.
	 *
	 * The term was worked out by the gateway against both our catalogue and the source's
	 * name for the work; rebuilding one here from the row's title would search for
	 * something nobody proposed.
	 */
	function openSearch (request: MediaRequestView): void {
		searching.value = request;
		searchOpen.value = true;
	}
</script>

<template>
	<div class="page-container requests">
		<PageHeader
			icon="mdi-playlist-star"
			:loading="requestsStore.loading"
			:subtitle="$t('request.subtitle')"
			:title="$t('pages.requests')"
		>
			<template #actions>
				<v-select
					v-model="state"
					class="requests_filter"
					clearable
					data-test="request-state-filter"
					density="compact"
					hide-details
					item-props
					item-title="title"
					item-value="value"
					:items="stateItems"
					:label="$t('request.filter_state')"
				/>

				<v-btn
					data-test="request-refresh"
					:loading="requestsStore.loading"
					prepend-icon="mdi-refresh"
					variant="text"
					@click="load"
				>
					{{ $t('actions.refresh') }}
				</v-btn>
			</template>
		</PageHeader>

		<!--
			A gateway nobody configured a request source on is not broken, and the API says
			so with a conflict naming the screen that fixes it. Showing the generic failure
			here would send somebody hunting for a fault in a feature they never turned on.
		-->
		<div v-if="requestsStore.notConfigured" data-test="request-not-configured">
			<EmptyState
				icon="mdi-cog-off-outline"
				:text="$t('error.request_source.not_configured')"
				:title="$t('request.not_configured_title')"
			>
				<v-btn color="primary" data-test="request-configure" :to="{ name: 'settings' }">
					{{ $t('request.configure') }}
				</v-btn>
			</EmptyState>
		</div>

		<ErrorState v-else-if="failed" @retry="load" />

		<v-card v-else data-test="request-list">
			<EmptyState
				v-if="!requestsStore.loading && requestsStore.requests.length === 0"
				icon="mdi-inbox-outline"
				:text="$t('request.none_text')"
				:title="$t('request.none_title')"
			/>

			<v-card-text v-else>
				<RequestRow
					v-for="request of requestsStore.requests"
					:key="request.id"
					:busy="busyId === request.id"
					:request="request"
					:service-names="serviceNames"
					@fulfil="fulfil"
					@search="openSearch"
				/>
			</v-card-text>
		</v-card>

		<RequestSearchDialog
			v-model="searchOpen"
			:suggestion="searching?.suggestion ?? null"
			:title="searching?.title ?? searching?.details?.title ?? null"
		/>
	</div>
</template>

<style lang="scss">
	.requests {
		&_filter {
			min-width: 200px;
		}
	}
</style>
