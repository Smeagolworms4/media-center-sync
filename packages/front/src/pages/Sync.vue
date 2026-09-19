<script lang="ts" setup>
	import type { SyncJob, SyncPlan } from '@mcs/shared';
	import { SyncTrigger } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import CronHint from '@/components/common/CronHint.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import Confirm from '@/components/Confirm.vue';
	import JobRow from '@/components/sync/JobRow.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';

	defineOptions({ name: 'SyncPage' });

	/**
	 * The standing intents, and what they have actually done.
	 *
	 * Plans and jobs share this screen because neither answers anything alone: a
	 * plan that looks right and a last run that failed three times is the state
	 * people need to see, and two screens would hide exactly that pairing.
	 */
	const syncStore = useSyncStore();
	const servicesStore = useServicesStore();
	const librariesStore = useLibrariesStore();
	const { notify, tryCallback } = useNotifier();

	const failed = ref(false);
	const busyId = ref<string | null>(null);
	const removing = ref<SyncPlan | null>(null);
	const removeBusy = ref(false);

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await Promise.all([
				syncStore.loadPlans(),
				syncStore.loadJobs({ page: 1, limit: 20 }),
				servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
				librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
			]);
		} catch {
			failed.value = true;
		}
	}

	onMounted(() => {
		void load();
	});

	const plans = computed(() => syncStore.plans);

	function sourceNames (plan: SyncPlan): string {
		if (plan.sourceServiceIds.length === 0) {
			return '';
		}
		return plan.sourceServiceIds
			.map(id => servicesStore.byId[id]?.name ?? id)
			.join(' → ');
	}

	function targetName (plan: SyncPlan): string | null {
		return plan.targetLibraryId
			? librariesStore.byId[plan.targetLibraryId]?.name ?? plan.targetLibraryId
			: null;
	}

	const toggleEnabled = tryCallback(async (plan: SyncPlan) => {
		busyId.value = plan.id;
		try {
			await syncStore.updatePlan(plan.id, { enabled: !plan.enabled });
		} finally {
			busyId.value = null;
		}
	});

	const runNow = tryCallback(async (plan: SyncPlan) => {
		busyId.value = plan.id;
		try {
			await syncStore.run({ planId: plan.id });
			void notify('sync.run_started');
		} finally {
			busyId.value = null;
		}
	});

	const cancelJob = tryCallback(async (job: SyncJob) => {
		await syncStore.cancelJob(job.id);
		void notify('sync.job_cancelled');
	});

	const confirmRemove = tryCallback(async () => {
		if (!removing.value) {
			return;
		}
		removeBusy.value = true;
		try {
			await syncStore.deletePlan(removing.value.id);
			removing.value = null;
			void notify('sync.plan_removed');
		} finally {
			removeBusy.value = false;
		}
	});
</script>

<template>
	<div class="page-container sync">
		<PageHeader
			icon="mdi-sync"
			:loading="syncStore.loadingPlans"
			:subtitle="$t('sync.subtitle')"
			:title="$t('pages.sync')"
		>
			<template #actions>
				<v-btn
					color="primary"
					data-test="plan-create"
					prepend-icon="mdi-plus"
					:to="{ name: 'sync-plan', params: { id: 'new' } }"
				>
					{{ $t('sync.plan.create') }}
				</v-btn>
			</template>
		</PageHeader>

		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<v-card data-test="plan-list">
				<v-card-title class="text-subtitle-1">{{ $t('sync.plans') }}</v-card-title>

				<EmptyState
					v-if="!syncStore.loadingPlans && plans.length === 0"
					icon="mdi-calendar-blank-outline"
					:text="$t('sync.no_plans_text')"
					:title="$t('sync.no_plans_title')"
				>
					<v-btn
						color="primary"
						:to="{ name: 'sync-plan', params: { id: 'new' } }"
					>
						{{ $t('sync.plan.create') }}
					</v-btn>
				</EmptyState>

				<v-list v-else lines="three">
					<v-list-item v-for="plan of plans" :key="plan.id" data-test="plan-row">
						<v-list-item-title>
							<router-link
								class="sync_link"
								:to="{ name: 'sync-plan', params: { id: plan.id } }"
							>
								{{ plan.name }}
							</router-link>

							<v-chip class="ml-2" label size="small" variant="tonal">
								{{ $t(`sync.trigger.${plan.trigger}`) }}
							</v-chip>

							<v-chip
								v-if="!plan.enabled"
								class="ml-2"
								color="state-unknown"
								label
								size="small"
								variant="tonal"
							>
								{{ $t('sync.plan.disabled') }}
							</v-chip>
						</v-list-item-title>

						<v-list-item-subtitle>
							{{ plan.sourceServiceIds.length === 0
								? $t('sync.plan.sources_default')
								: `${$t('sync.plan.sources')}: ${sourceNames(plan)}` }}
							<template v-if="targetName(plan)">
								· {{ $t('sync.plan.target') }}: {{ targetName(plan) }}
							</template>
						</v-list-item-subtitle>

						<v-list-item-subtitle>
							{{ $t('sync.plan.last_run') }} <RelativeDate :date="plan.lastRunAt" />

							<template v-if="plan.nextRunAt">
								· {{ $t('sync.plan.next_run') }} <RelativeDate :date="plan.nextRunAt" />
							</template>
						</v-list-item-subtitle>

						<CronHint
							v-if="plan.trigger === SyncTrigger.SCHEDULE"
							:expression="plan.schedule"
						/>

						<template #append>
							<div class="sync_actions">
								<v-btn
									data-test="plan-run"
									:loading="busyId === plan.id"
									size="small"
									variant="tonal"
									@click="runNow(plan)"
								>
									{{ $t('sync.plan.run_now') }}
								</v-btn>

								<v-btn
									data-test="plan-toggle"
									:loading="busyId === plan.id"
									size="small"
									variant="text"
									@click="toggleEnabled(plan)"
								>
									{{ plan.enabled ? $t('sync.plan.disable') : $t('sync.plan.enable') }}
								</v-btn>

								<v-btn
									data-test="plan-edit"
									icon="mdi-pencil-outline"
									size="small"
									:to="{ name: 'sync-plan', params: { id: plan.id } }"
									variant="text"
								/>

								<v-btn
									color="error"
									data-test="plan-remove"
									icon="mdi-delete-outline"
									size="small"
									variant="text"
									@click="removing = plan"
								/>
							</div>
						</template>
					</v-list-item>
				</v-list>
			</v-card>

			<v-card class="mt-4" data-test="job-list">
				<v-card-title class="text-subtitle-1">{{ $t('sync.jobs') }}</v-card-title>

				<v-card-text>
					<EmptyState
						v-if="!syncStore.loadingJobs && syncStore.jobs.length === 0"
						icon="mdi-history"
						:text="$t('sync.no_jobs_text')"
						:title="$t('sync.no_jobs_title')"
					/>

					<template v-else>
						<JobRow
							v-for="job of syncStore.jobs"
							:key="job.id"
							:job="job"
							@cancel="cancelJob"
						/>
					</template>
				</v-card-text>
			</v-card>
		</template>

		<Confirm
			:loading="removeBusy"
			:model-value="removing !== null"
			:text="$t('sync.plan.remove_confirm', { name: removing?.name ?? '' })"
			:title="$t('sync.plan.remove_title')"
			@cancel="removing = null"
			@confirm="confirmRemove"
		/>
	</div>
</template>

<style lang="scss">
	.sync {
		&_link {
			color: inherit;
			text-decoration: none;

			&:hover {
				text-decoration: underline;
			}
		}

		&_actions {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-wrap: wrap;
			justify-content: flex-end;
		}
	}
</style>
