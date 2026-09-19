<template>
	<th
		class="components-paginate-tableHead"
		:class="{
			'components-paginate-tableHead--sticky': !!sticky,
			'components-paginate-tableHead--sort': !!sortBy,
			'components-paginate-tableHead--sorted': !!sortBy && sortBy === order,
			'components-paginate-tableHead--sortDesc': direction === AscDesc.DESC,
		}"
		@click="handleOrderBy()"
	>
		<div v-ripple="!!sortBy" class="components-paginate-tableHead_container" >
			<v-icon v-if="!!sortBy" class="components-paginate-tableHead_arrowSort">mdi-arrow-up</v-icon>
			<div class="components-paginate-tableHead_data">
				<slot></slot>
			</div>
		</div>
	</th>
</template>

<script lang="ts" setup>
	import { computed, inject, type Ref } from 'vue';
	import { AscDesc } from '@/models';

	const props = withDefaults(defineProps<{
		sortBy?: Nullable<string>;
		sticky?: boolean;
	}>(), {
		sortBy: null,
		sticky: false,
	});

	const emit = defineEmits<{
		'on-order-by': [value: string];
		'on-direction-by': [value: AscDesc];
	}>();

	type PaginateTableContext = {
		order: Ref<Nullable<string>>;
		direction: Ref<AscDesc>;
	};
	const paginateTable = inject<PaginateTableContext>('paginateTable');
	const order = computed(() => paginateTable?.order.value);
	const direction = computed(() => paginateTable?.direction.value);

	const handleOrderBy = () => {
		if (!!props.sortBy && paginateTable) {
			if (paginateTable.order.value === props.sortBy) {
				paginateTable.direction.value = paginateTable.direction.value === AscDesc.DESC ? AscDesc.ASC : AscDesc.DESC;
				emit('on-direction-by', paginateTable.direction.value);
			} else {
				paginateTable.order.value = props.sortBy;
				emit('on-order-by', props.sortBy);
			}
		}
	}
</script>

<style lang="scss">
	.components-paginate-tableHead {
		padding: 0;
		text-align: left;
		font-size: 12px;
		font-weight: 700;
		white-space: nowrap;
		position: relative;
		transition: color 0.3s cubic-bezier(0.4, 0, 0.2, 1);
		color: rgba(0, 0, 0, 0.54);

		.v-theme--dark & {
			color: rgba(255, 255, 255, 0.54);
		}
		&--sticky {
			position: sticky;
			right: 0;
		}

		&--sort {
			cursor: pointer;

			.components-paginate-tableHead_arrowSort.v-icon {
				color: #000 !important;
				font-size: 16px !important;
				font-weight: normal;
				position: absolute;
				left: 1px;
				top: 50%;
				display: inline-block;
				transform: translateY(-50%);
				width: 24px;
				height: 20px;
				text-align: center;
				opacity: 0;
				transition: 0.3s cubic-bezier(0.4, 0, 0.2, 1);

				.v-theme--dark & {
					color: #FFF !important;
				}
			}

			&:first-child {
				.components-paginate-tableHead_arrowSort.v-icon {
					left: auto;
					right: 0px;
				}
			}

			&:hover, &.components-paginate-tableHead--sorted {
				color: #000;
				.v-theme--dark & {
					color: #FFF;
				}

				.components-paginate-tableHead_container {
					padding: 4px 22px 4px 22px;
				}

				.v-icon {
					opacity: 1;
				}
			}

			&.components-paginate-tableHead--sorted.components-paginate-tableHead--sortDesc {
				.components-paginate-tableHead_container {
					padding: 4px 22px 4px 22px;
				}
				.components-paginate-tableHead_arrowSort.v-icon {
					transform: translateY(-50%) rotate(180deg);
				}
			}
		}

		&_container {
			padding: 4px 4px 6px 4px;
			transition: padding 0.4s;
			height: 36px;
			line-height: 28px;
		}

		&[numeric] {
			.components-paginate-tableHead_container {
				text-align: right;
			}
		}
	}
</style>
