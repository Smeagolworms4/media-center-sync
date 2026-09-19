<script lang="ts" setup>
	import type { MediaMatch } from '@mcs/shared';
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
			void load();
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
