<script lang="ts" setup>
	import type { Library, MediaCategory } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { useValidators } from '@/plugins/validators';
	import { useLibrariesStore } from '@/stores/libraries';

	/**
	 * What this gateway calls a library, and where it sits in its own order.
	 *
	 * A friend's `Video2` is not a category anybody can navigate, and renaming it on
	 * their server is not ours to do — so the alias is local, sits beside the name
	 * the service reports, and a rescan cannot undo it.
	 *
	 * The position is not decoration either: libraries merge by the name a person
	 * reads, and the lowest position among the merged ones decides both the order
	 * categories appear in and which category wins when the same media is filed in
	 * two. Which is also why the category this library ends up in is spelled out
	 * underneath — aliasing one of two identically named libraries is how somebody
	 * separates them on purpose, and that should read as an effect rather than as a
	 * surprise.
	 */
	const props = withDefaults(defineProps<{
		library: Library;
		/** The merged category this library currently lands in, when it is known. */
		category?: MediaCategory | null;
	}>(), {
		category: null,
	});

	const emit = defineEmits<{ saved: [library: Library] }>();

	const librariesStore = useLibrariesStore();
	const validators = useValidators();

	const alias = ref(props.library.alias ?? '');
	const position = ref(String(props.library.position ?? 0));

	watch(() => props.library, library => {
		alias.value = library.alias ?? '';
		position.value = String(library.position ?? 0);
	});

	/** How many libraries this one shares its category with, ours included. */
	const mergedCount = computed(() => props.category?.libraryIds.length ?? 1);
	const aliased = computed(() => (props.library.alias ?? '').length > 0);

	const form = useForm({
		fallbackError: 'error.library.not_found',
		fields: {
			alias: { rules: [validators.maxlength({ max: 180 })] },
			position: { rules: [validators.range({ min: 0, max: 9999 })] },
		},
		handle: async () => {
			const saved = await librariesStore.update(props.library.id, {
				// An empty box is no alias at all, which is what puts the service's own
				// name back — the one case where empty really does mean cleared.
				alias: alias.value.trim() || null,
				position: Number(position.value),
			});
			emit('saved', saved);
		},
	});
</script>

<template>
	<div class="library-name" data-test="library-name">
		<v-form v-form="form" class="library-name_form">
			<v-text-field
				v-model="alias"
				v-bind="form.field('alias')"
				data-test="library-alias"
				density="compact"
				hide-details
				:label="$t('library.alias')"
				:placeholder="library.name"
			/>

			<v-text-field
				v-model="position"
				v-bind="form.field('position')"
				class="library-name_position"
				data-test="library-position"
				density="compact"
				hide-details
				:label="$t('library.position')"
				type="number"
			/>

			<v-btn
				class="library-name_save"
				color="primary"
				data-test="library-name-save"
				:loading="form.loading"
				type="submit"
				variant="tonal"
			>
				{{ $t('actions.save') }}
			</v-btn>
		</v-form>

		<FormMainError :form="form" />

		<p class="text-caption text-medium-emphasis mt-2 mb-0" data-test="library-category">
			<template v-if="category">
				{{ $t('library.category_is', { name: category.name }) }}
				<template v-if="mergedCount > 1">
					· {{ $t('library.category_merged', { count: mergedCount - 1 }, mergedCount - 1) }}
				</template>

				<template v-else>· {{ $t('library.category_alone') }}</template>
			</template>

			<template v-else>{{ $t('library.category_unknown') }}</template>
		</p>

		<p v-if="aliased" class="text-caption text-medium-emphasis mb-0" data-test="library-reported-name">
			{{ $t('library.reported_name', { name: library.name }) }}
		</p>
	</div>
</template>

<style lang="scss">
	.library-name {
		&_form {
			display: flex;
			align-items: flex-start;
			gap: 8px;
		}

		&_position {
			max-width: 140px;
		}

		&_save {
			margin-top: 4px;
		}
	}
</style>
