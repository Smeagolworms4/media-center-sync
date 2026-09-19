<template>
	<v-tooltip
		location="top"
		:open-on-hover="false"
		:open-on-click="true"
		:close-on-content-click="true"
		max-width="320"
		:text="$t(`indications.${name}`)"
	>
		<template #activator="{ props: tooltipProps }">
			<v-icon
				v-bind="tooltipProps"
				class="components-indication"
				size="x-small"
				icon="mdi-help-circle-outline"
			/>
		</template>
	</v-tooltip>
</template>

<script lang="ts" setup>
	defineProps<{
		name: string,
	}>();
</script>

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
