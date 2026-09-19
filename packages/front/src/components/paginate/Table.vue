<script lang="ts" setup>
	import { computed, nextTick, onMounted, onUpdated, provide, ref, watch } from 'vue';
	import { useInterval, useNativeEvent } from '@/hooks';
	import { HTMLHelper } from '@/libs/utils';
	import PaginatePagination from './Pagination.vue';
	import { AscDesc } from './sort';

	withDefaults(defineProps<{
		items?: Nullable<any[]>;
		dense?: boolean;
		classBodyItem?: (item: any) => string;
		total?: Nullable<number>;
		sticky?: boolean;
		noPaginate?: boolean;
		noEmptyMessage?: boolean;
		emptyMessage?: Nullable<string>;
	}>(), {
		items: null,
		dense: false,
		classBodyItem: () => '',
		total: null,
		sticky: false,
		noPaginate: false,
		noEmptyMessage: false,
		emptyMessage: null,
	});

	const emit = defineEmits<{
		select: [item: any];
	}>();

	const page_sync = defineModel<Nullable<number>>('page', { default: null });
	const limit_sync = defineModel<Nullable<number>>('limit', { default: null });
	const order_sync = defineModel<Nullable<string>>('order', { default: null });
	const direction_sync = defineModel<AscDesc>('direction', { default: AscDesc.ASC });

	// The pagination control works on numbers; the table's own models are nullable
	// because a caller that does not paginate passes nothing at all.
	const paginationPage = computed({
		get: () => page_sync.value ?? 0,
		set: (value: number) => {
			page_sync.value = value;
		},
	});
	const paginationLimit = computed({
		get: () => limit_sync.value ?? 20,
		set: (value: number) => {
			limit_sync.value = value;
		},
	});

	const root = ref<HTMLElement>();
	const paginateTableData = ref<HTMLElement>();
	const paginateTableMain = ref<HTMLElement>();

	provide('paginateTable', {
		order: order_sync,
		direction: direction_sync,
	});

	let oldWidth = 0;
	let domsModified: {
		subContainer: HTMLElement;
		originalContainer: HTMLElement;
		data: HTMLElement;
	}[] = [];

	let selected: any = null;
	useNativeEvent(document.body, 'click', () => {
		if (selected) {
			selected = null;
			emit('select', null);
		}
	});

	function openBody (event: MouseEvent, item: any): void {
		if (root.value!.querySelectorAll('.components-paginate-table_col--hidden').length > 0) {
			const $tbody = HTMLHelper.findParentByTag(event.target as HTMLElement, 'tbody');
			$tbody?.classList.toggle('components-paginate-table_responsive--open');
		}
		setTimeout(() => {
			selected = item;
			emit('select', item);
		}, 100);
	}
	function hasScroll (): boolean {
		if (!paginateTableData.value) {
			return false;
		}
		return paginateTableData.value!.scrollWidth > paginateTableData.value!.clientWidth;
	}

	function clearResponsive () {
		if (paginateTableData.value) {
			paginateTableData.value!.classList.remove('components-paginate-table_data--responsive');
		}
		for (const domModified of domsModified) {
			domModified.originalContainer.append(domModified.data);
			domModified.subContainer.remove();
		}
		domsModified = [];
		for (const child of root.value!
		.querySelectorAll('.components-paginate-table_col--hidden')) child.classList.remove('components-paginate-table_col--hidden')

		;
	}

	function refreshResponsive (force = false): any {
		if (!paginateTableMain.value) {
			return;
		}
		const $table = paginateTableMain.value as HTMLElement;
		const width = $table.offsetWidth;

		// Columns asked to collapse can appear after mount, when a page fills a slot.
		const thResponsiveNotWatched = root.value!.querySelectorAll('thead tr th[responsive]:not(.components-paginate-table_col--responsive)');
		if (thResponsiveNotWatched.length > 0) {
			force = true;
			for (const child of thResponsiveNotWatched) child.classList.add('components-paginate-table_col--responsive');
		}
		const thWatchedNotResponsive = root.value!.querySelectorAll('thead tr th.components-paginate-table_col--responsive:not([responsive])');
		if (thWatchedNotResponsive.length > 0) {
			force = true;
			for (const child of thWatchedNotResponsive) child.classList.remove('components-paginate-table_col--responsive');
		}

		if (force || oldWidth !== width) {
			oldWidth = width;
			clearResponsive();
		}

		if (root.value!.querySelectorAll('th.components-paginate-tableHead').length > 0 && hasScroll()) {
			applyResponsive();
		}
	}

	function applyResponsive () {
		const ths = root.value!.querySelectorAll<HTMLElement>('th.components-paginate-tableHead');

		const posResponsive: number[] = [];
		for (const [i, th] of ths.entries()) {
			if (th.classList.contains('components-paginate-table_col--responsive')) {
				posResponsive.push(i);
			}
		}
		posResponsive.reverse();

		for (const pos of posResponsive) {
			const childTh = root.value!.querySelector<HTMLElement>('th.components-paginate-tableHead:nth-child(' + (pos + 1) + ')');
			const childTds = root.value!.querySelectorAll<HTMLElement>('td.components-paginate-tableCell:nth-child(' + (pos + 1) + ')');

			childTh!.classList.add('components-paginate-table_col--hidden');
			for (const child of childTds) child.classList.add('components-paginate-table_col--hidden');
			const label = childTh!.querySelector<HTMLElement>('.components-paginate-tableHead_data')?.textContent ?? '';
			for (const childTd of childTds) {
				const subContainer = childTd.parentElement!.nextElementSibling!.querySelector<HTMLElement>('.components-paginate-table_subDataContainer');

				const subTr = document.createElement('tr');
				subTr.innerHTML = `<th>${label}</th><td class="components-paginate-table_subDataContainer_value"></td>`;
				const data = childTd.querySelector<HTMLElement>('.components-paginate-tableCell_data');
				if (data) {
					domsModified.push({
						data,
						originalContainer: data.parentElement!,
						subContainer: subTr,
					});
					subTr.querySelector<HTMLElement>('.components-paginate-table_subDataContainer_value')?.append(data);
					if (subContainer) {
						if (subContainer.childNodes?.length) {
							subContainer.insertBefore(subTr, subContainer.firstChild);
						} else {
							subContainer.append(subTr);
						}
					}
				}
			}

			if (!hasScroll()) {
				break;
			}
		}

		if (paginateTableData.value && posResponsive.length > 0) {
			paginateTableData.value!.classList.add('components-paginate-table_data--responsive');
		}
	}

	useNativeEvent(window, 'resize', refreshResponsive);
	useInterval(refreshResponsive, 150);

	onMounted(async () => {
		refreshResponsive();
		await nextTick();
		refreshResponsive(true);
	});

	onUpdated(() => {
		refreshResponsive(true);
	});

	watch(
		[page_sync, limit_sync, order_sync, direction_sync],
		() => {
			if (paginateTableData.value) {
				paginateTableData.value!.scrollTo({
					top: 0,
					behavior: 'smooth',
				});
			}
		},
	);
</script>

<template>
	<div
		ref="root"
		class="components-paginate-table"
		:class="{
			'components-paginate-table--sticky': sticky,
			'components-paginate-table--dense': dense,
		}"
	>

		<div ref="paginateTableData" class="components-paginate-table_data">
			<table v-if="items" ref="paginateTableMain" class="components-paginate-table_main">
				<thead>
					<tr>
						<slot name="head" />
					</tr>
				</thead>

				<template v-if="items.length > 0">
					<template v-for="(item, _index) of items" :key="_index">
						<tbody :class="classBodyItem!(item)" @click="openBody($event, item)">
							<tr class="components-paginate-table_tr">
								<slot :item="item" name="body" />
							</tr>

							<!--
								Every row carries a hidden twin. On a narrow screen the columns
								marked responsive are moved into it rather than dropped, so the
								table fits without the viewer losing a single value.
							-->
							<tr class="components-paginate-table_tr components-paginate-table_tr--sub">
								<td colspan="10000">
									<div class="components-paginate-table_subContainer">
										<table class="components-paginate-table_subDataContainer" />
									</div>
								</td>
							</tr>
						</tbody>
					</template>
				</template>

				<template v-else-if="!noEmptyMessage">
					<tbody>
						<tr class="components-paginate-table_tr components-paginate-table_tr--empty">
							<td colspan="10000">
								{{ emptyMessage || $t('components.paginate.table.empty') }}
							</td>
						</tr>
					</tbody>
				</template>
			</table>
		</div>

		<template
			v-if="page_sync !== null && limit_sync !== null && total !== null"
		>
			<PaginatePagination
				v-if="!noPaginate"
				v-model:limit="paginationLimit"
				v-model:page="paginationPage"
				:dense="dense"
				:label="$t('components.paginate.table.lines_per_page')"
				:total="total ?? 0"
			/>
		</template>
	</div>
</template>

<style lang="scss">
	.components-paginate-table {
		background: #FFF;
		.v-theme--dark & {
			background: #333;
		}

		.components-paginate-table_data {
			overflow: auto;
			padding-bottom: 8px;

			table {
				width: 100%;
				border-collapse: collapse;
			}
			tbody {
				tr.components-paginate-table_tr {
					transition: background-color 0.3s cubic-bezier(0.4, 0, 0.2, 1);
					border-top: 1px solid #DDD;
					.v-theme--dark & {
						border-top-color: #111;
					}

					.components-paginate-tableCell {
						transition: background-color 0.3s cubic-bezier(0.4, 0, 0.2, 1);
						background: #FFF;
						.v-theme--dark & {
							background: #333;
						}
					}

					&:hover {
						background-color: #EEE;
						.v-theme--dark & {
							background-color: #444;
						}
						.components-paginate-tableCell {
							background-color: #EEE;
							.v-theme--dark & {
								background-color: #444;
							}
						}
					}

					&.components-paginate-table_tr--sub {
						border-top: none;
					}

					&--empty {
						text-align: center;
						> td {
							padding: 10px;
						}
					}
				}
				&:hover {
					tr.components-paginate-table_tr {
						background-color: #EEE;
						.v-theme--dark & {
							background-color: #444;
						}
						.components-paginate-tableCell {
							background-color: #EEE;
							.v-theme--dark & {
								background-color: #444;
							}
						}
					}
				}
				tr.components-paginate-table_tr--sub {
					table {
						width: auto;
						th {
							text-align: left;
						}
					}
				}
			}

			&.components-paginate-table_data--responsive {
				tbody {

					tr.components-paginate-table_tr {
						cursor: pointer;

						&.components-paginate-table_tr--sub {
							> td {
								padding-bottom: 15px;
								position: relative;

								&:after {
									content: '⌄';
									position: absolute;
									left: 50%;
									bottom: 3px;
									font-size: 20px;
									display: block;
									border-radius: 100%;
									border: 1px solid #DDD;
									width: 20px;
									color: #000;
									height: 20px;
									line-height: 11px;
									text-align: center;
									background: #fff;
									z-index: 1;
									opacity: 0.35;
									transform: translateX(-100%);
									transition: transform 0.4s, background 0.3s cubic-bezier(0.4, 0, 0.2, 1);

									.v-theme--dark & {
										color: #FFF;
										border-color: #222;
										background: #121212;
									}
								}
							}
						}
					}

					.components-paginate-table_subContainer {
						max-height: 0;
						overflow: hidden;
						transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1);

						th {
							padding: 6px 0 6px 24px;
							display: block;
							color: rgba(0, 0, 0, 0.54);
							font-weight: 700;
							font-size: 13px;
							min-width: 130px;

							&:after {
								content: ':';
							}
							.v-theme--dark & {
								color: rgba(255, 255, 255, 0.54);
							}
						}
						td {
							font-size: 13px;
							padding: 6px 32px 6px 24px;
						}
					}

					&.components-paginate-table_responsive--open {

						tr.components-paginate-table_tr {
							&.components-paginate-table_tr--sub {
								> td {
									&:after {
										transform: translateX(-100%) rotate(-180deg);
									}
								}
							}
						}

						.components-paginate-table_subContainer {
							max-height: 1000px;
							border-top: 1px solid #DDD;
							.v-theme--dark & {
								border-color: #222;
							}
						}
					}
				}
			}
		}

		&_col--hidden {
			display: none !important;
		}

		&--sticky {
			.components-paginate-table_data {
				overflow-y: auto;
				max-height: calc(100vh - 300px);
				position: relative;
				@media (max-height: 500px) {
					max-height: calc(100vh - 100px);
				}

				&::-webkit-scrollbar-track {
					-webkit-box-shadow: inset 0 0 6px rgba(100,100,100,0.1);
					border-radius: 5px;
					background-color: #F5F5F5;

					.v-theme--dark & {
						background-color: #555;
					}
				}

				&::-webkit-scrollbar {
					width: 5px;
					height: 5px;
					background-color: transparent;
				}

				&::-webkit-scrollbar-thumb {
					border-radius: 10px;
					-webkit-box-shadow: inset 0 0 6px rgba(100,100,100,.1);
					background-color: rgba(0,0,0,0.1);

					.v-theme--dark & {
						background-color: rgba(255,255,255,0.3);
					}
				}

			}
			.components-paginate-tableHead {
				position: sticky;
				top: 0;
				z-index: 2;
				box-shadow: 0 1px 0 #DDD;
				background: #FFF;
				.v-theme--dark & {
					background: #222;
				}
			}
		}

		&--dense {
			.components-paginate-tableHead {
				.components-paginate-tableHead_container {
					padding: 1px 5px 1px 18px;
					height: 30px;
					line-height: 28px;
				}
				.v-icon {
					left: -3px !important;;
				}
				&:first-child {
					.components-paginate-tableHead_container {
						padding: 1px 18px 1px 5px;
						.v-icon {
							right: -2px !important;
							left: auto !important;;
						}
					}
				}
			}
			.components-paginate-tableCell {
				.components-paginate-tableCell_container{
					padding: 1px 5px 1px 18px;
					font-size: 12px;
				}
				&:first-child {
					.components-paginate-tableCell_container{
						padding: 1px 18px 1px 5px;
					}
				}
			}
		}

		&--responsive  .components-paginate-table_tr--sub > td {
			padding-bottom: 10px !important;
			&:after {
				width: 14px !important;
				height: 14px !important;
				line-height: 6px !important;
				font-size: 15px !important;
			}
		}

		.action {
			.v-btn--icon {
				height: 25px;
				width: 25px;
				min-width: 25px;
				.v-icon {
					font-size: 20px;
				}
			}
		}

	}
</style>
