<script lang="ts" setup>
	import type { DestinationLibrary, RejectedLibrary } from '@/composables/useDestinationLibraries';
	import type { MediaCategory } from '@mcs/shared';
	import { computed } from 'vue';

	/**
	 * Where a new series lands, per category, as a table somebody can read at a glance.
	 *
	 * A table rather than a list of fields: the question people come here with is
	 * "which of my categories are pointed somewhere and which are not", and that is a
	 * column, not a paragraph. Every category has a row even when nothing is set for
	 * it, because a category missing from a table of destinations reads as a category
	 * the gateway has forgotten about.
	 *
	 * An empty cell would read the same way, so an unconfigured row names what it
	 * actually does instead of showing nothing. It is a real answer — the destination
	 * one step down the rule — not the absence of one.
	 */
	const targets = defineModel<Record<string, string>>({ required: true });

	const props = withDefaults(defineProps<{
		categories: MediaCategory[];
		destinations: DestinationLibrary[];
		/**
		 * Libraries that cannot receive anything, with the reason.
		 *
		 * Shown on the row of the category they belong to rather than dropped, because
		 * the name somebody is looking for going missing sends them hunting for a fault
		 * in the wrong place — the library is there, it simply cannot be written into.
		 */
		rejected?: RejectedLibrary[];
		/** What a row with no entry does, named. Never left as an empty cell. */
		fallback: string;
		loading?: boolean;
	}>(), {
		rejected: () => [],
		loading: false,
	});

	const items = computed(() => props.destinations.map(one => ({
		value: one.id,
		title: one.name,
		subtitle: one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
	})));

	function rejectedOf (category: MediaCategory): RejectedLibrary[] {
		return props.rejected.filter(one => category.libraryIds.includes(one.id));
	}

	/**
	 * Replaced rather than mutated in place.
	 *
	 * The parent holds this object inside a reactive model and builds the patch from
	 * it; assigning a key on the same reference updates nothing a watcher can see, and
	 * the choice would be lost between clicking and saving.
	 *
	 * Clearing removes the key instead of writing an empty string: the contract is a
	 * map of categories that have an answer, and a key pointing at nothing is a library
	 * identifier the gateway would try to resolve.
	 */
	function choose (key: string, libraryId: string | null): void {
		const next = { ...targets.value };

		if (libraryId) {
			next[key] = libraryId;
		} else {
			delete next[key];
		}

		targets.value = next;
	}
</script>

<template>
	<div class="category-targets" data-test="category-targets">
		<v-progress-linear v-if="loading" color="primary" indeterminate />

		<p
			v-else-if="categories.length === 0"
			class="text-body-2 text-medium-emphasis mb-0"
			data-test="category-targets-empty"
		>
			{{ $t('category.empty') }}
		</p>

		<table v-else class="category-targets_table">
			<thead>
				<tr>
					<th>{{ $t('settings.destination.category_header') }}</th>
					<th>{{ $t('settings.destination.target_header') }}</th>
				</tr>
			</thead>

			<tbody>
				<tr
					v-for="category of categories"
					:key="category.key"
					:data-category="category.key"
					:data-configured="String(Boolean(targets[category.key]))"
					data-test="category-target-row"
				>
					<td class="category-targets_name">
						{{ category.name }}

						<v-chip class="ml-2" label size="x-small" variant="tonal">
							{{ $t(`library.kind.${category.kind}`) }}
						</v-chip>
					</td>

					<td>
						<v-select
							clearable
							:data-test="`category-target-${category.key}`"
							density="compact"
							hide-details
							item-props
							item-title="title"
							item-value="value"
							:items="items"
							:model-value="targets[category.key] ?? null"
							@update:model-value="choose(category.key, $event)"
						/>

						<p
							v-if="!targets[category.key]"
							class="text-caption text-medium-emphasis mt-1 mb-0"
							data-test="category-target-fallback"
						>
							{{ $t('settings.destination.falls_back', { target: fallback }) }}
						</p>

						<p
							v-for="one of rejectedOf(category)"
							:key="one.id"
							class="text-caption text-medium-emphasis mt-1 mb-0"
							data-test="category-target-rejected"
						>
							{{ $t(`settings.destination.rejected.${one.reason}`, {
								library: one.name,
								service: one.serviceName,
							}) }}
						</p>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>

<style lang="scss">
	.category-targets {
		&_table {
			width: 100%;
			border-collapse: collapse;

			th {
				text-align: left;
				font-size: 0.75rem;
				font-weight: 500;
				opacity: 0.7;
				padding: 4px 8px 4px 0;
			}

			td {
				// Top rather than middle: a row whose cell carries a caption underneath
				// the select would otherwise push the category name half a line down and
				// the column would stop reading as a column.
				vertical-align: top;
				padding: 8px 8px 8px 0;
			}
		}

		&_name {
			width: 40%;
			padding-top: 14px !important;
		}
	}
</style>
