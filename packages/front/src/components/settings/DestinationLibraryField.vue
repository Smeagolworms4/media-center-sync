<script lang="ts" setup>
	import type { DestinationLibrary } from '@/composables/useDestinationLibraries';
	import { computed } from 'vue';

	/**
	 * The one destination most people will ever set.
	 *
	 * A library and never a path: a library is a directory this gateway has already
	 * probed for write access and the media server is known to scan, while a path is a
	 * string somebody typed that may be somewhere no server ever looks. That is the
	 * whole failure this section exists to prevent — a transfer that succeeds and
	 * produces nothing.
	 *
	 * Unwritable libraries are absent from the menu on purpose, and the caption is what
	 * keeps that from reading as a bug: a list with a name missing and no explanation
	 * sends somebody looking for a fault in the wrong place.
	 */
	const target = defineModel<string | null>({ default: null });

	const props = withDefaults(defineProps<{
		destinations: DestinationLibrary[];
		/** Bindings from `useForm().field()`, so a refusal lands under this control. */
		field?: Record<string, unknown>;
		loading?: boolean;
	}>(), {
		field: () => ({}),
		loading: false,
	});

	const items = computed(() => props.destinations.map(one => ({
		value: one.id,
		title: one.name,
		subtitle: one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
	})));
</script>

<template>
	<div class="destination-library">
		<v-select
			v-model="target"
			v-bind="field"
			clearable
			data-test="settings-default-target-library"
			:disabled="loading"
			:hint="$t('settings.destination.global_help')"
			item-props
			item-title="title"
			item-value="value"
			:items="items"
			:label="$t('settings.destination.global')"
			persistent-hint
		/>

		<p
			v-if="!loading && destinations.length === 0"
			class="text-caption text-warning mt-2 mb-0"
			data-test="settings-destination-none"
		>
			{{ $t('settings.destination.none') }}
		</p>
	</div>
</template>
