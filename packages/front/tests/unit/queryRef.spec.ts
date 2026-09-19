import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { queriesRef, queryRef, queryTypes, storageRef } from '@/libs/vue3-query-ref';
import { mountWithApp } from './helpers';

describe('queryTypes', () => {
	it('string', () => {
		const type = queryTypes.string({ defaultValue: 'x' });
		expect(type.parse('a')).toBe('a');
		expect(type.parse(['a', 'b'])).toBe('a');
		expect(type.serialize('a')).toBe('a');
	});

	it('integer', () => {
		const type = queryTypes.integer({ defaultValue: 1 });
		expect(type.parse('42')).toBe(42);
		expect(type.parse('nope')).toBe(1);
		expect(type.serialize(42.7)).toBe('42');
	});

	it('float', () => {
		const type = queryTypes.float({ fixed: 2 });
		expect(type.parse('4.25')).toBe(4.25);
		expect(type.parse('nope')).toBeNull();
		expect(type.serialize(4.257)).toBe('4.26');
	});

	it('boolean, dropping a false flag from the URL', () => {
		const type = queryTypes.boolean();
		expect(type.parse('1')).toBe(true);
		expect(type.parse('false')).toBe(false);
		expect(type.serialize(true)).toBe('1');
		expect(type.serialize(false)).toBeNull();
		expect(queryTypes.boolean({ falseRemove: false, serializeNumber: false }).serialize(false)).toBe('false');
	});

	it('timestamp and ISO dates', () => {
		const time = queryTypes.timestamp();
		const date = new Date('2026-09-19T12:00:00.000Z');
		expect(time.parse(String(date.getTime()))).toEqual(date);
		expect(time.serialize(date)).toBe(String(date.getTime()));

		const iso = queryTypes.isoDateTime();
		expect(iso.parse('2026-09-19T12:00:00.000Z')).toEqual(date);
		expect(iso.parse('nope')).toBeNull();

		const day = queryTypes.isoDate();
		expect(day.serialize(date)).toBe('2026-09-19');
		expect(day.parse('nope')).toBeNull();
	});

	it('stringEnum keeps only the values it was told about', () => {
		const type = queryTypes.stringEnum({ values: ['asc', 'desc'], defaultValue: 'asc' });
		expect(type.parse('desc')).toBe('desc');
		expect(type.parse('sideways')).toBe('asc');
	});

	it('json survives a hand-edited URL', () => {
		const type = queryTypes.json<{ a: number }>();
		expect(type.parse('{"a":1}')).toEqual({ a: 1 });
		expect(type.parse('{oops')).toBeNull();
		expect(type.serialize({ a: 1 })).toBe('{"a":1}');
	});

	it('arrays, repeated and delimited', () => {
		const repeated = queryTypes.array<string>();
		expect(repeated.parse(['a', 'b'])).toEqual(['a', 'b']);
		expect(repeated.parse('a')).toEqual(['a']);

		const delimited = queryTypes.delimitedArray<number>({ itemParse: Number });
		expect(delimited.parse('1,2,3')).toEqual([1, 2, 3]);
		expect(delimited.serialize([1, 2])).toBe('1,2');
	});
});

describe('storageRef', () => {
	it('reads what a previous session stored', async () => {
		const first = storageRef<{ page: number }>('table', queryTypes.json<{ page: number }>());
		first.value = { page: 3 };
		await nextTick();

		const second = storageRef<{ page: number }>('table', queryTypes.json<{ page: number }>());
		expect(second.value).toEqual({ page: 3 });
	});

	it('falls back to its default when there is nothing stored', () => {
		const value = storageRef<string>('never-written', queryTypes.string({ defaultValue: 'all' }));
		expect(value.value).toBe('all');
	});

	it('can live in the session rather than across restarts', async () => {
		const value = storageRef<string>('tab', { ...queryTypes.string(), storage: 'session' });
		value.value = 'peers';
		await nextTick();

		expect(window.sessionStorage.getItem('tab')).toBeTruthy();
		expect(window.localStorage.getItem('tab')).toBeNull();
	});
});

/** The URL is written through `router.replace`, which settles a tick later. */
async function flush (): Promise<void> {
	await nextTick();
	await new Promise(resolve => {
		setTimeout(resolve, 0);
	});
	await nextTick();
}

describe('queryRef', () => {
	const Harness = defineComponent({
		setup () {
			return {
				search: queryRef<string>('search'),
				filters: queriesRef({
					page: queryTypes.integer({ defaultValue: 0 }),
					state: queryTypes.string(),
				}),
			};
		},
		render: () => null,
	});

	it('writes the value into the address bar and reads it back', async () => {
		const { wrapper, router } = mountWithApp<any>(Harness);
		// A memory router has no location at all until it navigates once.
		await router.push('/');

		wrapper.vm.search = 'blade runner';
		await flush();

		expect(router.currentRoute.value.query.search).toBe('blade runner');

		wrapper.vm.search = null;
		await flush();
		expect(router.currentRoute.value.query.search).toBeUndefined();
	});

	it('exposes several parameters as one object', async () => {
		const { wrapper, router } = mountWithApp<any>(Harness);
		await router.push('/');

		expect(wrapper.vm.filters.page).toBe(0);

		wrapper.vm.filters = { page: 2, state: 'missing' };
		await flush();

		expect(router.currentRoute.value.query.page).toBe('2');
		expect(router.currentRoute.value.query.state).toBe('missing');
		expect(wrapper.vm.filters.page).toBe(2);
	});
});
