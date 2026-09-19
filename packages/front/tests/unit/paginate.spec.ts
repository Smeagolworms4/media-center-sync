import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import Confirm from '@/components/Confirm.vue';
import Indication from '@/components/Indication.vue';
import Notify from '@/components/Notify.vue';
import Pagination from '@/components/paginate/Pagination.vue';
import { AscDesc } from '@/components/paginate/sort';
import Table from '@/components/paginate/Table.vue';
import TableCell from '@/components/paginate/TableCell.vue';
import TableHead from '@/components/paginate/TableHead.vue';
import Window from '@/components/Window.vue';
import { useNotifierStore } from '@/stores/notifier';
import { dialogStub, mountWithApp, tooltipStub } from './helpers';

const items = [{ id: 1, title: 'Arrival' }, { id: 2, title: 'Dune' }];

const Host = defineComponent({
	props: {
		items: { type: Array, default: () => items },
		total: { type: Number, default: 2 },
	},
	data: () => ({ page: 0, limit: 10, order: null as string | null, direction: AscDesc.ASC }),
	render () {
		return h(Table, {
			'items': this.items,
			'total': this.total,
			'page': this.page,
			'onUpdate:page': (v: number | null) => {
				this.page = v ?? 0;
			},
			'limit': this.limit,
			'onUpdate:limit': (v: number | null) => {
				this.limit = v ?? 10;
			},
			'order': this.order,
			'onUpdate:order': (v: string | null) => {
				this.order = v;
			},
			'direction': this.direction,
			'onUpdate:direction': (v: AscDesc) => {
				this.direction = v;
			},
		}, {
			head: () => h(TableHead, { sortBy: 'title' }, { default: () => 'Title' }),
			body: ({ item }: any) => h(TableCell, null, { default: () => item.title }),
		});
	},
});

describe('paginate/Table', () => {
	it('renders one body per item', () => {
		const { wrapper } = mountWithApp(Host);

		expect(wrapper.findAll('tbody')).toHaveLength(2);
		expect(wrapper.text()).toContain('Arrival');
		expect(wrapper.text()).toContain('Dune');
	});

	it('says so when there is nothing to show', () => {
		const { wrapper } = mountWithApp(Host, { props: { items: [], total: 0 } });

		expect(wrapper.find('.components-paginate-table_tr--empty').text()).toBe('No result');
	});

	it('can be told to stay quiet when empty', () => {
		const { wrapper } = mountWithApp(Table, { props: { items: [], noEmptyMessage: true } });

		expect(wrapper.find('.components-paginate-table_tr--empty').exists()).toBe(false);
	});

	it('sorts on the first click and flips direction on the second', async () => {
		const { wrapper } = mountWithApp<any>(Host);
		const head = wrapper.find('th.components-paginate-tableHead');

		await head.trigger('click');
		expect(wrapper.vm.order).toBe('title');
		expect(wrapper.vm.direction).toBe(AscDesc.ASC);

		await head.trigger('click');
		expect(wrapper.vm.direction).toBe(AscDesc.DESC);
	});

	it('shows the pagination only when it has the numbers for it', () => {
		const withNumbers = mountWithApp(Host);
		expect(withNumbers.wrapper.find('.components-paginate-pagination').exists()).toBe(true);

		const without = mountWithApp(Table, { props: { items } });
		expect(without.wrapper.find('.components-paginate-pagination').exists()).toBe(false);
	});
});

describe('paginate/Pagination', () => {
	it('moves through the pages and stops at both ends', async () => {
		const { wrapper } = mountWithApp<any>(Pagination, {
			props: { page: 0, limit: 10, total: 25 },
		});

		const buttons = wrapper.findAll('.paginate-pagination-action button');
		expect(buttons[0].attributes('disabled')).toBeDefined();
		expect(buttons[1].attributes('disabled')).toBeDefined();

		await buttons[2].trigger('click');
		expect(wrapper.emitted('update:page')?.[0]).toEqual([1]);

		await buttons[3].trigger('click');
		expect(wrapper.emitted('update:page')?.[1]).toEqual([2]);
	});

	it('shows the window of rows on display', () => {
		const { wrapper } = mountWithApp(Pagination, { props: { page: 1, limit: 10, total: 25 } });

		expect(wrapper.text()).toContain('11-20 / 25');
	});
});

describe('Window and Confirm', () => {
	it('Window shows its title and closes from the model', async () => {
		const { wrapper } = mountWithApp(Window, {
			props: { modelValue: true, title: 'Remove this service?' },
			slots: { default: 'It will stop being indexed.' },
			global: { stubs: dialogStub },
		});
		await nextTick();

		expect(wrapper.text()).toContain('Remove this service?');
		expect(wrapper.text()).toContain('It will stop being indexed.');
	});

	it('Confirm emits confirm without closing, and closes on cancel', async () => {
		const { wrapper } = mountWithApp(Confirm, {
			props: { modelValue: true, title: 'Delete', text: 'Are you sure?' },
			global: { stubs: dialogStub },
		});
		await nextTick();

		const buttons = wrapper.findAll('.v-card-actions button');
		await buttons[1].trigger('click');
		expect(wrapper.emitted('confirm')).toHaveLength(1);
		expect(wrapper.emitted('update:modelValue')).toBeUndefined();

		await buttons[0].trigger('click');
		expect(wrapper.emitted('cancel')).toHaveLength(1);
		expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
	});
});

describe('Indication and Notify', () => {
	it('Indication renders the explanation behind its key', () => {
		const { wrapper } = mountWithApp(Indication, {
			props: { name: 'match_threshold' },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('proposed rather than applied');
	});

	it('Notify renders whatever the store is holding', async () => {
		const { wrapper, pinia } = mountWithApp(Notify);
		useNotifierStore(pinia).addNotify({ type: 'error', message: 'Service unreachable' });
		await nextTick();

		expect(wrapper.text()).toContain('Service unreachable');
		expect(wrapper.find('.components-notify_card--error').exists()).toBe(true);
	});
});
