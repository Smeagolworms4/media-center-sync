<script lang="ts" setup>
	import type { Library, LibraryCheck } from '@mcs/shared';
	import { PathMatch } from '@mcs/shared';
	import { computed, ref } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useLibrariesStore } from '@/stores/libraries';

	/**
	 * One library, and whether the gateway can actually write into it.
	 *
	 * This is the failure that reports nothing: a library whose local path and the
	 * media server's path do not designate the same directory accepts transfers the
	 * server will never see. The state is therefore stated here, in words, rather
	 * than left to be discovered when a sync silently does nothing.
	 */
	const props = withDefaults(defineProps<{
		library: Library;
		check?: LibraryCheck | null;
	}>(), {
		check: null,
	});

	const emit = defineEmits<{ saved: [library: Library] }>();

	const librariesStore = useLibrariesStore();
	const validators = useValidators();

	const localPath = ref(props.library.localPath ?? '');

	/**
	 * The folder browser, behind the icon on the field.
	 *
	 * An assist and never a replacement: the field stays the input, because a library
	 * on a disk that is not mounted yet is a path nobody can browse to and a perfectly
	 * legitimate thing to declare. Choosing a folder only fills the field — it is
	 * still saved by the same button, through the same probe.
	 */
	const browsing = ref(false);

	const writable = computed(() => props.check?.writable ?? props.library.writable);
	const declared = computed(() => (props.library.localPath ?? '').length > 0);

	/**
	 * Whether this path was worked out from the service's root rather than typed here.
	 *
	 * Said out loud because the two are corrected in different places: a typed path is
	 * wrong on its own, a derived one is wrong for every library of the service at
	 * once, and somebody who cannot tell them apart fixes the library six times
	 * instead of the service once.
	 */
	const derived = computed(() => declared.value && (props.check?.derived ?? false));

	/** Why the library cannot receive transfers, in the order the checks fail. */
	const problem = computed(() => {
		if (!declared.value) {
			return 'library.problem.no_path';
		}
		if (props.check === null) {
			return null;
		}
		if (!props.check.exists) {
			return 'library.problem.missing';
		}
		if (!props.check.readable) {
			return 'library.problem.unreadable';
		}
		if (!props.check.writable) {
			return 'library.problem.not_writable';
		}
		return null;
	});

	/**
	 * The failure nothing else on this screen can report.
	 *
	 * Everything above is about this side of the mapping: the directory exists, we can
	 * read it, we can write into it — and the media server still reads somewhere else
	 * entirely. That library accepts every transfer and stays empty on the server, with
	 * no error anywhere, which is the single failure this whole screen exists to catch.
	 * It is stated separately from `problem` because it is not one of that list's
	 * degrees: a perfectly healthy path is exactly where it happens.
	 */
	const mismatched = computed(() => props.check?.match === PathMatch.MISMATCHED);

	/** What the media server says it reads, which is the other half of the mapping. */
	const serverPaths = computed(() => props.check?.serverPaths ?? props.library.paths);

	const form = useForm({
		fallbackError: 'error.library.path_not_writable',
		fields: {
			localPath: { rules: [validators.absolutePath()] },
		},
		handle: async () => {
			const saved = await librariesStore.update(props.library.id, {
				localPath: localPath.value.length > 0 ? localPath.value : null,
			});
			emit('saved', saved);
		},
	});

	async function toggleDefault (value: boolean | null): Promise<void> {
		const saved = await librariesStore.update(props.library.id, { isDefaultTarget: !!value });
		emit('saved', saved);
	}
</script>

<template>
	<div class="library-path" data-test="library-row" :data-writable="writable">
		<div class="library-path_header">
			<v-icon
				class="mr-2"
				:color="writable ? 'state-in-sync' : 'state-conflict'"
				:icon="writable ? 'mdi-folder-check-outline' : 'mdi-folder-alert-outline'"
			/>

			<div class="library-path_title">
				<p class="text-subtitle-2 mb-0">{{ library.alias || library.name }}</p>

				<p class="text-caption text-medium-emphasis mb-0">
					{{ $t(`library.kind.${library.kind}`) }}
					· {{ $t('library.item_count', { count: library.itemCount }, library.itemCount) }}
				</p>
			</div>

			<v-spacer />

			<v-switch
				class="library-path_default"
				color="primary"
				density="compact"
				hide-details
				:label="$t('library.default_target')"
				:model-value="library.isDefaultTarget"
				@update:model-value="toggleDefault"
			/>
		</div>

		<p v-if="serverPaths.length > 0" class="text-caption text-medium-emphasis mb-2">
			{{ $t('library.reported_paths') }}: <span class="text-break-anywhere">{{ serverPaths.join(', ') }}</span>
		</p>

		<v-form v-form="form" class="library-path_form">
			<v-text-field
				v-model="localPath"
				v-bind="form.field('localPath')"
				:data-derived="derived"
				data-test="library-path"
				density="compact"
				:hint="derived ? $t('library.derived_hint') : $t('library.local_path_hint')"
				:label="$t('library.local_path')"
				persistent-hint
			>
				<template #append-inner>
					<v-icon
						class="cursor-pointer"
						icon="mdi-folder-search-outline"
						:title="$t('browse.open')"
						@click="browsing = true"
					/>
				</template>
			</v-text-field>

			<!--
				The service is handed over so the dialog can ask it where its own folders
				are. That answer is the left-hand side of the mapping being configured and
				the browse is how somebody finds the right-hand side; a picker that only
				showed our disk was asking them to remember the server's paths.
			-->
			<DirectoryPicker
				v-model="browsing"
				:library-external-id="library.externalId"
				:path="localPath"
				:service-id="library.serviceId"
				@choose="localPath = $event"
			/>

			<v-btn
				class="library-path_save"
				color="primary"
				data-test="library-path-save"
				:loading="form.loading"
				type="submit"
				variant="tonal"
			>
				{{ $t('actions.save') }}
			</v-btn>
		</v-form>

		<FormMainError :form="form" />

		<v-alert
			v-if="problem"
			class="mt-2"
			data-test="library-problem"
			density="compact"
			type="warning"
			variant="tonal"
		>
			{{ $t(problem) }}
		</v-alert>

		<!--
			An error rather than a warning, and it names both paths: the two are
			legitimately different strings, so the only thing somebody can act on is
			seeing them beside each other and recognising which one is wrong.
		-->
		<v-alert
			v-if="mismatched"
			class="mt-2"
			data-test="library-mismatch"
			density="compact"
			type="error"
			variant="tonal"
		>
			{{ $t('library.problem.mismatch', {
				local: check?.localPath ?? '',
				server: serverPaths.join(', '),
			}) }}
		</v-alert>

		<p v-if="check" class="library-path_free text-caption text-medium-emphasis mt-2">
			<template v-if="check.freeBytes !== null">
				{{ $t('library.free_space') }}: <ByteSize :bytes="check.freeBytes" />
			</template>

			<template v-else-if="check.error">{{ $t('library.check_failed') }}</template>
		</p>
	</div>
</template>

<style lang="scss">
	.library-path {
		padding: 12px 0;

		&_header {
			display: flex;
			align-items: center;
			margin-bottom: 8px;
		}

		&_title {
			min-width: 0;
		}

		&_form {
			display: flex;
			align-items: flex-start;
			gap: 8px;
		}

		&_save {
			margin-top: 4px;
		}
	}
</style>
