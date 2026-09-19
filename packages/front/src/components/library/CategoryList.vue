<script lang="ts" setup>
	import type { MediaCategory } from '@mcs/shared';

	/**
	 * The categories a library screen is actually built from.
	 *
	 * Libraries merge on the name a person reads — the alias when one was set — so
	 * a household with two servers has one `Shows` rather than three bands showing
	 * somebody the plumbing. That merge happens away from the screen where aliases
	 * and positions are typed, which is why it is shown here: setting an alias and
	 * then hunting through the library wall to find out what it did is how a
	 * setting gets changed twice and understood never.
	 */
	withDefaults(defineProps<{
		categories: MediaCategory[];
		loading?: boolean;
	}>(), {
		loading: false,
	});
</script>

<template>
	<div class="category-list" data-test="category-list">
		<v-progress-linear v-if="loading" color="primary" indeterminate />

		<p
			v-else-if="categories.length === 0"
			class="text-body-2 text-medium-emphasis mb-0"
			data-test="category-list-empty"
		>
			{{ $t('category.empty') }}
		</p>

		<v-list v-else density="compact">
			<v-list-item
				v-for="category of categories"
				:key="category.key"
				class="category-list_row"
				:data-category="category.key"
				:data-libraries="category.libraryIds.length"
				:data-services="category.serviceIds.length"
				data-test="category-row"
			>
				<template #prepend>
					<v-chip class="mr-3" label size="small" variant="tonal">{{ category.position }}</v-chip>
				</template>

				<v-list-item-title>
					{{ category.name }}

					<v-chip class="ml-2" label size="x-small" variant="tonal">
						{{ $t(`library.kind.${category.kind}`) }}
					</v-chip>

					<v-chip
						v-if="category.local"
						class="ml-1"
						color="state-in-sync"
						label
						size="x-small"
						variant="tonal"
					>
						{{ $t('category.local') }}
					</v-chip>
				</v-list-item-title>

				<v-list-item-subtitle>
					{{ $t('category.libraries', { count: category.libraryIds.length }, category.libraryIds.length) }}
					· {{ $t('library.item_count', { count: category.itemCount }, category.itemCount) }}
				</v-list-item-subtitle>
			</v-list-item>
		</v-list>
	</div>
</template>

<style lang="scss">
	.category-list {
		&_row {
			padding-left: 0;
		}
	}
</style>
