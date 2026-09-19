<template>
	<td
		class="components-paginate-tableCell"
		:class="{
			'components-paginate-tableCell--sticky': !!sticky,
		}"
	>
		<div class="components-paginate-tableCell_container">
			<div class="components-paginate-tableCell_data" :class="classContent">
				<slot></slot>
			</div>
		</div>
	</td>
</template>

<script lang="ts" setup>
	withDefaults(defineProps<{
		sticky?: boolean;
		classContent?: any;
	}>(), {
		sticky: false,
		classContent: '',
	});
</script>

<style lang="scss">
	.components-paginate-tableCell {
		padding: 0;

		.components-paginate-tableCell_container {
			padding: 4px 18px 4px 6px;
			font-size: 13px;
		}

		&--sticky {
			position: sticky;
			right: 0;
			z-index: 1;
		}

		&:last-child {
			.components-paginate-tableCell_container {
				padding-right: 24px;
			}
		}

		&[numeric] {
			.components-paginate-tableCell_container {
				text-align: right;
			}
		}

		&[width-fixed] &_container{
			padding: 0;
		}
		&[width-fixed] &_data{
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			padding: 3px 0;
			width: min-content;
		}
	}
</style>
