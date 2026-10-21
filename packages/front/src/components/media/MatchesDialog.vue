<script lang="ts" setup>
	import type { MediaItem, MediaMatch } from '@mcs/shared';
	import { ref, watch } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';
	import Window from '@/components/Window.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useMediaStore } from '@/stores/media';
	import { useServicesStore } from '@/stores/services';

	/**
	 * Why the gateway believes two items are the same media.
	 *
	 * Each correlation is a row of its own with the strategy that produced it and a
	 * confidence, so a wrong one can be explained and undone. A match nobody can
	 * overrule is a match nobody trusts, which is the whole reason this dialog
	 * offers both a confirmation and a deletion.
	 */
	const props = defineProps<{ itemId: string }>();

	const open = defineModel<boolean>({ default: false });

	const mediaStore = useMediaStore();
	const servicesStore = useServicesStore();
	const { notify, tryCallback } = useNotifier();

	const matches = ref<MediaMatch[]>([]);
	const loading = ref(false);
	const failed = ref(false);
	const busy = ref<string | null>(null);

	/**
	 * Correlating two media by hand, which is what every rule having said nothing leaves.
	 *
	 * The scorer refuses a pair for good reasons that are sometimes wrong about one
	 * media: one title twenty-five years apart is a remake to a rule and one film to the
	 * person holding both posters. Until this, a correlation could be confirmed or
	 * deleted and never created, so that person had nowhere to say so.
	 */
	const search = ref('');
	const candidates = ref<MediaItem[]>([]);
	const looking = ref(false);
	/** Whether anything has been looked for yet, which is not the same as finding none. */
	const asked = ref(false);
	const pairing = ref<string | null>(null);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			matches.value = await mediaStore.matches(props.itemId);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	watch(open, isOpen => {
		if (isOpen) {
			search.value = '';
			candidates.value = [];
			asked.value = false;
			void load();
		}
	});

	const find = tryCallback(async () => {
		looking.value = true;
		try {
			candidates.value = await mediaStore.pairCandidates(props.itemId, (search.value ?? '').trim());
			asked.value = true;
		} finally {
			looking.value = false;
		}
	});

	const pair = tryCallback(async (candidate: MediaItem) => {
		pairing.value = candidate.id;
		try {
			const made = await mediaStore.pairWith(props.itemId, candidate.id);
			// Put at the top of the list it now belongs to, and taken out of the one it
			// was offered from: the same row cannot be both an option and a correlation.
			matches.value = [made, ...matches.value.filter(one => one.id !== made.id)];
			candidates.value = candidates.value.filter(one => one.id !== candidate.id);
			void notify('media.match.paired');
		} finally {
			pairing.value = null;
		}
	});

	function serviceName (serviceId: string): string {
		return servicesStore.byId[serviceId]?.name ?? serviceId;
	}

	const confirm = tryCallback(async (match: MediaMatch) => {
		busy.value = match.id;
		try {
			const updated = await mediaStore.confirmMatch(props.itemId, match.id);
			const index = matches.value.findIndex(one => one.id === match.id);
			if (index !== -1) {
				matches.value[index] = updated;
			}
			void notify('media.match.confirmed');
		} finally {
			busy.value = null;
		}
	});

	const drop = tryCallback(async (match: MediaMatch) => {
		busy.value = match.id;
		try {
			await mediaStore.removeMatch(props.itemId, match.id);
			matches.value = matches.value.filter(one => one.id !== match.id);
			void notify('media.match.removed');
		} finally {
			busy.value = null;
		}
	});
</script>

<template>
	<Window v-model="open" :max-width="720" :title="$t('media.match.title')">
		<div class="matches-dialog" data-test="matches-dialog">
			<!--
				Above the list and outside its loading chain, deliberately: the media that
				needs this most is the one with no correlation at all, and that is exactly
				when the rest of this dialog is an empty state.
			-->
			<div class="matches-dialog_pair mb-4" data-test="match-pair">
				<v-text-field
					v-model="search"
					clearable
					data-test="match-pair-search"
					density="compact"
					hide-details
					:label="$t('media.match.pair.label')"
					prepend-inner-icon="mdi-magnify"
					variant="outlined"
					@keyup.enter="find"
				/>

				<p class="text-caption text-medium-emphasis mt-1 mb-0">
					{{ $t('media.match.pair.hint') }}
				</p>

				<v-progress-linear v-if="looking" class="mt-2" color="primary" indeterminate />

				<v-list v-else-if="candidates.length > 0" class="mt-2" density="compact">
					<v-list-item
						v-for="one of candidates"
						:key="one.id"
						data-test="match-pair-row"
					>
						<v-list-item-title>{{ one.title }}</v-list-item-title>

						<v-list-item-subtitle>
							{{ serviceName(one.serviceId) }}
							<template v-if="one.year"> · {{ one.year }}</template>
						</v-list-item-subtitle>

						<template #append>
							<v-btn
								data-test="match-pair-apply"
								:loading="pairing === one.id"
								size="small"
								variant="tonal"
								@click="pair(one)"
							>
								{{ $t('media.match.pair.action') }}
							</v-btn>
						</template>
					</v-list-item>
				</v-list>

				<p
					v-else-if="asked"
					class="text-caption text-medium-emphasis mt-2 mb-0"
					data-test="match-pair-none"
				>
					{{ $t('media.match.pair.none') }}
				</p>
			</div>

			<div v-if="loading" class="text-center py-6">
				<v-progress-circular color="primary" indeterminate size="32" />
			</div>

			<ErrorState v-else-if="failed" @retry="load" />

			<EmptyState
				v-else-if="matches.length === 0"
				icon="mdi-link-variant-off"
				:text="$t('media.match.empty_text')"
				:title="$t('media.match.empty_title')"
			/>

			<v-list v-else class="matches-dialog_list" lines="two">
				<v-list-item
					v-for="match of matches"
					:key="match.id"
					class="matches-dialog_item"
					data-test="match-row"
				>
					<template #prepend>
						<SyncStateIcon :state="match.state" />
					</template>

					<v-list-item-title>{{ serviceName(match.remoteServiceId) }}</v-list-item-title>

					<v-list-item-subtitle>
						{{ $t(`media.match.strategy.${match.strategy}`) }}
						· {{ $t('media.match.confidence', { value: Math.round(match.confidence * 100) }) }}
						<template v-if="match.reason"> · {{ match.reason }}</template>

						<template v-if="match.confirmedAt">
							· {{ $t('media.match.confirmed_at') }}
							<RelativeDate :date="match.confirmedAt" />
						</template>
					</v-list-item-subtitle>

					<template #append>
						<v-btn
							v-if="!match.confirmedAt"
							data-test="match-confirm"
							:loading="busy === match.id"
							size="small"
							variant="tonal"
							@click="confirm(match)"
						>
							{{ $t('media.match.confirm') }}
						</v-btn>

						<v-btn
							class="ml-2"
							color="error"
							data-test="match-remove"
							icon="mdi-link-off"
							:loading="busy === match.id"
							size="small"
							variant="text"
							@click="drop(match)"
						/>
					</template>
				</v-list-item>
			</v-list>
		</div>
	</Window>
</template>

<style lang="scss">
	.matches-dialog {
		&_item {
			padding-left: 8px;
		}
	}
</style>
