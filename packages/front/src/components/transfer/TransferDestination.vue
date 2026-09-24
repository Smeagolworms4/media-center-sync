<script lang="ts" setup>
	import type { DestinationLibrary } from '@/composables/useDestinationLibraries';
	import { computed, ref, watch } from 'vue';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';

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
		move: [libraryId: string, folder: string | null];
		remember: [libraryId: string];
	}>();

	const chosen = ref<string | null>(null);

	/**
	 * The folder inside the chosen library, when somebody wants one.
	 *
	 * Empty means its root, which is what the gateway would have picked anyway — so the
	 * ordinary case costs nobody a decision. It exists because a library is not one
	 * folder: a shelf can be five directories on five disks, and choosing the library
	 * chose only the first of them.
	 *
	 * A folder that does not exist yet is a perfectly good answer. Nothing is created
	 * here or when it is typed; the directory appears when the bytes are written, so
	 * changing one's mind leaves nothing behind.
	 */
	const folder = ref<string | null>(null);
	const browsing = ref(false);

	const rootOf = computed(
		() => props.destinations.find(one => one.id === chosen.value)?.path ?? null);

	/*
	 * Filled with where the gateway would put it, rather than left blank.
	 *
	 * The order is the one somebody actually works in: choose the shelf, see where that
	 * lands the file, then change the folder if the answer is not the right one. A blank
	 * box asks for a decision before showing what the default even is, and a placeholder
	 * cannot be edited — so refining it meant typing the whole path from memory.
	 *
	 * Reset rather than kept, because a folder of the shelf somebody just left would be
	 * refused by the API and read as a fault here.
	 */
	watch(chosen, () => {
		folder.value = rootOf.value;
	});

	const items = computed(() => props.destinations.map(one => ({
		value: one.id,
		title: one.name,
		subtitle: one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
	})));

	const disabled = computed(() => props.loading || chosen.value === null);

	/**
	 * The folder to send back, or nothing when the prefilled root was left as it was.
	 *
	 * The field opens on where the gateway would put it, which is a display of the
	 * default and not an answer. Sending it back would pin that exact directory — and a
	 * library is several roots on several disks, so pinning the first of them takes away
	 * the gateway's ability to place the file on the one with room.
	 */
	const chosenFolder = computed(() => {
		const value = folder.value?.trim() || null;

		return value === rootOf.value ? null : value;
	});
</script>

<template>
	<div class="transfer-destination" data-test="transfer-destination">
		<v-select
			v-model="chosen"
			data-test="transfer-destination-library"
			density="compact"
			hide-details
			item-props
			item-title="title"
			item-value="value"
			:items="items"
			:label="$t('transfer.unconfigured.choose')"
			:loading="loading"
		/>

		<!--
			Only once a library is chosen: a folder without a shelf to sit in is a field
			that cannot be filled, and browsing from nowhere has nothing to show.
		-->
		<div v-if="chosen" class="transfer-destination_folder">
			<v-text-field
				v-model="folder"
				clearable
				data-test="transfer-destination-folder"
				density="compact"
				hide-details
				:label="$t('transfer.unconfigured.folder')"
				:placeholder="rootOf ?? ''"
			>
				<template #append-inner>
					<v-btn
						data-test="transfer-destination-browse"
						icon="mdi-folder-open-outline"
						size="small"
						:title="$t('browse.open')"
						variant="text"
						@click="browsing = true"
					/>
				</template>
			</v-text-field>

			<DirectoryPicker
				v-model="browsing"
				:path="folder ?? rootOf"
				@choose="folder = $event"
			/>
		</div>

		<div class="transfer-destination_actions">
			<v-btn
				data-test="transfer-destination-move"
				:disabled="disabled"
				prepend-icon="mdi-folder-move-outline"
				size="small"
				variant="tonal"
				@click="chosen && emit('move', chosen, chosenFolder)"
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

		<!--
			Said where the choice is made, because the gateway does more than the button
			names: a destination is also a statement about what the category is called,
			and the category is renamed after the library. Somebody who pressed "send
			here from now on" and then found their category under another name would
			reasonably conclude the product broke it.
		-->
		<p
			v-if="categoryName"
			class="transfer-destination_note text-caption text-medium-emphasis mb-0"
			data-test="transfer-destination-renames"
		>
			{{ $t('transfer.unconfigured.remember_renames', { category: categoryName }) }}
		</p>

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

		&_note {
			flex: 1 1 100%;
		}

		&_actions {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
	}
</style>
