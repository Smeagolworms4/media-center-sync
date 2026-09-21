<script lang="ts" setup>
	import type { DestinationLibrary } from '@/composables/useDestinationLibraries';
	import type { UnconfiguredPlacement } from '@mcs/shared';
	import { TransferState } from '@mcs/shared';
	import { computed } from 'vue';
	import TransferDestination from '@/components/transfer/TransferDestination.vue';
	import { storageRef } from '@/libs/vue3-query-ref';

	/**
	 * Files that landed on a step of the placement rule nobody configured.
	 *
	 * This zone is the only thing in the product that ever mentions them. The transfer
	 * succeeded, so there is no error, no failed state and no log line anybody would go
	 * looking for — the library simply grows a folder somebody did not plan, and it is
	 * found months later when a season turns out to be split across two shelves.
	 *
	 * Every row says why in words somebody can act on. "No destination is set for the
	 * category Animés" names the setting to go and change; "fallback" names an
	 * implementation detail and leaves them exactly where they were.
	 */
	const props = withDefaults(defineProps<{
		items: UnconfiguredPlacement[];
		destinations: DestinationLibrary[];
		loading?: boolean;
	}>(), {
		loading: false,
	});

	defineEmits<{
		move: [transferId: string, libraryId: string];
		remember: [categoryKey: string, libraryId: string];
	}>();

	/**
	 * How much of this has already been waved away, as a moment rather than a flag.
	 *
	 * A boolean would be wrong in one direction or the other for ever: cleared on every
	 * new arrival it is not a dismissal at all, and kept for good it hides the next
	 * hundred files as well as the ten somebody looked at. Remembering when they last
	 * said "not now" means what they dismissed stays dismissed and what arrives
	 * afterwards comes back — which is the only behaviour that is honest about a zone
	 * whose whole purpose is that nothing else reports this.
	 */
	const dismissedAt = storageRef<string>('dashboard.unconfigured.dismissedAt');

	const pending = computed(() => props.items.filter(
		one => dismissedAt.value === null || one.placedAt > dismissedAt.value));

	// Compared with `localeCompare` rather than with `>`: the lint rule rewrites
	// `a > b ? a : b` into `Math.max`, which on two ISO timestamps is `NaN` — and a
	// dismissal stamped `NaN` hides every row for ever, silently.
	const newest = computed(() => props.items.reduce(
		(latest, one) => (one.placedAt.localeCompare(latest) > 0 ? one.placedAt : latest), ''));

	function dismiss (): void {
		dismissedAt.value = newest.value;
	}

	/** Where it went, named as a library when it belongs to one and as a folder when not. */
	function destinationOf (item: UnconfiguredPlacement): string {
		return item.targetLibraryName ?? item.targetPath.slice(0, item.targetPath.lastIndexOf('/')) ?? item.targetPath;
	}

	/**
	 * The reason, keyed on the step and worded around the category.
	 *
	 * An item whose own library belongs to no category gets a different sentence rather
	 * than the same one with a blank in it: there is nothing per-category to configure
	 * for it, and telling somebody to set a destination for a category that does not
	 * exist sends them looking for a row that is not in the table.
	 */
	function reasonOf (item: UnconfiguredPlacement): string {
		return item.categoryName
			? `transfer.unconfigured.reason.${item.placedBy}`
			: `transfer.unconfigured.no_category.${item.placedBy}`;
	}
</script>

<template>
	<v-card
		v-if="pending.length > 0"
		class="unconfigured"
		data-test="dashboard-unconfigured"
		variant="tonal"
	>
		<v-card-title class="text-subtitle-1 d-flex align-center">
			<v-icon class="mr-2" icon="mdi-folder-question-outline" />

			{{ $t('transfer.unconfigured.title', { count: pending.length }) }}

			<v-spacer />

			<v-btn
				data-test="dashboard-unconfigured-dismiss"
				size="small"
				variant="text"
				@click="dismiss"
			>
				{{ $t('transfer.unconfigured.dismiss') }}
			</v-btn>
		</v-card-title>

		<v-card-subtitle>{{ $t('transfer.unconfigured.hint') }}</v-card-subtitle>

		<v-card-text>
			<div
				v-for="item of pending"
				:key="item.transferId"
				class="unconfigured_row"
				:data-placed-by="item.placedBy"
				data-test="dashboard-unconfigured-row"
				:data-transfer="item.transferId"
			>
				<p class="unconfigured_title mb-0">
					{{ item.title }}

					<v-chip class="ml-2" label size="x-small" variant="tonal">
						{{ item.state === TransferState.DONE
							? $t('transfer.unconfigured.went_to', { target: destinationOf(item) })
							: $t('transfer.unconfigured.going_to', { target: destinationOf(item) }) }}
					</v-chip>
				</p>

				<p
					class="text-caption text-medium-emphasis mb-1"
					data-test="dashboard-unconfigured-reason"
				>
					{{ $t(reasonOf(item), { category: item.categoryName }) }}
				</p>

				<TransferDestination
					:category-name="item.categoryName"
					:destinations="destinations"
					:loading="loading"
					@move="libraryId => $emit('move', item.transferId, libraryId)"
					@remember="libraryId => item.categoryKey && $emit('remember', item.categoryKey, libraryId)"
				/>
			</div>
		</v-card-text>
	</v-card>
</template>

<style lang="scss">
	.unconfigured {
		&_row + &_row {
			margin-top: 16px;
			padding-top: 16px;
			border-top: 1px solid rgb(var(--v-border-color), var(--v-border-opacity));
		}

		&_title {
			font-weight: 500;
		}
	}
</style>
