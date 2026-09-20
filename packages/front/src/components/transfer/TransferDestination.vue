<script lang="ts" setup>
	import type { DestinationLibrary } from '@/composables/useDestinationLibraries';
	import { computed, ref } from 'vue';

	/**
	 * Choosing where one file should go, and what to do with the answer.
	 *
	 * Two actions rather than one, because they fix different amounts of the problem
	 * and only the person can say which they mean. Moving this file deals with the file
	 * in front of them. Setting the destination for its category deals with every
	 * episode that arrives after it, and leaves the one already on disk where it is —
	 * offering only that would be answering a question nobody asked, and offering only
	 * the move would have them back here next week.
	 *
	 * A library and never a path: a library is a directory the gateway has probed and
	 * one of our own media servers is known to scan. The list is already filtered to
	 * those, so nothing here can name a folder nothing indexes.
	 */
	const props = withDefaults(defineProps<{
		destinations: DestinationLibrary[];
		/** The category this item belongs to, when it belongs to one. */
		categoryName?: string | null;
		loading?: boolean;
	}>(), {
		categoryName: null,
		loading: false,
	});

	const emit = defineEmits<{
		move: [libraryId: string];
		remember: [libraryId: string];
	}>();

	const chosen = ref<string | null>(null);

	const items = computed(() => props.destinations.map(one => ({
		value: one.id,
		title: one.name,
		subtitle: one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
	})));

	const disabled = computed(() => props.loading || chosen.value === null);
</script>

<template>
	<div class="transfer-destination" data-test="transfer-destination">
		<v-select
			v-model="chosen"
			density="compact"
			hide-details
			item-props
			item-title="title"
			item-value="value"
			:items="items"
			:label="$t('transfer.unconfigured.choose')"
			:loading="loading"
		/>

		<div class="transfer-destination_actions">
			<v-btn
				data-test="transfer-destination-move"
				:disabled="disabled"
				prepend-icon="mdi-folder-move-outline"
				size="small"
				variant="tonal"
				@click="chosen && emit('move', chosen)"
			>
				{{ $t('transfer.unconfigured.move') }}
			</v-btn>

			<v-btn
				v-if="categoryName"
				data-test="transfer-destination-remember"
				:disabled="disabled"
				prepend-icon="mdi-content-save-cog-outline"
				size="small"
				variant="text"
				@click="chosen && emit('remember', chosen)"
			>
				{{ $t('transfer.unconfigured.remember', { category: categoryName }) }}
			</v-btn>
		</div>

		<p
			v-if="!loading && destinations.length === 0"
			class="text-caption text-warning mb-0"
			data-test="transfer-destination-none"
		>
			{{ $t('settings.destination.none') }}
		</p>
	</div>
</template>

<style lang="scss">
	.transfer-destination {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;

		.v-select {
			min-width: 220px;
			flex: 1 1 220px;
		}

		&_actions {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
	}
</style>
