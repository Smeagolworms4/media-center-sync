<script lang="ts" setup>
	import type { RunSyncRequest, SyncPlan } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import { useRouter } from 'vue-router';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import PlanForm from '@/components/sync/PlanForm.vue';
	import SyncPreviewDialog from '@/components/sync/SyncPreviewDialog.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';

	defineOptions({ name: 'SyncPlanPage' });

	/**
	 * The plan editor, with the preview beside it.
	 *
	 * The preview is asked with exactly the body a run would take, which is the
	 * only way "this is what it will pull" can be a statement rather than a hope —
	 * the same code on the API computes both.
	 */
	const props = defineProps<{ id: string }>();

	const syncStore = useSyncStore();
	const servicesStore = useServicesStore();
	const librariesStore = useLibrariesStore();
	const router = useRouter();
	const { notify } = useNotifier();

	const plan = ref<SyncPlan | null>(null);
	const loading = ref(true);
	const failed = ref(false);
	const previewOpen = ref(false);
	const previewRequest = ref<RunSyncRequest | null>(null);

	/** `new` is the editor with nothing behind it yet, not a plan that went missing. */
	const creating = computed(() => props.id === 'new');

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			await Promise.all([
				servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
				librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
			]);
			plan.value = creating.value ? null : await syncStore.plan(props.id);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		void load();
	});

	function openPreview (request: RunSyncRequest): void {
		previewRequest.value = request;
		previewOpen.value = true;
	}

	async function onSaved (saved: SyncPlan): Promise<void> {
		plan.value = saved;
		void notify('sync.plan_saved');
		if (creating.value) {
			await router.replace({ name: 'sync-plan', params: { id: saved.id } });
		}
	}

	async function onRun (): Promise<void> {
		void notify('sync.run_started');
		await router.push({ name: 'sync' });
	}
</script>

<template>
	<div class="page-container sync-plan">
		<PageHeader
			icon="mdi-calendar-sync-outline"
			:loading="loading"
			:subtitle="$t('sync.plan.subtitle')"
			:title="creating ? $t('sync.plan.create') : plan?.name ?? $t('pages.sync_plan')"
		>
			<template #actions>
				<v-btn :to="{ name: 'sync' }" variant="text">{{ $t('actions.back') }}</v-btn>
			</template>
		</PageHeader>

		<ErrorState v-if="failed" @retry="load" />

		<v-card v-else-if="!loading">
			<v-card-text>
				<PlanForm
					:key="plan?.id ?? 'new'"
					:libraries="librariesStore.libraries"
					:plan="plan"
					:services="servicesStore.services"
					@cancel="router.push({ name: 'sync' })"
					@preview="openPreview"
					@saved="onSaved"
				/>
			</v-card-text>
		</v-card>

		<div v-else class="text-center py-10">
			<v-progress-circular color="primary" indeterminate size="36" />
		</div>

		<SyncPreviewDialog
			v-model="previewOpen"
			:request="previewRequest"
			@run="onRun"
		/>
	</div>
</template>
