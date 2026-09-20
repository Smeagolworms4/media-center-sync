<script lang="ts" setup>
	import type { Peer } from '@mcs/shared';
	import { MAX_PEER_MAX_DEPTH } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';

	/**
	 * How far introductions through one peer may travel, set on the peer's own row.
	 *
	 * On the row rather than in the settings screen, because the number is about this
	 * friend and not about the gateway: one of them runs a gateway for a household and
	 * another for a club of forty, and the reach that suits the first is not the reach
	 * that suits the second. A single global number forces the same answer on both, and
	 * raising it for the friend who needs it is how a friends-and-family index quietly
	 * becomes a public one.
	 *
	 * Empty means "follow the gateway ceiling", which is why that option is labelled
	 * with the ceiling's own value rather than left blank — a blank entry in a list of
	 * numbers reads as "none", and nobody would guess it means three.
	 */
	const props = defineProps<{
		peer: Peer;
		/** The gateway ceiling, shown as the value the default option resolves to. */
		ceiling: number;
		saving?: boolean;
	}>();

	const emit = defineEmits<{ update: [peer: Peer, maxDepth: number | null] }>();

	const { t } = useI18n();
	const model = ref<number | null>(props.peer.maxDepth);

	// The row can change under the control — a link settles, an event lands — and a
	// select still showing what was picked before that would write a stale value back
	// the next time somebody touched it.
	watch(() => props.peer.maxDepth, value => {
		model.value = value;
	});

	const options = computed(() => [
		{ value: null, title: t('peer.max_depth.default', { count: props.ceiling }) },
		...Array.from({ length: MAX_PEER_MAX_DEPTH }, (_, index) => ({
			value: index + 1,
			title: t('peer.max_depth.hops', { count: index + 1 }, index + 1),
		})),
	]);

	function change (value: number | null): void {
		if (value !== props.peer.maxDepth) {
			emit('update', props.peer, value);
		}
	}
</script>

<template>
	<v-select
		v-model="model"
		class="peer-depth-field"
		data-test="peer-max-depth"
		density="compact"
		hide-details
		:items="options"
		:label="$t('peer.max_depth.label')"
		:loading="saving"
		variant="outlined"
		@update:model-value="change"
	/>
</template>

<style lang="scss">
	.peer-depth-field {
		// Wide enough for "Gateway default (3)" and no wider: it sits in a row of
		// actions, not in a form.
		max-width: 215px;
	}
</style>
