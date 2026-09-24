<script lang="ts" setup>
	import {
		isEmptyReleasePreference,
		type MediaCategory,
		RELEASE_PREFERENCE_DIMENSIONS,
		RELEASE_PREFERENCE_SUGGESTIONS,
		type ReleasePreference,
		type ReleasePreferenceDimension,
		type ReleasePreferenceSettings,
	} from '@mcs/shared';
	import { computed, ref } from 'vue';

	/**
	 * What a better copy is, said once instead of once per search.
	 *
	 * A search comes back ordered by seeders, which is the only order a gateway that
	 * knows nothing about the household can produce and the wrong one for every
	 * household: the best-seeded line is usually a 2160p remux, and a house watching on
	 * a 1080p television wants the third line down. This screen is where that is said.
	 *
	 * Presented as an order and numbered, the way `NamingOrderField` presents the naming
	 * chain, because it is the same kind of statement and reading it is the point: the
	 * dimensions are numbered because their order decides — resolution above codec means
	 * a 1080p x264 beats a 720p x265 — and the values inside each are numbered for the
	 * same reason. A screen that offered three unordered lists could not express the
	 * sentence the setting is for.
	 *
	 * **The household order and the per-category ones are one screen**, which is the
	 * shape that was asked for and is also the only honest one: they are three levels of
	 * one answer, and a category pane on a tab of its own would be a setting somebody
	 * discovers by accident after wondering for a week why `Séries` behaves differently.
	 * Every override is listed here with its own cancel, including one whose category no
	 * media server is currently reporting — a shelf disappears the moment a service goes
	 * offline, and an override hidden because its category is briefly missing is exactly
	 * the invisible setting this screen exists to prevent.
	 *
	 * A single media's own order is **not** here: it lives on the media, which is where
	 * it can be seen and cancelled by somebody looking at the thing it affects. This
	 * screen only says so, so that a search that answers oddly on one series has
	 * somewhere to be explained.
	 *
	 * Nothing here filters. Every release found stays listed and an order can only move
	 * a row, which is said on the screen rather than only in the code: a person who
	 * believes their preference hides things will not write the preference they mean.
	 */
	const settings = defineModel<ReleasePreferenceSettings>({ required: true });

	const props = withDefaults(defineProps<{
		/** Every category, ours and a peer's alike: this orders searches, not files. */
		categories: MediaCategory[];
		loading?: boolean;
	}>(), { loading: false });

	/**
	 * One editable order on the screen: the household's, or one category's.
	 *
	 * `categoryKey` is null for the household pane and is what every write is addressed
	 * by. A `'global'` sentinel key was the obvious alternative and is a real bug: a
	 * library called `Global` folds to the category key `global`, and its override would
	 * have silently edited the household order.
	 */
	interface Pane {
		id: string;
		title: string;
		/** What the pane is, when the title alone does not say. */
		note: string | null;
		categoryKey: string | null;
		preference: ReleasePreference;
	}

	const drafts = ref<Record<string, string>>({});

	const overrideTarget = ref<string | null>(null);

	const panes = computed<Pane[]>(() => {
		const byCategory = settings.value.byCategory;
		const keys = Object.keys(byCategory);

		return [
			{
				id: 'global',
				title: '',
				note: null,
				categoryKey: null,
				preference: settings.value.global,
			},
			/*
			 * Category order first, then whatever is left.
			 *
			 * The leftovers are the overrides whose category nothing is reporting right
			 * now — an offline media server, a peer that is away — and they are listed
			 * under their stored key rather than dropped. They are still in force, and a
			 * setting that only appears when the service it was written for is up is one
			 * nobody can cancel on the day it is in the way.
			 */
			...props.categories
				.filter(one => byCategory[one.key] !== undefined)
				.map(one => ({
					id: one.key,
					title: one.name,
					note: null,
					categoryKey: one.key,
					preference: byCategory[one.key],
				})),
			...keys
				.filter(key => !props.categories.some(one => one.key === key))
				.map(key => ({
					id: key,
					title: key,
					note: 'settings.preference.category_absent',
					categoryKey: key,
					preference: byCategory[key],
				})),
		];
	});

	/** Categories that could still be given one of their own. */
	const available = computed(() => props.categories
		.filter(one => settings.value.byCategory[one.key] === undefined)
		.map(one => ({ value: one.key, title: one.name })));

	function unusedIn (pane: Pane): ReleasePreferenceDimension[] {
		return RELEASE_PREFERENCE_DIMENSIONS
			.filter(dimension => !pane.preference.ranks.some(rank => rank.dimension === dimension));
	}

	/**
	 * What the add field offers beside whatever somebody types.
	 *
	 * Suggestions and never a closed list: a tracker will eventually carry a tag nothing
	 * here has heard of, and teams have no suggestions at all because the groups a
	 * household trusts are its own business and no list we ship would be theirs.
	 */
	function suggestionsFor (dimension: ReleasePreferenceDimension, values: string[]): string[] {
		return RELEASE_PREFERENCE_SUGGESTIONS[dimension]
			.filter(one => !values.some(value => value.toLowerCase() === one.toLowerCase()));
	}

	function draftKey (pane: Pane, dimension: ReleasePreferenceDimension): string {
		return `${pane.id}:${dimension}`;
	}

	/**
	 * Replaced rather than mutated in place.
	 *
	 * The parent holds this object inside a form model and builds the patch it saves
	 * from it. Assigning into the same reference changes what the form holds without any
	 * watcher seeing an assignment, so the edit is lost between the click and the save —
	 * and it looks like the click did nothing, which is how somebody sets a preference
	 * twice and keeps neither.
	 */
	function write (categoryKey: string | null, preference: ReleasePreference): void {
		settings.value = categoryKey === null
			? { ...settings.value, global: preference }
			: {
				...settings.value,
				byCategory: { ...settings.value.byCategory, [categoryKey]: preference },
			};
	}

	function update (pane: Pane, ranks: ReleasePreference['ranks']): void {
		write(pane.categoryKey, { ranks });
	}

	/** One dimension's values rewritten, the others left exactly as they were. */
	function rewrite (
		pane: Pane,
		dimension: ReleasePreferenceDimension,
		values: (current: string[]) => string[],
	): void {
		update(pane, pane.preference.ranks.map(rank => (
			rank.dimension === dimension ? { dimension, values: values(rank.values) } : rank
		)));
	}

	function moveDimension (pane: Pane, index: number, delta: number): void {
		const ranks = [...pane.preference.ranks];
		const target = index + delta;

		[ranks[index], ranks[target]] = [ranks[target], ranks[index]];
		update(pane, ranks);
	}

	function dropDimension (pane: Pane, dimension: ReleasePreferenceDimension): void {
		update(pane, pane.preference.ranks.filter(rank => rank.dimension !== dimension));
	}

	/** Added last, because a dimension nobody has ranked yet cannot outrank a ranked one. */
	function addDimension (pane: Pane, dimension: ReleasePreferenceDimension): void {
		update(pane, [...pane.preference.ranks, { dimension, values: [] }]);
	}

	function promoteValue (pane: Pane, dimension: ReleasePreferenceDimension, index: number): void {
		rewrite(pane, dimension, current => {
			const values = [...current];

			[values[index - 1], values[index]] = [values[index], values[index - 1]];

			return values;
		});
	}

	function dropValue (pane: Pane, dimension: ReleasePreferenceDimension, value: string): void {
		rewrite(pane, dimension, current => current.filter(one => one !== value));
	}

	/**
	 * A value committed in the add field, chosen from the list or typed outright.
	 *
	 * `update:modelValue` on a combobox is the commit — enter, blur or choosing an item —
	 * and never the keystroke, which is `update:search`. Listening to the wrong one would
	 * rank a team called `N`, then `NT`, then `NTb`.
	 *
	 * Case-insensitive against what is already there, because the comparator folds case
	 * anyway: two chips reading `NTb` and `ntb` would be one value shown twice, with the
	 * second one apparently doing nothing.
	 */
	function addValue (
		pane: Pane,
		dimension: ReleasePreferenceDimension,
		value: string | null,
	): void {
		const wanted = (value ?? '').trim();

		drafts.value = { ...drafts.value, [draftKey(pane, dimension)]: '' };

		if (wanted === '') {
			return;
		}

		rewrite(pane, dimension, current => (
			current.some(one => one.toLowerCase() === wanted.toLowerCase())
				? current
				: [...current, wanted]
		));
	}

	/**
	 * A category given an order of its own, started as a copy of the household's.
	 *
	 * A copy and not an empty pane: overriding means "like that, but". Starting blank
	 * would make the commonest edit — 1080p everywhere, 2160p for films — a retyping of
	 * everything the household already said, and a half-finished retyping is an order
	 * that silently differs from the one it was meant to resemble.
	 *
	 * It is a copy and nothing more. Nothing is inherited afterwards: an override
	 * replaces the household order whole, so changing the household's later does not
	 * reach in here. That is what makes cancelling it an exact undo.
	 */
	function addOverride (key: string | null): void {
		overrideTarget.value = null;

		if (key === null || key === '') {
			return;
		}

		write(key, {
			ranks: settings.value.global.ranks.map(rank => ({
				dimension: rank.dimension,
				values: [...rank.values],
			})),
		});
	}

	/** Cancelled, not emptied: the category goes back to following the household order. */
	function cancelOverride (key: string): void {
		const byCategory = { ...settings.value.byCategory };

		delete byCategory[key];
		settings.value = { ...settings.value, byCategory };
	}

	function separatesNothing (pane: Pane): boolean {
		return isEmptyReleasePreference(pane.preference);
	}
</script>

<template>
	<div class="release-preferences" data-test="release-preferences">
		<!--
			Said before anything is edited, and on the screen rather than only in the
			code. Somebody who believes a preference hides releases writes a cautious one
			that does not say what they mean — and the opposite belief costs a download.
		-->
		<p class="text-body-2 text-medium-emphasis" data-test="release-preferences-help">
			{{ $t('settings.preference.orders_only') }}
		</p>

		<section
			v-for="pane of panes"
			:key="pane.id"
			class="release-preferences_pane"
			:data-scope="pane.categoryKey === null ? 'global' : 'category'"
			:data-test="`release-preferences-pane-${pane.id}`"
		>
			<div class="release-preferences_head">
				<strong>
					{{ pane.categoryKey === null
						? $t('settings.preference.global_title')
						: $t('settings.preference.category_title', { category: pane.title }) }}
				</strong>

				<!--
					An override whose category nothing is reporting right now. Labelled
					rather than hidden: it is still in force, and the day it is in the way
					is the day its service is offline.
				-->
				<v-chip v-if="pane.note" label size="x-small" variant="tonal">
					{{ $t(pane.note) }}
				</v-chip>

				<v-btn
					v-if="pane.categoryKey !== null"
					:data-test="`release-preferences-cancel-${pane.id}`"
					:disabled="loading"
					prepend-icon="mdi-close"
					size="small"
					variant="text"
					@click="cancelOverride(pane.categoryKey)"
				>
					{{ $t('settings.preference.cancel_override') }}
				</v-btn>
			</div>

			<!--
				An order that separates nothing says so. An empty list reads as a control
				that failed to load, and this one is empty precisely when the answer is
				"seeders and size still decide", which is a real answer worth naming.
			-->
			<p
				v-if="separatesNothing(pane)"
				class="text-caption text-medium-emphasis"
				:data-test="`release-preferences-none-${pane.id}`"
			>
				{{ $t('settings.preference.separates_nothing') }}
			</p>

			<ol class="release-preferences_ranks text-body-2" :data-test="`release-preferences-ranks-${pane.id}`">
				<li
					v-for="(rank, index) of pane.preference.ranks"
					:key="rank.dimension"
					class="release-preferences_rank"
					:data-test="`release-preferences-rank-${pane.id}-${rank.dimension}`"
				>
					<div class="release-preferences_rank-head">
						<span class="release-preferences_text">
							{{ $t(`settings.preference.dimension.${rank.dimension}`) }}

							<span class="text-caption text-medium-emphasis d-block">
								{{ $t(`settings.preference.dimension_help.${rank.dimension}`) }}
							</span>
						</span>

						<span class="release-preferences_actions">
							<v-btn
								:aria-label="$t('settings.preference.move_up')"
								:data-test="`release-preferences-up-${pane.id}-${rank.dimension}`"
								density="comfortable"
								:disabled="loading || index === 0"
								icon="mdi-arrow-up"
								size="small"
								:title="$t('settings.preference.move_up')"
								variant="text"
								@click="moveDimension(pane, index, -1)"
							/>

							<v-btn
								:aria-label="$t('settings.preference.move_down')"
								:data-test="`release-preferences-down-${pane.id}-${rank.dimension}`"
								density="comfortable"
								:disabled="loading || index === pane.preference.ranks.length - 1"
								icon="mdi-arrow-down"
								size="small"
								:title="$t('settings.preference.move_down')"
								variant="text"
								@click="moveDimension(pane, index, 1)"
							/>

							<v-btn
								:aria-label="$t('settings.preference.drop')"
								:data-test="`release-preferences-drop-${pane.id}-${rank.dimension}`"
								density="comfortable"
								:disabled="loading"
								icon="mdi-close"
								size="small"
								:title="$t('settings.preference.drop')"
								variant="text"
								@click="dropDimension(pane, rank.dimension)"
							/>
						</span>
					</div>

					<div class="release-preferences_values">
						<!--
							The values are numbered too, because their order is the other
							half of the setting. A chip strip with no numbers reads as a
							set, and `2160p, 1080p` and `1080p, 2160p` would look like the
							same answer.
						-->
						<span
							v-for="(value, place) of rank.values"
							:key="value"
							class="release-preferences_value"
						>
							<v-btn
								:aria-label="$t('settings.preference.promote')"
								:data-test="`release-preferences-promote-${pane.id}-${rank.dimension}-${place}`"
								density="compact"
								:disabled="loading || place === 0"
								icon="mdi-arrow-left"
								size="x-small"
								:title="$t('settings.preference.promote')"
								variant="text"
								@click="promoteValue(pane, rank.dimension, place)"
							/>

							<v-chip
								closable
								:data-test="`release-preferences-value-${pane.id}-${rank.dimension}-${value}`"
								label
								size="small"
								variant="tonal"
								@click:close="dropValue(pane, rank.dimension, value)"
							>
								<span class="text-medium-emphasis mr-1">{{ place + 1 }}.</span>{{ value }}
							</v-chip>
						</span>

						<!--
							A combobox and not a select: it offers the values a tracker
							usually prints and still takes one nobody here has heard of,
							which every dimension needs and the team one is made of.
						-->
						<v-combobox
							class="release-preferences_input"
							:data-test="`release-preferences-add-value-${pane.id}-${rank.dimension}`"
							density="compact"
							:disabled="loading"
							hide-details
							:items="suggestionsFor(rank.dimension, rank.values)"
							:label="$t('settings.preference.add_value')"
							:model-value="drafts[draftKey(pane, rank.dimension)] ?? ''"
							@update:model-value="addValue(pane, rank.dimension, $event)"
						/>

						<!--
							An empty dimension is not a mistake — it is how a category
							silences one the household order cares about — so it is named
							rather than marked as unfinished.
						-->
						<span
							v-if="rank.values.length === 0"
							class="text-caption text-medium-emphasis"
							:data-test="`release-preferences-no-value-${pane.id}-${rank.dimension}`"
						>
							{{ $t('settings.preference.no_value') }}
						</span>
					</div>
				</li>
			</ol>

			<!--
				The dimensions nobody ranked are shown rather than hidden, for the reason
				the naming order shows its unused steps: a list holding only what is in
				use cannot say what else there was, and a setting somebody cannot see is
				one they conclude does not exist.
			-->
			<div
				v-if="unusedIn(pane).length > 0"
				class="release-preferences_unused"
				:data-test="`release-preferences-unused-${pane.id}`"
			>
				<span class="text-caption text-medium-emphasis">{{ $t('settings.preference.unused') }}</span>

				<v-btn
					v-for="dimension of unusedIn(pane)"
					:key="dimension"
					:data-test="`release-preferences-add-${pane.id}-${dimension}`"
					:disabled="loading"
					prepend-icon="mdi-plus"
					size="small"
					variant="tonal"
					@click="addDimension(pane, dimension)"
				>
					{{ $t(`settings.preference.dimension.${dimension}`) }}
				</v-btn>
			</div>
		</section>

		<div class="release-preferences_add-override">
			<v-select
				class="release-preferences_input"
				clearable
				data-test="release-preferences-add-override"
				density="compact"
				:disabled="loading || available.length === 0"
				hide-details
				item-title="title"
				item-value="value"
				:items="available"
				:label="$t('settings.preference.add_override')"
				:model-value="overrideTarget"
				@update:model-value="addOverride($event)"
			/>

			<p class="text-caption text-medium-emphasis mb-0" data-test="release-preferences-override-note">
				{{ $t('settings.preference.override_note') }}
			</p>
		</div>

		<!--
			Where the third level is, said here because this is where somebody comes
			looking for it. A media's own order is on the media, which is the only place
			it can be seen by somebody wondering why that one series answers differently.
		-->
		<p class="text-caption text-medium-emphasis mb-0" data-test="release-preferences-media-note">
			{{ $t('settings.preference.media_note') }}
		</p>
	</div>
</template>

<style lang="scss">
	.release-preferences {
		&_pane {
			border: 1px solid rgb(var(--v-border-color), 0.25);
			border-radius: 6px;
			padding: 8px 12px;
			margin-bottom: 12px;
		}

		&_head {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 4px;
		}

		&_rank {
			padding: 4px 0;
		}

		// Tabular numbers so the list reads as an order at a glance rather than as a
		// column of digits of different widths.
		&_rank::marker {
			font-variant-numeric: tabular-nums;
		}

		&_rank-head {
			display: flex;
			align-items: flex-start;
			gap: 8px;
		}

		&_text {
			display: inline-block;
		}

		&_actions {
			display: inline-flex;
			gap: 2px;
			margin-left: auto;
		}

		// One strip, wrapping. As blocks, five dimensions with four values each filled
		// the viewport and the pane below — the category overrides are the other half of
		// this screen and have to stay reachable without scrolling past a wall.
		&_values {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 4px;
			margin: 4px 0 8px;
		}

		&_value {
			display: inline-flex;
			align-items: center;
		}

		&_unused {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
			margin: 8px 0 4px;
		}

		&_input {
			max-width: 260px;
		}

		&_add-override {
			margin: 4px 0 12px;
		}
	}
</style>
