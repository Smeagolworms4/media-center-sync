<script lang="ts" setup>
	import type { SyncJob, SyncPlan } from '@mcs/shared';
	import { HistoryView, SyncTrigger } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
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
	 *
	 * The runs list opens on what is still going. Finished runs are not destroyed —
	 * they are under "Finished", and the screen says so, because a list that silently
	 * drops rows teaches people not to believe the next one either.
	 *
	 * A run that finishes while this page is open stays where it is until the next
	 * load. That is deliberate: the moment somebody is watching a run complete is the
	 * worst possible moment for its row to vanish, and it is gone the next time the
	 * list is asked for.
	 */
	const syncStore = useSyncStore();
	const servicesStore = useServicesStore();
	const librariesStore = useLibrariesStore();
	const { t } = useI18n();
	const { notify, tryCallback } = useNotifier();

	const failed = ref(false);
	const busyId = ref<string | null>(null);
	const removing = ref<SyncPlan | null>(null);
	const removeBusy = ref(false);
	const jobView = ref<HistoryView>(HistoryView.LIVE);

	async function loadJobs (): Promise<void> {
		await syncStore.loadJobs({ page: 1, limit: 20, view: jobView.value });
	}

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await Promise.all([
				syncStore.loadPlans(),
				loadJobs(),
				// Asked again on every visit — see `SyncPlan.vue` for why a list loaded
				// earlier in the session is not good enough to name a plan's sources.
				servicesStore.reload().catch(() => undefined),
				librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
			]);
		} catch {
			failed.value = true;
		}
	}

	onMounted(() => {
		void load();
	});

	watch(jobView, () => {
		void loadJobs();
	});

	const viewItems = computed(() => Object.values(HistoryView).map(value => ({
		value,
		title: t(`history.view.${value}`),
	})));

	const showingLiveOnly = computed(() => jobView.value === HistoryView.LIVE);

	const plans = computed(() => syncStore.plans);

	function sourceNames (plan: SyncPlan): string {
		if (plan.sourceServiceIds.length === 0) {
			return '';
		}
		return plan.sourceServiceIds
			.map(id => servicesStore.byId[id]?.name ?? id)
			.join(' → ');
	}

	/**
	 * The library a plan prefers, named rather than identified.
	 *
	 * Falls back to the identifier when the library is not loaded: an empty chip would
	 * read as "no preference", which is the opposite of what the row says.
	 */
	function preferredName (plan: SyncPlan): string | null {
		return plan.preferredLibraryId
			? librariesStore.byId[plan.preferredLibraryId]?.name ?? plan.preferredLibraryId
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
								data-test="plan-disabled"
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
							<template v-if="preferredName(plan)">
								· {{ $t('sync.plan.target') }}: {{ preferredName(plan) }}
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
				<v-card-title class="sync_jobsTitle text-subtitle-1">
					<span>{{ $t('sync.jobs') }}</span>

					<v-spacer />

					<v-btn-toggle
						v-model="jobView"
						data-test="job-view"
						density="compact"
						mandatory
						variant="outlined"
					>
						<v-btn
							v-for="item of viewItems"
							:key="item.value"
							:data-test="`job-view-${item.value}`"
							size="small"
							:value="item.value"
						>
							{{ item.title }}
						</v-btn>
					</v-btn-toggle>
				</v-card-title>

				<v-card-text>
					<EmptyState
						v-if="!syncStore.loadingJobs && syncStore.jobs.length === 0"
						icon="mdi-history"
						:text="showingLiveOnly ? $t('history.empty_live_runs_text') : $t('sync.no_jobs_text')"
						:title="showingLiveOnly ? $t('history.empty_live_runs_title') : $t('sync.no_jobs_title')"
					>
						<v-btn
							v-if="showingLiveOnly"
							data-test="job-see-finished"
							variant="tonal"
							@click="jobView = HistoryView.FINISHED"
						>
							{{ $t('history.see_finished') }}
						</v-btn>
					</EmptyState>

					<template v-else>
						<JobRow
							v-for="job of syncStore.jobs"
							:key="job.id"
							:job="job"
							@cancel="cancelJob"
						/>

						<p
							v-if="showingLiveOnly"
							class="text-caption text-medium-emphasis mt-2"
							data-test="job-history-hint"
						>
							{{ $t('history.hint_runs') }}
						</p>
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

		&_jobsTitle {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
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
