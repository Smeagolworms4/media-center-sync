import type { Library, LibraryCheck, MediaCategory, MediaService } from '@mcs/shared';
import {
	LibraryKind,
	MediaServiceMode,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import CategoryTargetsTable from '@/components/settings/CategoryTargetsTable.vue';
import DestinationLibraryField from '@/components/settings/DestinationLibraryField.vue';
import { useDestinationLibraries } from '@/composables/useDestinationLibraries';
import { useLibrariesStore } from '@/stores/libraries';
import { useServicesStore } from '@/stores/services';
import { createStoreContext, mountWithApp } from './helpers';

/**
 * The most important screen in the product, taken apart.
 *
 * A file that lands somewhere the media server never scans is a transfer that
 * succeeded and produced nothing, and nothing anywhere reports an error. Every
 * assertion here is about the screen saying where something goes — including when
 * the answer is "one step further down the rule", which is a real answer and must
 * never render as an empty cell.
 */
function library (overrides: Partial<Library> = {}): Library {
	return {
		id: 'l1',
		serviceId: 's1',
		externalId: 'x',
		name: 'Movies',
		alias: null,
		position: 0,
		kind: LibraryKind.MOVIES,
		paths: ['/data/movies'],
		localPath: '/media/movies',
		writable: true,
		isDefaultTarget: false,
		itemCount: 12,
		lastScanAt: null,
		lastRefreshAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
		id: 's1',
		name: 'Jellyfin (mine)',
		type: MediaServiceType.JELLYFIN,
		scope: MediaServiceScope.LOCAL,
		baseUrl: 'https://jellyfin.local',
		status: MediaServiceStatus.ONLINE,
		version: null,
		mode: MediaServiceMode.LOCAL,
		remoteRoot: null,
		localRoot: null,
		authProvider: false,
		priority: 0,
		peerId: null,
		lastProbeAt: null,
		lastScanAt: null,
		libraryCount: 1,
		itemCount: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function category (overrides: Partial<MediaCategory> = {}): MediaCategory {
	return {
		key: 'movies',
		name: 'Movies',
		kind: LibraryKind.MOVIES,
		position: 0,
		libraryIds: ['l1'],
		serviceIds: ['s1'],
		itemCount: 12,
		local: true,
		...overrides,
	};
}

const DESTINATIONS = [
	{ id: 'l1', name: 'Movies', serviceName: 'Jellyfin (mine)', path: '/media/movies' },
	{ id: 'l2', name: 'Shows', serviceName: 'Plex (mine)', path: '/media/shows' },
];

const CATEGORIES = [
	category(),
	category({ key: 'shows', name: 'Shows', kind: LibraryKind.SHOWS, libraryIds: ['l2', 'l3'] }),
];

describe('components/settings/CategoryTargetsTable', () => {
	const mountTable = (props: Record<string, unknown> = {}) => mountWithApp(CategoryTargetsTable, {
		props: {
			categories: CATEGORIES,
			destinations: DESTINATIONS,
			fallback: 'Movies',
			modelValue: {},
			...props,
		},
	});

	it('gives every category a row, configured or not', () => {
		// A category missing from a table of destinations reads as one the gateway has
		// forgotten about, so the rows are the categories and nothing filters them.
		const { wrapper } = mountTable();

		expect(wrapper.findAll('[data-test="category-target-row"]')).toHaveLength(2);
		expect(wrapper.find('[data-category="movies"]').exists()).toBe(true);
		expect(wrapper.find('[data-category="shows"]').exists()).toBe(true);
	});

	it('names the library a configured category sends its media to', () => {
		// Pointed deliberately at the library of the other category, so that the name on
		// screen can only have come from the answer and not from the row's own heading.
		const { wrapper } = mountTable({ modelValue: { movies: 'l2' } });
		const row = wrapper.find('[data-category="movies"]');

		expect(row.attributes('data-configured')).toBe('true');
		expect(row.find('.v-select__selection').text()).toBe('Shows');
		// And it stops offering the fallback, because it no longer falls back.
		expect(row.find('[data-test="category-target-fallback"]').exists()).toBe(false);
	});

	it('reads an unconfigured row as falling back, never as nothing', () => {
		// A blank cell in a table of destinations reads as broken. The row has an
		// answer — the next step of the rule — and says which.
		const { wrapper } = mountTable({ fallback: 'Movies' });
		const row = wrapper.find('[data-category="shows"]');

		expect(row.attributes('data-configured')).toBe('false');
		expect(row.find('[data-test="category-target-fallback"]').text()).toContain('Movies');
	});

	it('offers only the libraries handed to it as destinations', () => {
		const { wrapper } = mountTable();
		const items = wrapper.findAllComponents({ name: 'VSelect' })[0].props('items') as { value: string }[];

		expect(items.map(one => one.value)).toEqual(['l1', 'l2']);
	});

	it('says why a library of the category cannot be offered, rather than dropping it', () => {
		// The name simply going missing sends somebody hunting for a fault in the wrong
		// place: the library is there, it just cannot be written into.
		const { wrapper } = mountTable({
			rejected: [{ id: 'l3', name: 'Séries', serviceName: 'Lab (a friend)', reason: 'not_ours' }],
		});

		const rejected = wrapper.find('[data-category="shows"] [data-test="category-target-rejected"]');
		expect(rejected.text()).toContain('Séries');
		expect(rejected.text()).toContain('Lab (a friend)');
		// And it belongs to the category holding that library, not to every row.
		expect(wrapper.find('[data-category="movies"] [data-test="category-target-rejected"]').exists())
			.toBe(false);
	});

	it('puts a chosen library into the map under its category key', async () => {
		const { wrapper } = mountTable({ modelValue: { movies: 'l1' } });

		wrapper.findAllComponents({ name: 'VSelect' })[1].vm.$emit('update:modelValue', 'l2');
		await nextTick();

		// Replaced rather than mutated, and the categories already answered are kept.
		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ movies: 'l1', shows: 'l2' });
	});

	it('drops the key when a row is cleared, rather than storing an empty answer', async () => {
		const { wrapper } = mountTable({ modelValue: { movies: 'l1', shows: 'l2' } });

		wrapper.findAllComponents({ name: 'VSelect' })[0].vm.$emit('update:modelValue', null);
		await nextTick();

		expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ shows: 'l2' });
	});

	it('says on the row what choosing a destination will do, before it is chosen', () => {
		// The interface fault this fixes: "goes to" reads as "is filed under", somebody
		// mapped a category expecting one category in the library view, and got two with
		// no hint anywhere that the two things were separate. Said on the row rather
		// than in a tooltip, because a tooltip is read after the choice or never.
		const { wrapper } = mountTable();
		const note = wrapper.find('[data-category="movies"] [data-test="category-target-merges"]');

		expect(note.exists()).toBe(true);
		expect(note.text()).toContain('one category');
	});

	it('keeps saying it once the row is answered, since the consequence stands', () => {
		const { wrapper } = mountTable({ modelValue: { movies: 'l2' } });

		expect(wrapper.find('[data-category="movies"] [data-test="category-target-merges"]').exists())
			.toBe(true);
	});

	it('promises no merge for a category that is nobody’s but a friend’s', () => {
		// The gateway will not rename somebody else's library, so the row must not say
		// it will: a promise the API deliberately refuses is worse than no promise.
		const { wrapper } = mountTable({
			categories: [category({ key: 'series', name: 'Séries', local: false })],
		});

		const note = wrapper.find('[data-category="series"] [data-test="category-target-merges"]');

		expect(note.text()).toContain('somebody else');
		expect(note.text()).not.toContain('one category');
	});

	it('says there is no category rather than showing an empty table', () => {
		const { wrapper } = mountTable({ categories: [] });

		expect(wrapper.find('[data-test="category-targets-empty"]').exists()).toBe(true);
	});
});

describe('components/settings/DestinationLibraryField', () => {
	it('offers the destinations it was given, with the service each one is on', () => {
		const { wrapper } = mountWithApp(DestinationLibraryField, {
			props: { destinations: DESTINATIONS, modelValue: null },
		});

		const items = wrapper.findComponent({ name: 'VSelect' }).props('items') as { subtitle: string }[];

		expect(items).toHaveLength(2);
		expect(items[0].subtitle).toContain('Jellyfin (mine)');
	});

	it('says why the menu is empty rather than showing an empty menu', () => {
		// An empty list with no explanation reads as a broken screen; it is in fact the
		// gateway saying that nothing here can receive a file at all.
		const { wrapper } = mountWithApp(DestinationLibraryField, {
			props: { destinations: [], modelValue: null },
		});

		expect(wrapper.find('[data-test="settings-destination-none"]').exists()).toBe(true);
	});
});

describe('composables/useDestinationLibraries', () => {
	const seed = (libraries: Library[], services: MediaService[], checks: LibraryCheck[] = []) => {
		const context = createStoreContext();
		useLibrariesStore(context.pinia).libraries = libraries;
		useLibrariesStore(context.pinia).checks = checks;
		useServicesStore(context.pinia).services = services;
		return useDestinationLibraries();
	};

	it('never offers a library the gateway cannot write into', () => {
		// Offering one accepts transfers the media server will never see, and nothing
		// anywhere reports an error — which is the failure this screen exists to stop.
		const { destinations, rejected } = seed(
			[library(), library({ id: 'l2', name: 'Archive', writable: false, localPath: null })],
			[service()],
		);

		expect(destinations.value.map(one => one.id)).toEqual(['l1']);
		expect(rejected.value).toEqual([
			{ id: 'l2', name: 'Archive', serviceName: 'Jellyfin (mine)', reason: 'not_writable' },
		]);
	});

	it('never offers a library on somebody else’s server, and says that is why', () => {
		const { destinations, rejected } = seed(
			[library(), library({ id: 'l2', name: 'Séries', serviceId: 's2' })],
			[
				service(),
				service({
					id: 's2',
					name: 'Lab (a friend)',
					scope: MediaServiceScope.REMOTE,
					mode: MediaServiceMode.PEER,
					type: MediaServiceType.PEER,
				}),
			],
		);

		expect(destinations.value.map(one => one.id)).toEqual(['l1']);
		expect(rejected.value[0]).toMatchObject({ id: 'l2', reason: 'not_ours' });
	});

	it('believes a fresh check over the flag the last scan stored', () => {
		// A disk unmounted since the scan is exactly the case worth catching: the
		// library still claims to be writable and is not.
		const { destinations } = seed(
			[library()],
			[service()],
			[{
				libraryId: 'l1',
				name: 'Movies',
				localPath: '/media/movies',
				derived: false,
				exists: true,
				readable: true,
				writable: false,
				freeBytes: null,
				error: null,
			}],
		);

		expect(destinations.value).toEqual([]);
	});
});
