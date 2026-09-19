<script lang="ts" setup>
	import type { RunSyncRequest, SyncPreview } from '@mcs/shared';
	import { ref, watch } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import SyncStateIcon from '@/components/media/SyncStateIcon.vue';
	import Window from '@/components/Window.vue';
	import { useSyncStore } from '@/stores/sync';

	/**
	 * What a run would do, before it does it.
	 *
	 * The preview is asked with exactly the body the run will take, so what is
	 * listed here — the items, the source each one comes from, the path it lands on
	 * and the byte count — is what will happen rather than an approximation of it.
	 */
	const props = defineProps<{ request: RunSyncRequest | null }>();

	const open = defineModel<boolean>({ default: false });

	const emit = defineEmits<{ run: [request: RunSyncRequest] }>();

	const syncStore = useSyncStore();

	const preview = ref<SyncPreview | null>(null);
	const loading = ref(false);
	const failed = ref(false);
	const running = ref(false);

	async function load (): Promise<void> {
		if (!props.request) {
			return;
		}
		loading.value = true;
		failed.value = false;
		try {
			preview.value = await syncStore.preview(props.request);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	watch(open, isOpen => {
		if (isOpen) {
			preview.value = null;
			void load();
		}
	});

	async function run (): Promise<void> {
		if (!props.request) {
			return;
		}
		running.value = true;
		try {
			await syncStore.run(props.request);
			emit('run', props.request);
			open.value = false;
		} finally {
			running.value = false;
		}
	}
</script>

<template>
	<Window v-model="open" :max-width="860" :title="$t('sync.preview.title')">
		<div class="sync-preview" data-test="sync-preview">
			<div v-if="loading" class="text-center py-6">
				<v-progress-circular color="primary" indeterminate size="32" />
			</div>

			<ErrorState v-else-if="failed" @retry="load" />

			<EmptyState
				v-else-if="preview && preview.items.length === 0"
				icon="mdi-check-all"
				:text="$t('sync.preview.empty_text')"
				:title="$t('sync.preview.empty_title')"
			/>

			<template v-else-if="preview">
				<p class="text-body-2 mb-3">
					{{ $t('sync.preview.summary', { count: preview.itemsPlanned }, preview.itemsPlanned) }}
					— <ByteSize :bytes="preview.bytesPlanned" />
				</p>

				<v-table class="sync-preview_table" density="compact">
					<thead>
						<tr>
							<th />
							<th>{{ $t('sync.preview.item') }}</th>
							<th>{{ $t('sync.preview.source') }}</th>
							<th>{{ $t('sync.preview.target_path') }}</th>
							<th class="text-right">{{ $t('sync.preview.bytes') }}</th>
						</tr>
					</thead>

					<tbody>
						<tr v-for="item of preview.items" :key="item.itemId" data-test="preview-row">
							<td><SyncStateIcon :state="item.state" /></td>
							<td>{{ item.title }}</td>
							<td>{{ item.sourceServiceName }}</td>
							<td class="text-break-anywhere">{{ item.targetPath }}</td>
							<td class="text-right"><ByteSize :bytes="item.bytes" /></td>
						</tr>
					</tbody>
				</v-table>
			</template>
		</div>

		<template #actions>
			<v-spacer />

			<v-btn variant="text" @click="open = false">{{ $t('actions.close') }}</v-btn>

			<v-btn
				color="primary"
				data-test="sync-run"
				:disabled="!preview || preview.items.length === 0"
				:loading="running"
				@click="run"
			>
				{{ $t('sync.preview.run') }}
			</v-btn>
		</template>
	</Window>
</template>

<style lang="scss">
	.sync-preview {
		&_table {
			font-size: 13px;
		}
	}
</style>
