<script lang="ts" setup>
	defineProps<{
		name: string;
	}>();
</script>

<template>
	<v-tooltip
		:close-on-content-click="true"
		location="top"
		max-width="320"
		:open-on-click="true"
		:open-on-hover="false"
		:text="$t(`indications.${name}`)"
	>
		<template #activator="{ props: tooltipProps }">
			<v-icon
				v-bind="tooltipProps"
				class="components-indication"
				icon="mdi-help-circle-outline"
				size="x-small"
			/>
		</template>
	</v-tooltip>
</template>

<style lang="scss">
	.components-indication {
		cursor: pointer;
		opacity: 0.6;
		margin-left: 4px;
		transition: opacity 0.2s;
		margin-bottom: 2px;

		&:hover {
			opacity: 1;
		}
	}
</style>
