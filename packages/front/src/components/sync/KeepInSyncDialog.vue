<script lang="ts" setup>
	import type { ItemSyncPlans, MediaGroup, SyncEstimate, SyncPlan } from '@mcs/shared';
	import { SyncTrigger } from '@mcs/shared';
	import { computed, reactive, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import ByteSize from '@/components/common/ByteSize.vue';
	import CronHint from '@/components/common/CronHint.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import Window from '@/components/Window.vue';
	import { useForm } from '@/composables/useForm';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useSyncStore } from '@/stores/sync';

	/**
	 * Keeping one show — or one season — in step, in a single gesture.
	 *
	 * The blank plan form asks for a name, a trigger, a list of sources, a scope, a
	 * filter and a per-run ceiling before somebody has said the one thing they actually
	 * meant, which is *this show*. So nobody fills it in, nobody has a plan, and the
	 * feature the product exists for goes unused. Here the media says the scope, the
	 * gateway derives the name, and what is left is the one question nobody may answer
	 * on somebody's behalf: when it runs.
	 *
	 * Three things this dialog exists to get right.
	 *
	 * **The two intents are named, never guessed.** "Get the missing episodes of this
	 * season" and "keep this series in step for ever" are different things somebody
	 * wants, and a screen with one button that silently does the other is a screen that
	 * downloads a hundred gigabytes nobody asked for — or, the other way round, that
	 * quietly does nothing again next month. Both are offered, each under its own
	 * heading, and the one-off says out loud that nothing is remembered.
	 *
	 * **The trigger is chosen here.** A standing intent implies a schedule, and a
	 * schedule nobody picked is a gateway that starts downloading at four in the
	 * morning. Manual is what the field opens on, and a cron is refused empty — by this
	 * form and by the gateway, which is what makes it true rather than polite.
	 *
	 * **A plan that already covers it is named, not duplicated.** `SyncScope.rootItemIds`
	 * is plural precisely so that "these three shows" is one plan; two plans over one
	 * show are two runs pulling the same episodes into the same folder, and the loser of
	 * the race finds the winner's half-written file.
	 */
	const props = defineProps<{ group: MediaGroup }>();

	const open = defineModel<boolean>({ default: false });

	const emit = defineEmits<{ created: [plan: SyncPlan]; ran: [] }>();

	const { t } = useI18n();
	const syncStore = useSyncStore();
	const validators = useValidators();
	const { notify, tryCallback } = useNotifier();

	const info = ref<ItemSyncPlans | null>(null);
	const estimate = ref<SyncEstimate | null>(null);
	const loading = ref(false);
	const failed = ref(false);
	const running = ref(false);

	const model = reactive({
		mode: 'create' as 'create' | 'extend',
		name: '',
		trigger: SyncTrigger.MANUAL as SyncTrigger,
		schedule: '',
		extendPlanId: null as string | null,
	});

	/**
	 * What both halves of this dialog are about: the subtree, filling holes only.
	 *
	 * The same object feeds the estimate shown here and the plan created below, so the
	 * number somebody is shown is the number the plan will work from rather than a
	 * second computation of roughly the same thing.
	 */
	const scope = computed(() => ({ rootItemIds: [props.group.id] }));

	const covering = computed(() => info.value?.covering ?? []);
	const covered = computed(() => covering.value.length > 0);
	const extendable = computed(() => info.value?.extendable ?? []);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		estimate.value = null;
		try {
			const [plans, counted] = await Promise.all([
				syncStore.itemPlans(props.group.id),
				// An estimate that could not be taken is shown as absent rather than as
				// zero: "nothing to pull" and "nobody worked it out" are different
				// answers, and only one of them means there is nothing to do.
				syncStore
					.estimateScope({ scope: scope.value, filter: { missingOnly: true } })
					.catch(() => null),
			]);
			info.value = plans;
			estimate.value = counted;
			model.name = plans.suggestedName;
			model.mode = 'create';
			model.extendPlanId = plans.extendable?.[0]?.id ?? null;
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	watch(open, isOpen => {
		if (isOpen) {
			info.value = null;
			model.trigger = SyncTrigger.MANUAL;
			model.schedule = '';
			void load();
		}
	});

	const scheduled = computed(() => model.trigger === SyncTrigger.SCHEDULE);
	const extending = computed(() => model.mode === 'extend' && extendable.value.length > 0);

	const triggerItems = computed(() => Object.values(SyncTrigger).map(value => ({
		value,
		title: t(`sync.trigger.${value}`),
	})));

	const triggerHelp = computed(() => t(`sync.trigger_help.${model.trigger}`));

	const planItems = computed(() => extendable.value.map(one => ({
		value: one.id,
		title: one.name,
	})));

	/** Where to go to change a plan afterwards, which is the point of naming it. */
	function planRoute (plan: SyncPlan) {
		return { name: 'sync-plan', params: { id: plan.id } };
	}

	const form = useForm({
		fallbackError: 'error.sync.plan_not_found',
		fields: {
			name: { rules: [validators.required(), validators.maxlength({ max: 120 })] },
			schedule: {
				rules: computed(() => (scheduled.value
					? [validators.required(), validators.cron()]
					: [])),
			},
		},
		handle: async () => {
			const created = await syncStore.createPlanForItem({
				itemId: props.group.id,
				trigger: model.trigger,
				schedule: scheduled.value && model.schedule ? model.schedule : null,
				...(extending.value && model.extendPlanId
					? { extendPlanId: model.extendPlanId }
					: { name: model.name }),
			});
			void notify(extending.value ? 'sync.keep.extended' : 'sync.keep.created');
			emit('created', created);
			open.value = false;
		},
	});

	/**
	 * The other intent, and it is a run and not a plan.
	 *
	 * `missingOnly`, like the plan: somebody asking for the missing episodes of a
	 * season has not asked for the two they already hold to be replaced by a copy some
	 * comparator preferred.
	 */
	const runOnce = tryCallback(async () => {
		running.value = true;
		try {
			await syncStore.run({ scope: scope.value, filter: { missingOnly: true } });
			void notify('library.sync_started');
			emit('ran');
			open.value = false;
		} finally {
			running.value = false;
		}
	});
</script>

<template>
	<Window v-model="open" :max-width="720" :title="$t('sync.keep.title')">
		<div class="keep-in-sync" data-test="keep-in-sync">
			<div v-if="loading" class="text-center py-6">
				<v-progress-circular color="primary" indeterminate size="32" />
			</div>

			<ErrorState v-else-if="failed" @retry="load" />

			<template v-else>
				<p class="text-body-2 mb-2">
					{{ $t('sync.keep.what', { title: group.title }) }}
				</p>

				<!--
					What the scope comes to, before anything is undertaken. From a season it
					is a small number and from a series it is a whole show, and that
					difference is the entire reason it is shown here rather than on the edit
					screen somebody reaches afterwards.
				-->
				<p class="text-body-2 mb-4" data-test="keep-estimate">
					<template v-if="estimate">
						<strong>
							{{ $t('sync.preview.summary', { count: estimate.itemCount }, estimate.itemCount) }}
						</strong>

						<ByteSize :bytes="estimate.bytes" class="ml-1" />

						<span
							v-if="estimate.truncated"
							class="d-block text-caption text-medium-emphasis"
							data-test="keep-estimate-truncated"
						>
							{{ $t('sync.keep.estimate_truncated') }}
						</span>
					</template>

					<span v-else class="text-medium-emphasis">
						{{ $t('sync.keep.estimate_unknown') }}
					</span>
				</p>

				<!--
					Already covered: the answer is that plan, so it is named and linked
					rather than replaced by a second one that would fight it.
				-->
				<v-alert
					v-if="covered"
					class="mb-4"
					data-test="keep-covered"
					type="info"
					variant="tonal"
				>
					<p class="mb-2">
						{{ covering[0].exact
							? $t('sync.keep.covered', { name: covering[0].plan.name })
							: $t('sync.keep.covered_above', { name: covering[0].plan.name }) }}
					</p>

					<v-btn
						data-test="keep-open-plan"
						size="small"
						:to="planRoute(covering[0].plan)"
						variant="tonal"
					>
						{{ $t('sync.keep.open_plan') }}
					</v-btn>
				</v-alert>

				<v-form v-else v-form="form" data-test="keep-form">
					<v-radio-group
						v-if="extendable.length > 0"
						v-model="model.mode"
						data-test="keep-mode"
						density="compact"
						hide-details
						:label="$t('sync.keep.mode')"
					>
						<v-radio :label="$t('sync.keep.mode_create')" value="create" />
						<v-radio :label="$t('sync.keep.mode_extend')" value="extend" />
					</v-radio-group>

					<v-select
						v-if="extending"
						v-model="model.extendPlanId"
						class="mt-2"
						data-test="keep-plan"
						item-title="title"
						item-value="value"
						:items="planItems"
						:label="$t('sync.keep.plan')"
					/>

					<template v-else>
						<v-text-field
							v-model="model.name"
							v-bind="form.field('name')"
							class="mt-2"
							data-test="keep-name"
							:hint="$t('sync.keep.name_hint')"
							:label="$t('sync.keep.name')"
							persistent-hint
						/>

						<v-select
							v-model="model.trigger"
							class="mt-4"
							data-test="keep-trigger"
							:hint="triggerHelp"
							item-title="title"
							item-value="value"
							:items="triggerItems"
							:label="$t('sync.plan.trigger')"
							persistent-hint
						/>

						<template v-if="scheduled">
							<v-text-field
								v-model="model.schedule"
								v-bind="form.field('schedule')"
								class="mt-4"
								data-test="keep-schedule"
								:label="$t('sync.plan.schedule')"
								placeholder="0 4 * * *"
							/>

							<CronHint :expression="model.schedule" />
						</template>

						<p class="text-caption text-medium-emphasis mt-4 mb-0" data-test="keep-sources">
							{{ $t('sync.keep.sources') }}
						</p>
					</template>

					<FormMainError :form="form" />
				</v-form>

				<!--
					The other intent, under its own heading. Offering both is legitimate;
					offering one button that silently does the other is not.
				-->
				<v-divider class="my-4" />

				<p class="text-subtitle-2 mb-1">{{ $t('sync.keep.once_title') }}</p>

				<p class="text-caption text-medium-emphasis mb-2">{{ $t('sync.keep.once_text') }}</p>

				<v-btn
					data-test="keep-run-once"
					:loading="running"
					prepend-icon="mdi-cloud-download-outline"
					variant="tonal"
					@click="runOnce"
				>
					{{ $t('sync.keep.once') }}
				</v-btn>
			</template>
		</div>

		<template #actions>
			<v-spacer />

			<v-btn variant="text" @click="open = false">{{ $t('actions.close') }}</v-btn>

			<v-btn
				v-if="!covered"
				color="primary"
				data-test="keep-create"
				:disabled="loading || failed"
				:loading="form.loading"
				@click="form.handle"
			>
				{{ extending ? $t('sync.keep.extend') : $t('sync.keep.create') }}
			</v-btn>
		</template>
	</Window>
</template>
