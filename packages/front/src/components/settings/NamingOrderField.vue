<script lang="ts" setup>
	import { isNamingConvention, NAMING_CONVENTIONS, NamingScheme } from '@mcs/shared';
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';

	/**
	 * How a pulled file is named, as an order rather than as one chosen scheme.
	 *
	 * It is presented the way the placement rule above it is: the steps numbered, in
	 * the order the gateway applies them, readable before anything is touched. The two
	 * decide the same thing between them — the folders and then the name — and a screen
	 * that stated one as a rule and offered the other as a menu would read as two
	 * unrelated settings.
	 *
	 * The convention sits on the last line and is chosen rather than ordered, because
	 * it is the step that always answers: nothing can follow it, and something has to
	 * be there or a finished transfer has no name to be written under.
	 */
	const order = defineModel<NamingScheme[]>({ required: true });

	withDefaults(defineProps<{ loading?: boolean }>(), { loading: false });

	const { t } = useI18n();

	/**
	 * The convention the order ends on, and a standing answer when it ends on nothing.
	 *
	 * The API refuses an order without one, so the fallback is only ever reached while
	 * the settings are still loading — but a select bound to `undefined` clears itself
	 * and would save the empty answer it displayed.
	 */
	const convention = computed(
		() => order.value.find(step => isNamingConvention(step)) ?? NamingScheme.STANDARD,
	);

	/** Everything before the convention: the steps that may decline, in their order. */
	const steps = computed(() => order.value.filter(step => !isNamingConvention(step)));

	const unused = computed(() => Object.values(NamingScheme)
		.filter(step => !isNamingConvention(step) && !order.value.includes(step)));

	const conventions = computed(() => NAMING_CONVENTIONS.map(value => ({
		value,
		title: t(`settings.naming.step.${value}`),
		subtitle: t(`settings.naming.step_help.${value}`),
	})));

	/**
	 * Rebuilt rather than spliced in place.
	 *
	 * The array belongs to the page's form model, and mutating it would change what
	 * the form holds without the watcher that marks the tab ever seeing an assignment.
	 */
	function rebuild (before: NamingScheme[]): void {
		order.value = [...before, convention.value];
	}

	function move (index: number, delta: number): void {
		const next = [...steps.value];
		const target = index + delta;

		[next[index], next[target]] = [next[target], next[index]];
		rebuild(next);
	}

	function drop (step: NamingScheme): void {
		rebuild(steps.value.filter(one => one !== step));
	}

	/** Added at the end of the steps, which is ahead of the convention — never after it. */
	function add (step: NamingScheme): void {
		rebuild([...steps.value, step]);
	}

	function chooseConvention (step: NamingScheme | null): void {
		order.value = [...steps.value, step ?? NamingScheme.STANDARD];
	}
</script>

<template>
	<div class="settings_rule naming-order" data-test="settings-naming-rule">
		<p class="text-body-2 font-weight-medium mb-1">{{ $t('settings.naming.rule_title') }}</p>

		<ol class="settings_rule-steps text-body-2" data-test="settings-naming-order">
			<li
				v-for="(step, index) in steps"
				:key="step"
				class="naming-order_step"
				:data-test="`settings-naming-step-${step}`"
			>
				<div class="naming-order_text">
					{{ $t(`settings.naming.step.${step}`) }}

					<span class="text-caption text-medium-emphasis d-block">
						{{ $t(`settings.naming.step_help.${step}`) }}
					</span>
				</div>

				<div class="naming-order_actions">
					<v-btn
						:aria-label="$t('settings.naming.move_up')"
						:data-test="`settings-naming-up-${step}`"
						density="comfortable"
						:disabled="loading || index === 0"
						icon="mdi-arrow-up"
						size="small"
						:title="$t('settings.naming.move_up')"
						variant="text"
						@click="move(index, -1)"
					/>

					<v-btn
						:aria-label="$t('settings.naming.move_down')"
						:data-test="`settings-naming-down-${step}`"
						density="comfortable"
						:disabled="loading || index === steps.length - 1"
						icon="mdi-arrow-down"
						size="small"
						:title="$t('settings.naming.move_down')"
						variant="text"
						@click="move(index, 1)"
					/>

					<v-btn
						:aria-label="$t('settings.naming.drop')"
						:data-test="`settings-naming-drop-${step}`"
						density="comfortable"
						:disabled="loading"
						icon="mdi-close"
						size="small"
						:title="$t('settings.naming.drop')"
						variant="text"
						@click="drop(step)"
					/>
				</div>
			</li>

			<li class="naming-order_step" data-test="settings-naming-convention">
				<v-select
					class="naming-order_convention"
					data-test="settings-naming-convention-select"
					density="compact"
					:disabled="loading"
					hide-details
					item-props
					item-title="title"
					item-value="value"
					:items="conventions"
					:label="$t('settings.naming.convention')"
					:model-value="convention"
					variant="outlined"
					@update:model-value="chooseConvention"
				/>
			</li>
		</ol>

		<!--
			Said out loud, because it is the question somebody asks of a list that can be
			reordered: why the bottom line has no arrows and cannot be taken off.
		-->
		<p class="text-caption text-medium-emphasis mt-2 mb-0">{{ $t('settings.naming.rule_note') }}</p>

		<!--
			The steps nobody chose are shown rather than hidden. A list that only holds
			what is in use cannot say what else there was, and a setting somebody cannot
			see is one they conclude does not exist.
		-->
		<div v-if="unused.length > 0" class="naming-order_unused" data-test="settings-naming-unused">
			<span class="text-caption text-medium-emphasis">{{ $t('settings.naming.unused') }}</span>

			<v-btn
				v-for="step in unused"
				:key="step"
				:data-test="`settings-naming-add-${step}`"
				:disabled="loading"
				prepend-icon="mdi-plus"
				size="small"
				variant="tonal"
				@click="add(step)"
			>
				{{ $t(`settings.naming.step.${step}`) }}
			</v-btn>
		</div>
	</div>
</template>

<style lang="scss">
	.naming-order {
		&_step {
			padding: 4px 0;
		}

		&_step::marker {
			font-variant-numeric: tabular-nums;
		}

		// The text and the buttons on one line, so the numbers stay the first thing
		// read: the order is the setting, and the controls only edit it.
		&_text {
			display: inline-block;
			vertical-align: middle;
		}

		&_actions {
			display: inline-flex;
			gap: 2px;
			vertical-align: middle;
			margin-left: 8px;
		}

		&_convention {
			max-width: 420px;
			margin: 4px 0;
		}

		&_unused {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
			margin-top: 12px;
		}
	}
</style>
