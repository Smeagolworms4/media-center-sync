<script lang="ts" setup>
	withDefaults(defineProps<{
		label?: string;
		total: number;
		dense?: boolean;
	}>(), {
		label: '',
		dense: false,
	});

	const page_sync = defineModel<number>('page', { required: true });
	const limit_sync = defineModel<number>('limit', { required: true });
</script>

<template>
	<div
		class="components-paginate-pagination"
		:class="{
			'components-paginate-pagination--dense': dense,
		}"
	>
		<span>{{ label }}</span>

		<v-select
			v-model="limit_sync"
			hide-details
			:items="[10, 20, 50, 100, 200]"
			variant="outlined"
			@update:model-value="limit_sync = $event; page_sync = 0;"
		/>

		{{ page_sync * limit_sync + 1 }}-{{ page_sync * limit_sync + limit_sync }} / {{ total }}

		<span class="paginate-pagination-action">
			<v-btn
				:disabled="page_sync === 0"
				icon="mdi-page-first"
				size="smallest"
				variant="flat"
				@click="page_sync = 0"
			/>

			<v-btn
				:disabled="page_sync === 0"
				icon="mdi-chevron-left"
				size="smallest"
				variant="flat"
				@click="page_sync -= 1"
			/>

			<v-btn
				:disabled="(page_sync + 1) * limit_sync >= total!"
				icon="mdi-chevron-right"
				size="smallest"
				variant="flat"
				@click="page_sync += 1"
			/>

			<v-btn
				:disabled="(page_sync + 1) * limit_sync >= total!"
				icon="mdi-page-last"
				size="smallest"
				variant="flat"
				@click="page_sync = Math.ceil(total! / limit_sync) - 1"
			/>
		</span>

	</div>
</template>

<style lang="scss">
	.components-paginate-pagination {

		font-size: 13px;
		line-height: 40px;
		text-align: right;
		border-top: 1px #DDD solid;
		padding: 2px 15px 0px 15px;
		position: relative;
		background: #FFF;

		&:before {
			border-top: 1px solid #DDD;
			content: ' ';
			width: 100%;
			display: block;
			position: absolute;
			top: 1px;
			left: 0;
		}

		.v-theme--dark & {
			background: #222;
			&:before {
				border-top-color: #000;
			}
		}

		.v-select {
			display: inline-block;
			min-width: 55px;
			margin: -18px 16px -2px 16px;
			font-size: 13px;
			vertical-align: -9px;

			.v-field {
				padding: 0;
			}

			.v-field__field {
				height: 28px;
			}
			.v-field__input {
				padding: 5px 0px 5px 6px;
				min-height: inherit;
				font-size: 13px;
			}
			.v-field__append-inner {
				margin-left: -7px;
			}
		}

		> .paginate-pagination-action {
			white-space: nowrap;
			display: inline-block;
			vertical-align: 2px;

			.v-btn {
				margin-right: 2px;

				&--disabled {
					.v-btn__overlay {
						background: none !important;
					}
				}
			}
		}

		&--dense {
			height: 30px;
			line-height: 30px;
			font-size: 11px;
			overflow: hidden;

			> .paginate-pagination-action {
				margin-top: -4px;
			}
			.v-select {
				.v-field__input {
					font-size: 11px;
				}
			}
		}
		@media (max-width: 460px) {
			> span {
				display: none;
			}
		}
	}
</style>
