<script lang="ts" setup>
	import type { Library, MediaService, RunSyncRequest, SyncPlan } from '@mcs/shared';
	import { MediaKind, SyncTrigger } from '@mcs/shared';
	import { computed, reactive, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import CronHint from '@/components/common/CronHint.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useByteSize } from '@/composables/useByteSize';
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
		libraries?: Library[];
	}>(), {
		plan: null,
		services: () => [],
		libraries: () => [],
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

	const model = reactive({
		name: props.plan?.name ?? '',
		enabled: props.plan?.enabled ?? true,
		trigger: props.plan?.trigger ?? SyncTrigger.MANUAL,
		schedule: props.plan?.schedule ?? '',
		sourceServiceIds: [...(props.plan?.sourceServiceIds ?? [])],
		targetLibraryId: props.plan?.targetLibraryId ?? null,
		rootItemId: props.plan?.rootItemId ?? '',
		kinds: [...(props.plan?.filter?.kinds ?? [])] as MediaKind[],
		missingOnly: props.plan?.filter?.missingOnly ?? true,
		replaceOutdated: props.plan?.filter?.replaceOutdated ?? false,
		minYear: props.plan?.filter?.minYear ?? null,
		maxBytes: toByteSizeInput(props.plan?.filter?.maxBytes ?? null),
		titleMatches: props.plan?.filter?.titleMatches ?? '',
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

	/**
	 * The body a run would take, which is exactly the body the preview takes. The
	 * two are built by the same function on purpose: a preview computed from
	 * anything else would be a promise the run does not have to keep.
	 */
	function runRequest (): RunSyncRequest {
		return {
			...(props.plan ? { planId: props.plan.id } : {}),
			...(model.rootItemId ? { rootItemId: model.rootItemId } : {}),
			sourceServiceIds: [...model.sourceServiceIds],
			targetLibraryId: model.targetLibraryId,
			filter: filter(),
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
		},
		handle: async () => {
			const request = {
				name: model.name,
				enabled: model.enabled,
				trigger: model.trigger,
				schedule: scheduled.value && model.schedule ? model.schedule : null,
				sourceServiceIds: [...model.sourceServiceIds],
				targetLibraryId: model.targetLibraryId,
				rootItemId: model.rootItemId || null,
				filter: filter(),
			};
			const saved = props.plan
				? await syncStore.updatePlan(props.plan.id, request)
				: await syncStore.createPlan(request);
			emit('saved', saved);
		},
	});

	const triggerItems = computed(() => Object.values(SyncTrigger).map(value => ({
		value,
		title: t(`sync.trigger.${value}`),
	})));

	/** What the chosen trigger actually does, under the field rather than in it. */
	const triggerHelp = computed(() => t(`sync.trigger_help.${model.trigger}`));

	const kindItems = computed(() => Object.values(MediaKind).map(value => ({
		value,
		title: t(`media.kind.${value}`),
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
						:disabled="index === 0"
						icon="mdi-arrow-up"
						size="x-small"
						variant="text"
						@click="moveSource(index, -1)"
					/>

					<v-btn
						:disabled="index === model.sourceServiceIds.length - 1"
						icon="mdi-arrow-down"
						size="x-small"
						variant="text"
						@click="moveSource(index, 1)"
					/>

					<v-btn
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
				item-title="name"
				item-value="id"
				:items="availableSources"
				:label="$t('sync.plan.add_source')"
			/>

			<v-btn :disabled="!addSource" variant="tonal" @click="pushSource">
				{{ $t('actions.add') }}
			</v-btn>
		</div>

		<v-select
			v-model="model.targetLibraryId"
			class="mt-4"
			clearable
			data-test="plan-target"
			:hint="$t('sync.plan.target_hint')"
			item-title="name"
			item-value="id"
			:items="libraries"
			:label="$t('sync.plan.target')"
			persistent-hint
		/>

		<v-text-field
			v-model="model.rootItemId"
			class="mt-4"
			clearable
			data-test="plan-root"
			:hint="$t('sync.plan.root_hint')"
			:label="$t('sync.plan.root')"
			persistent-hint
		/>

		<p class="text-subtitle-2 mt-6 mb-1">{{ $t('sync.plan.filters') }}</p>

		<v-row density="compact">
			<v-col cols="12" sm="6">
				<v-select
					v-model="model.kinds"
					chips
					clearable
					data-test="plan-kinds"
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
			density="compact"
			hide-details
			:label="$t('sync.plan.missing_only')"
		/>

		<v-switch
			v-model="model.replaceOutdated"
			color="primary"
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
