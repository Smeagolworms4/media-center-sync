<script lang="ts" setup>
	import type { MediaService, RunSyncRequest, SyncPlan, SyncScope } from '@mcs/shared';
	import { MediaKind, SyncTrigger } from '@mcs/shared';
	import { computed, reactive, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import CronHint from '@/components/common/CronHint.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useByteSize } from '@/composables/useByteSize';
	import { useDestinationLibraries } from '@/composables/useDestinationLibraries';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useSyncStore } from '@/stores/sync';

	/**
	 * The plan editor.
	 *
	 * Sources are an ordered list and an empty one is a decision, not an omission:
	 * it means "follow the priority configured once in the settings", which is what
	 * most people want and what keeps a friend's server moving from being an edit
	 * to every plan.
	 */
	const props = withDefaults(defineProps<{
		plan?: SyncPlan | null;
		services?: MediaService[];
	}>(), {
		plan: null,
		services: () => [],
	});

	const emit = defineEmits<{
		saved: [plan: SyncPlan];
		preview: [request: RunSyncRequest];
		cancel: [];
	}>();

	const { t } = useI18n();
	const syncStore = useSyncStore();
	const validators = useValidators();
	const { parseByteSize, toByteSizeInput } = useByteSize();
	/**
	 * The libraries a plan may prefer, computed rather than handed in as a list.
	 *
	 * It used to take every library the gateway knows, which meant the form offered a
	 * friend's shelf as a destination: the gateway will never write into it, so the
	 * preference would be stored, silently passed over on every run, and the person who
	 * set it would be left wondering why nothing ever went there. The API refuses one
	 * now — but a form that lets somebody choose an answer the API will reject is a form
	 * that wastes their time.
	 */
	const { destinations, rejected } = useDestinationLibraries();

	/**
	 * The parts of the scope this form does not render, carried through untouched.
	 *
	 * The form edits one subtree. A plan can hold more — keeping a second show in sync
	 * from its own page adds a root to the plan that already exists, and a plan written
	 * over the API may name categories or libraries — and a save that rebuilt the scope
	 * from the one field would silently drop the rest. Worse, dropping a category from
	 * a plan that named nothing else turns it into "everything".
	 */
	const extraRoots: string[] = props.plan?.scope?.rootItemIds?.slice(1) ?? [];
	const keptScope: SyncScope = {
		...(props.plan?.scope?.categoryKeys?.length ? { categoryKeys: [...props.plan.scope.categoryKeys] } : {}),
		...(props.plan?.scope?.libraryIds?.length ? { libraryIds: [...props.plan.scope.libraryIds] } : {}),
		...(props.plan?.scope?.itemIds?.length ? { itemIds: [...props.plan.scope.itemIds] } : {}),
	};

	/** The gateway's own test, restated: a scope that names nothing means everything. */
	function namesNothing (scope: SyncScope): boolean {
		return [scope.categoryKeys, scope.libraryIds, scope.rootItemIds, scope.itemIds]
			.every(part => (part?.length ?? 0) === 0);
	}

	const model = reactive({
		name: props.plan?.name ?? '',
		enabled: props.plan?.enabled ?? true,
		trigger: props.plan?.trigger ?? SyncTrigger.MANUAL,
		schedule: props.plan?.schedule ?? '',
		sourceServiceIds: [...(props.plan?.sourceServiceIds ?? [])],
		preferredLibraryId: props.plan?.preferredLibraryId ?? null,
		// One subtree from the form, which is the only part of `SyncScope` this form
		// offers so far; the full editor is a screen of its own.
		rootItemId: props.plan?.scope?.rootItemIds?.[0] ?? '',
		kinds: [...(props.plan?.filter?.kinds ?? [])] as MediaKind[],
		missingOnly: props.plan?.filter?.missingOnly ?? true,
		replaceOutdated: props.plan?.filter?.replaceOutdated ?? false,
		minYear: props.plan?.filter?.minYear ?? null,
		maxBytes: toByteSizeInput(props.plan?.filter?.maxBytes ?? null),
		titleMatches: props.plan?.filter?.titleMatches ?? '',
		maxItemsPerRun: (props.plan?.maxItemsPerRun ?? null) as number | string | null,
		maxBytesPerRun: toByteSizeInput(props.plan?.maxBytesPerRun ?? null),
		/*
		 * Ticked from the start only for a plan that already stands enabled and
		 * unbounded: the gateway refused to store it that way without the
		 * acknowledgement, so somebody already made this choice knowingly, and the
		 * gateway asks again on every save. Asking them to re-tick it to rename the plan
		 * would teach the box to be clicked without being read — which is the one thing
		 * it exists to prevent. A new plan always starts unticked.
		 */
		acknowledgeUnbounded: !!props.plan?.enabled && namesNothing(props.plan.scope ?? {}),
	});

	const addSource = ref<string | null>(null);

	const scheduled = computed(() => model.trigger === SyncTrigger.SCHEDULE);

	const serviceById = computed(() => {
		const map: Record<string, MediaService> = {};
		for (const service of props.services) {
			map[service.id] = service;
		}
		return map;
	});

	const availableSources = computed(
		() => props.services.filter(one => !model.sourceServiceIds.includes(one.id)));

	// Marked like the other menus, so a journey can find a server by what it is rather
	// than by a label somebody may rename.
	const sourceItems = computed(() => availableSources.value.map(one => ({
		'value': one.id,
		'title': one.name,
		'data-test': 'plan-add-source-option',
		'data-value': one.id,
	})));

	function pushSource (): void {
		if (addSource.value && !model.sourceServiceIds.includes(addSource.value)) {
			model.sourceServiceIds.push(addSource.value);
		}
		addSource.value = null;
	}

	function moveSource (index: number, offset: number): void {
		const target = index + offset;
		if (target < 0 || target >= model.sourceServiceIds.length) {
			return;
		}
		const [moved] = model.sourceServiceIds.splice(index, 1);
		model.sourceServiceIds.splice(target, 0, moved);
	}

	function removeSource (index: number): void {
		model.sourceServiceIds.splice(index, 1);
	}

	function filter () {
		return {
			...(model.kinds.length > 0 ? { kinds: [...model.kinds] } : {}),
			missingOnly: model.missingOnly,
			replaceOutdated: model.replaceOutdated,
			...(model.minYear ? { minYear: Number(model.minYear) } : {}),
			...(parseByteSize(model.maxBytes) ? { maxBytes: parseByteSize(model.maxBytes)! } : {}),
			...(model.titleMatches ? { titleMatches: model.titleMatches } : {}),
		};
	}

	function scope (): SyncScope {
		const roots = [model.rootItemId, ...extraRoots].filter(Boolean);
		return { ...keptScope, ...(roots.length > 0 ? { rootItemIds: roots } : {}) };
	}

	/**
	 * The acknowledgement is asked for exactly when the gateway would refuse without
	 * it: an enabled plan whose scope names nothing. Shown at any other moment it
	 * would be a box people learn to tick; hidden at this one, the refusal that sends
	 * them to it points at nothing.
	 */
	const needsAcknowledgement = computed(() => model.enabled && namesNothing(scope()));

	/**
	 * A ceiling is required on top, when that plan also runs by itself.
	 *
	 * "Everything, knowingly" is a defensible thing to press run on: the preview says
	 * what it comes to first. It is not a defensible thing to leave to a timer, because
	 * the scope that was a few shows in January is a whole server by June and nobody is
	 * watching at four in the morning. The gateway does not enforce this one; the
	 * model's own contract says the interface does.
	 */
	const needsCeiling = computed(
		() => needsAcknowledgement.value && model.trigger !== SyncTrigger.MANUAL);

	function ceilings () {
		const items = model.maxItemsPerRun === null || model.maxItemsPerRun === ''
			? null
			: Number(model.maxItemsPerRun);
		return { maxItemsPerRun: items, maxBytesPerRun: parseByteSize(model.maxBytesPerRun) };
	}

	/**
	 * The body a run would take, which is exactly the body the preview takes. The
	 * two are built by the same function on purpose: a preview computed from
	 * anything else would be a promise the run does not have to keep.
	 */
	function runRequest (): RunSyncRequest {
		return {
			...(props.plan ? { planId: props.plan.id } : {}),
			...(namesNothing(scope()) ? {} : { scope: scope() }),
			sourceServiceIds: [...model.sourceServiceIds],
			// A run takes a one-off destination; the plan's preference is the default
			// for it, so a preview shows what a run of this plan would actually do.
			targetLibraryId: model.preferredLibraryId,
			filter: filter(),
			...ceilings(),
		};
	}

	const form = useForm({
		fallbackError: 'error.sync.plan_not_found',
		fields: {
			name: { rules: [validators.required(), validators.maxlength({ max: 120 })] },
			trigger: { rules: [validators.required()] },
			schedule: {
				rules: computed(() => (scheduled.value
					? [validators.required(), validators.cron()]
					: [validators.cron()])),
			},
			minYear: { rules: [validators.onlyInteger()] },
			maxBytes: { rules: [validators.byteSize()] },
			// At least one, because a ceiling of nothing is a plan that never pulls
			// anything and reads, on the list, as a plan with a limit.
			maxItemsPerRun: {
				rules: [
					validators.onlyInteger(),
					validators.range({ min: 1 }),
					() => {
						const { maxItemsPerRun, maxBytesPerRun } = ceilings();
						const capped = maxItemsPerRun !== null || maxBytesPerRun !== null;
						return !needsCeiling.value || capped || t('sync.plan.ceiling_required');
					},
				],
			},
			maxBytesPerRun: { rules: [validators.byteSize({ min: 1 })] },
			// The gateway's own sentence, because it says exactly what is being asked
			// and it is already in every catalogue: the refusal and the box that answers
			// it can then never disagree.
			acknowledgeUnbounded: {
				rules: computed(() => (needsAcknowledgement.value
					? [(value: unknown) => value === true || t('error.sync.scope_unbounded')]
					: [])),
			},
		},
		handle: async () => {
			const request = {
				name: model.name,
				enabled: model.enabled,
				trigger: model.trigger,
				schedule: scheduled.value && model.schedule ? model.schedule : null,
				sourceServiceIds: [...model.sourceServiceIds],
				preferredLibraryId: model.preferredLibraryId,
				scope: scope(),
				filter: filter(),
				...ceilings(),
				...(needsAcknowledgement.value ? { acknowledgeUnbounded: model.acknowledgeUnbounded } : {}),
			};
			const saved = props.plan
				? await syncStore.updatePlan(props.plan.id, request)
				: await syncStore.createPlan(request);
			emit('saved', saved);
		},
	});

	// `item-props`, so the options carry a mark of their own: the labels are
	// translated and a journey that picked one by its wording would break the day the
	// interface is read in another language.
	const triggerItems = computed(() => Object.values(SyncTrigger).map(value => ({
		'value': value,
		'title': t(`sync.trigger.${value}`),
		'data-test': 'plan-trigger-option',
		'data-value': value,
	})));

	/** What the chosen trigger actually does, under the field rather than in it. */
	const triggerHelp = computed(() => t(`sync.trigger_help.${model.trigger}`));

	const kindItems = computed(() => Object.values(MediaKind).map(value => ({
		'value': value,
		'title': t(`media.kind.${value}`),
		'data-test': 'plan-kind-option',
		'data-value': value,
	})));

	// The path under the name: on a gateway with a `Shows` on two servers, the name
	// alone is not a choice anybody can make correctly. The marks ride along on the
	// same `item-props`, which is how the offer itself can be read back — "only
	// writable libraries of our own are proposed" is a statement about the options,
	// and nothing else on the screen shows them.
	const destinationItems = computed(() => destinations.value.map(one => ({
		'value': one.id,
		'title': one.name,
		'subtitle': one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
		'data-test': 'plan-target-option',
		'data-library': one.id,
	})));
</script>

<template>
	<v-form v-form="form" class="plan-form" data-test="plan-form">
		<v-row density="compact">
			<v-col cols="12" sm="8">
				<v-text-field
					v-model="model.name"
					v-bind="form.field('name')"
					data-test="plan-name"
					:label="$t('sync.plan.name')"
				/>
			</v-col>

			<v-col cols="12" sm="4">
				<v-switch
					v-model="model.enabled"
					color="primary"
					data-test="plan-enabled"
					hide-details
					:label="$t('sync.plan.enabled')"
				/>
			</v-col>
		</v-row>

		<v-select
			v-model="model.trigger"
			v-bind="form.field('trigger')"
			data-test="plan-trigger"
			:hint="triggerHelp"
			item-props
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
				data-test="plan-schedule"
				:label="$t('sync.plan.schedule')"
				placeholder="0 4 * * *"
			/>

			<CronHint class="mb-4" :expression="model.schedule" />
		</template>

		<p class="text-subtitle-2 mt-4 mb-1">{{ $t('sync.plan.sources') }}</p>

		<p class="text-caption text-medium-emphasis">
			{{ model.sourceServiceIds.length === 0
				? $t('sync.plan.sources_default')
				: $t('sync.plan.sources_ordered') }}
		</p>

		<v-list v-if="model.sourceServiceIds.length > 0" class="plan-form_sources" density="compact">
			<v-list-item
				v-for="(serviceId, index) of model.sourceServiceIds"
				:key="serviceId"
				data-test="plan-source"
				:title="serviceById[serviceId]?.name ?? serviceId"
			>
				<template #prepend>
					<span class="plan-form_rank text-caption">{{ index + 1 }}</span>
				</template>

				<template #append>
					<v-btn
						data-test="plan-source-up"
						:disabled="index === 0"
						icon="mdi-arrow-up"
						size="x-small"
						variant="text"
						@click="moveSource(index, -1)"
					/>

					<v-btn
						data-test="plan-source-down"
						:disabled="index === model.sourceServiceIds.length - 1"
						icon="mdi-arrow-down"
						size="x-small"
						variant="text"
						@click="moveSource(index, 1)"
					/>

					<v-btn
						data-test="plan-source-remove"
						icon="mdi-close"
						size="x-small"
						variant="text"
						@click="removeSource(index)"
					/>
				</template>
			</v-list-item>
		</v-list>

		<div class="plan-form_addSource">
			<v-select
				v-model="addSource"
				data-test="plan-add-source"
				density="compact"
				hide-details
				item-props
				item-title="title"
				item-value="value"
				:items="sourceItems"
				:label="$t('sync.plan.add_source')"
			/>

			<v-btn
				data-test="plan-source-add"
				:disabled="!addSource"
				variant="tonal"
				@click="pushSource"
			>
				{{ $t('actions.add') }}
			</v-btn>
		</div>

		<v-select
			v-model="model.preferredLibraryId"
			class="mt-4"
			clearable
			data-test="plan-target"
			:hint="$t('sync.plan.target_hint')"
			item-props
			item-title="title"
			item-value="value"
			:items="destinationItems"
			:label="$t('sync.plan.target')"
			persistent-hint
		/>

		<p
			v-if="destinations.length === 0"
			class="text-caption text-warning mb-0 mt-1"
			data-test="plan-target-none"
		>
			{{ $t('settings.destination.none') }}
		</p>

		<!--
			A shelf somebody expects to see and cannot is a bug until it is explained.
			Naming the ones left out, with which of the two reasons applies, is the
			difference between "this is broken" and "that disk is on a friend's machine".
		-->
		<p
			v-for="one of rejected"
			:key="one.id"
			class="text-caption text-medium-emphasis mb-0 mt-1"
			data-test="plan-target-rejected"
		>
			{{ one.name }} ({{ one.serviceName }}) —
			{{ $t(`settings.destination.rejected.${one.reason}`) }}
		</p>

		<v-text-field
			v-model="model.rootItemId"
			class="mt-4"
			clearable
			data-test="plan-root"
			:hint="$t('sync.plan.root_hint')"
			:label="$t('sync.plan.root')"
			persistent-hint
		/>

		<p
			v-if="extraRoots.length > 0"
			class="text-caption text-medium-emphasis mb-0 mt-1"
			data-test="plan-root-more"
		>
			{{ $t('sync.plan.root_more', { count: extraRoots.length }) }}
		</p>

		<!--
			Right under the field that would have avoided it, and only while it applies:
			the choice is about the scope, so it sits with the scope.
		-->
		<v-checkbox
			v-if="needsAcknowledgement"
			v-model="model.acknowledgeUnbounded"
			v-bind="form.field('acknowledgeUnbounded')"
			class="mt-2"
			color="warning"
			data-test="plan-acknowledge-unbounded"
			:hint="$t('sync.plan.acknowledge_unbounded_hint')"
			:label="$t('sync.plan.acknowledge_unbounded')"
			persistent-hint
		/>

		<p class="text-subtitle-2 mt-6 mb-1">{{ $t('sync.plan.ceilings') }}</p>

		<p class="text-caption text-medium-emphasis">{{ $t('sync.plan.ceilings_hint') }}</p>

		<v-row density="compact">
			<v-col cols="12" sm="6">
				<v-text-field
					v-model="model.maxItemsPerRun"
					v-bind="form.field('maxItemsPerRun')"
					data-test="plan-max-items-per-run"
					inputmode="numeric"
					:label="$t('sync.plan.max_items_per_run')"
				/>
			</v-col>

			<v-col cols="12" sm="6">
				<v-text-field
					v-model="model.maxBytesPerRun"
					v-bind="form.field('maxBytesPerRun')"
					data-test="plan-max-bytes-per-run"
					:label="$t('sync.plan.max_bytes_per_run')"
					placeholder="200G"
				/>
			</v-col>
		</v-row>

		<p class="text-subtitle-2 mt-6 mb-1">{{ $t('sync.plan.filters') }}</p>

		<v-row density="compact">
			<v-col cols="12" sm="6">
				<v-select
					v-model="model.kinds"
					chips
					clearable
					data-test="plan-kinds"
					item-props
					item-title="title"
					item-value="value"
					:items="kindItems"
					:label="$t('sync.plan.kinds')"
					multiple
				/>
			</v-col>

			<v-col cols="12" sm="3">
				<v-text-field
					v-model="model.minYear"
					v-bind="form.field('minYear')"
					data-test="plan-min-year"
					:label="$t('sync.plan.min_year')"
				/>
			</v-col>

			<v-col cols="12" sm="3">
				<v-text-field
					v-model="model.maxBytes"
					v-bind="form.field('maxBytes')"
					data-test="plan-max-bytes"
					:hint="$t('sync.plan.max_bytes_hint')"
					:label="$t('sync.plan.max_bytes')"
					persistent-hint
				/>
			</v-col>
		</v-row>

		<v-text-field
			v-model="model.titleMatches"
			class="mt-2"
			clearable
			data-test="plan-title-matches"
			:label="$t('sync.plan.title_matches')"
		/>

		<v-switch
			v-model="model.missingOnly"
			color="primary"
			data-test="plan-missing-only"
			density="compact"
			hide-details
			:label="$t('sync.plan.missing_only')"
		/>

		<v-switch
			v-model="model.replaceOutdated"
			color="primary"
			data-test="plan-replace-outdated"
			density="compact"
			hide-details
			:label="$t('sync.plan.replace_outdated')"
		/>

		<FormMainError :form="form" />

		<div class="plan-form_actions mt-4">
			<v-btn
				data-test="plan-preview"
				prepend-icon="mdi-eye-outline"
				variant="tonal"
				@click="emit('preview', runRequest())"
			>
				{{ $t('sync.preview.action') }}
			</v-btn>

			<v-spacer />

			<v-btn variant="text" @click="emit('cancel')">{{ $t('actions.cancel') }}</v-btn>

			<v-btn
				color="primary"
				data-test="plan-save"
				:loading="form.loading"
				type="submit"
			>
				{{ $t('actions.save') }}
			</v-btn>
		</div>
	</v-form>
</template>

<style lang="scss">
	.plan-form {
		&_addSource {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		&_rank {
			width: 22px;
			opacity: 0.6;
		}

		&_actions {
			display: flex;
			align-items: center;
			gap: 8px;
		}
	}
</style>
