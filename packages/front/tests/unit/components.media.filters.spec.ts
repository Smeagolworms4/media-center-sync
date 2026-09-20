import type { CatalogueEntry, Library, MediaGroup, MediaGroupSource, MediaService } from '@mcs/shared';
import {
	LibraryKind,
	MediaKind,
	MediaOrigin,
	MediaServiceMode,
	MediaServiceStatus,
	MediaServiceType,
	SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import GroupSources from '@/components/media/GroupSources.vue';
import MediaFilters from '@/components/media/MediaFilters.vue';
import MediaGroupRow from '@/components/media/MediaGroupRow.vue';
import CatalogueList from '@/components/peer/CatalogueList.vue';
import { mountWithApp, tooltipStub } from './helpers';

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
		id: 's1',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		shared: true,
		filesMounted: true,
		mode: MediaServiceMode.LOCAL,
		baseUrl: 'http://10.0.0.2:8096',
		status: MediaServiceStatus.ONLINE,
		version: null,
		remoteRoot: null,
		localRoot: null,
		authProvider: false,
		priority: 10,
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

function library (overrides: Partial<Library> = {}): Library {
	return {
		id: 'l1',
		serviceId: 's1',
		externalId: 'x',
		name: 'Shows',
		alias: null,
		position: 0,
		kind: LibraryKind.SHOWS,
		paths: [],
		localPath: null,
		writable: false,
		isDefaultTarget: false,
		itemCount: 0,
		lastScanAt: null,
		lastRefreshAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function source (overrides: Partial<MediaGroupSource> = {}): MediaGroupSource {
	return {
		itemId: 'i1',
		serviceId: 's1',
		serviceName: 'Living room',
		serviceType: MediaServiceType.JELLYFIN,
		peerId: null,
		peerName: null,
		quality: null,
		companions: null,
		bytes: 1024,
		versionId: null,
		edition: null,
		local: true,
		sync: SyncState.IN_SYNC,
		...overrides,
	};
}

function group (overrides: Partial<MediaGroup> = {}): MediaGroup {
	return {
		id: 'g1',
		kind: MediaKind.EPISODE,
		title: 'Pilot',
		normalizedTitle: 'pilot',
		year: 2019,
		seasonNumber: 1,
		episodeNumber: 1,
		externalIds: {},
		overview: null,
		artworkItemId: null,
		sync: SyncState.IN_SYNC,
		quality: null,
		sources: [source()],
		versions: [],
		childCount: 0,
		missingCount: 0,
		libraryId: 'l1',
		parentId: null,
		addedAt: null,
		...overrides,
	};
}

describe('components/media/MediaFilters', () => {
	const libraries = [library({ id: 'l1', serviceId: 's1' }), library({ id: 'l2', serviceId: 's2' })];

	it('offers only the libraries of the services being looked at', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, serviceIds: ['s1'] },
		});

		expect((wrapper.vm as any).libraryItems.map((one: Library) => one.id)).toEqual(['l1']);
	});

	/** Comparing two friends' shelves is the ordinary case, not the exotic one. */
	it('takes several services at once', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, serviceIds: ['s1', 's2'] },
		});

		expect((wrapper.vm as any).libraryItems).toHaveLength(2);
	});

	/**
	 * The four origins are the filter people actually reach for, and they are on the
	 * screen rather than behind a menu: telling a friend from a friend of a friend is
	 * the distinction the whole thing exists for.
	 */
	it('offers the four origins as something to read, not a select to open', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries },
			global: { stubs: tooltipStub },
		});

		for (const origin of Object.values(MediaOrigin)) {
			expect(wrapper.find(`[data-test="media-origin-${origin}"]`).exists()).toBe(true);
		}
		expect(wrapper.find('[data-test="media-origin-friend_of_friend"]').text())
			.toContain('Friends of friends');
	});

	it('reports the origins it was given, and nothing rather than an empty list', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [], libraries, origins: [MediaOrigin.FRIEND] },
			global: { stubs: tooltipStub },
		});

		(wrapper.vm as any).originModel = [MediaOrigin.FRIEND, MediaOrigin.FRIEND_OF_FRIEND];
		expect(wrapper.emitted('update:origins')?.at(-1))
			.toEqual([[MediaOrigin.FRIEND, MediaOrigin.FRIEND_OF_FRIEND]]);

		(wrapper.vm as any).originModel = [];
		expect(wrapper.emitted('update:origins')?.at(-1)).toEqual([null]);
	});

	it('offers every library when no service is chosen', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries },
		});

		expect((wrapper.vm as any).libraryItems).toHaveLength(2);
	});

	it('drops the library filter when the services change, or it would filter everything out', async () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, serviceIds: ['s2'], libraryId: 'l1' },
		});

		(wrapper.vm as any).onServicesChange();

		expect(wrapper.emitted('update:libraryId')?.at(-1)).toEqual([null]);
	});

	/** A library still offered by the narrowed list is a filter worth keeping. */
	it('keeps a library the chosen services still offer', async () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, serviceIds: ['s1'], libraryId: 'l1' },
		});

		(wrapper.vm as any).onServicesChange();

		expect(wrapper.emitted('update:libraryId')).toBeUndefined();
	});

	/**
	 * On the overview every band is already the latest additions of its category, and
	 * a sort control there would offer an order the screen ignores.
	 */
	it('says the order is fixed instead of offering one the wall ignores', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [], libraries, sortable: false },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-sort"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="media-sort-fixed"]').exists()).toBe(true);
	});

	it('clears every filter at once, and says so only while there is one', async () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, search: 'expanse', states: [SyncState.MISSING] },
		});

		expect(wrapper.find('[data-test="media-clear"]').exists()).toBe(true);
		(wrapper.vm as any).clear();

		expect(wrapper.emitted('update:search')?.at(-1)).toEqual([null]);
		expect(wrapper.emitted('update:states')?.at(-1)).toEqual([null]);
	});

	it('flips the sort direction rather than offering two controls', () => {
		const { wrapper } = mountWithApp(MediaFilters, { props: { direction: 'asc' } });

		(wrapper.vm as any).toggleDirection();

		expect(wrapper.emitted('update:direction')?.at(-1)).toEqual(['desc']);
	});
});

describe('components/media/GroupSources', () => {
	it('lists the copies in the order the gateway would consult them', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: {
				sources: [
					source({ itemId: 'i-slow', serviceId: 'slow', serviceName: 'Slow' }),
					source({ itemId: 'i-fast', serviceId: 'fast', serviceName: 'Fast' }),
				],
				services: [
					service({ id: 'slow', name: 'Slow', priority: 50 }),
					service({ id: 'fast', name: 'Fast', priority: 1 }),
				],
			},
			global: { stubs: tooltipStub },
		});

		const rows = wrapper.findAll('[data-test="group-source"]');
		expect(rows.map(row => row.find('.group-sources_name').text())).toEqual(['Fast', 'Slow']);
	});

	/** An empty choice is a decision — follow the configured priority — and says so. */
	it('defaults to the configured priority and names what that means', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: {
				sources: [source({ serviceId: 'fast', serviceName: 'Fast' })],
				services: [service({ id: 'fast', name: 'Fast', priority: 1 })],
			},
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="source-default"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Follow the configured priority');
		expect(wrapper.text()).toContain('Fast');
	});

	it('marks our own copy, so it is not read as one more stranger', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: {
				sources: [
					source({ itemId: 'i-mine', local: true }),
					source({ itemId: 'i-bob', serviceId: 's2', serviceName: 'Bob’s Plex', local: false, peerId: 'p1' }),
				],
				peerNames: { p1: 'Bob' },
			},
			global: { stubs: tooltipStub },
		});

		const rows = wrapper.findAll('[data-test="group-source"]');
		expect(rows.map(row => row.attributes('data-local'))).toEqual(['true', 'false']);
		expect(wrapper.find('[data-test="group-source-ours"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('through Bob');
	});

	it('says nothing holds the item rather than showing an empty list', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: { sources: [] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('No service holds this item');
	});

	/**
	 * Several versions, chosen together.
	 *
	 * The picker used to be a radio group over servers, which could express exactly one
	 * answer to a question that has several: a theatrical cut and an extended one are
	 * two things to hold, and being able to tick only one of them is the bug.
	 */
	describe('versions', () => {
		const versioned = (): Record<string, unknown> => ({
			sources: [
				source({
					itemId: 'i-ours',
					serviceId: 'ours',
					serviceName: 'Living room',
					versionId: 'q1-theatrical',
					local: true,
				}),
				source({
					itemId: 'i-theirs',
					serviceId: 'theirs',
					serviceName: 'Cabin',
					versionId: 'q1-theatrical',
					local: false,
				}),
				source({
					itemId: 'i-extended',
					serviceId: 'theirs',
					serviceName: 'Cabin',
					versionId: 'q1-extended',
					edition: 'Extended Cut',
					local: false,
				}),
			],
			versions: [
				{
					versionId: 'q1-theatrical',
					edition: null,
					quality: null,
					bytes: 1024,
					heldLocally: true,
					sourceItemIds: ['i-ours', 'i-theirs'],
				},
				{
					versionId: 'q1-extended',
					edition: 'Extended Cut',
					quality: null,
					bytes: 2048,
					heldLocally: false,
					sourceItemIds: ['i-extended'],
				},
			],
			services: [service({ id: 'ours', priority: 1 }), service({ id: 'theirs', priority: 2 })],
		});

		it('lists one row per version rather than one per server', () => {
			// Two servers holding the same file is one thing to pull, not two.
			const { wrapper } = mountWithApp(GroupSources, {
				props: versioned(),
				global: { stubs: tooltipStub },
			});

			const rows = wrapper.findAll('[data-test="group-source"]');

			expect(rows).toHaveLength(2);
			expect(rows.map(row => row.attributes('data-held'))).toEqual(['true', 'false']);
			expect(wrapper.find('[data-test="group-source-edition"]').text()).toBe('Extended Cut');
		});

		it('lets several be chosen at once, named by the copy each would come from', async () => {
			const { wrapper } = mountWithApp(GroupSources, {
				props: { ...versioned(), modelValue: [] },
				global: { stubs: tooltipStub },
			});

			const boxes = wrapper.findAll('[data-test="group-source"] input');

			await boxes[0].setValue(true);
			await boxes[1].setValue(true);

			// The copy, never the service: one server holds both cuts here, so a set of
			// service identifiers could not say which of them was asked for.
			expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([['i-theirs', 'i-extended']]);
		});

		it('says what the selection will cost before anything starts', async () => {
			const { wrapper } = mountWithApp(GroupSources, {
				props: { ...versioned(), modelValue: ['i-theirs', 'i-extended'] },
				global: { stubs: tooltipStub },
			});

			expect(wrapper.find('[data-test="source-selection"]').text()).toContain('2 transfers');
			// Holding one of the two is an ordinary state, said as a count and not as a
			// warning: this is not a half-failed sync.
			expect(wrapper.find('[data-test="source-selection"]').text()).toContain('1 of 2 versions here');
		});

		it('offers nothing to pull for a version only we hold', () => {
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					sources: [source({ itemId: 'i-ours', versionId: 'q1-ours', local: true })],
					versions: [{
						versionId: 'q1-ours',
						edition: null,
						quality: null,
						bytes: 1024,
						heldLocally: true,
						sourceItemIds: ['i-ours'],
					}],
				},
				global: { stubs: tooltipStub },
			});

			// Listed and marked rather than hidden: "you already have this one" is an
			// answer, and an empty list is not.
			expect(wrapper.findAll('[data-test="group-source"]')).toHaveLength(1);
			expect(wrapper.find('[data-test="group-source-nothing"]').exists()).toBe(true);
			expect(wrapper.find('[data-test="group-source"] input').attributes('disabled')).toBeDefined();
		});

		it('falls back to one row per copy while nothing has been fingerprinted', () => {
			// No version can be told from another, so the list says what it knows —
			// which is where it stood before versions existed.
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					sources: [
						source({ itemId: 'i-a', serviceId: 'a', serviceName: 'A', local: false }),
						source({ itemId: 'i-b', serviceId: 'b', serviceName: 'B', local: false }),
					],
					versions: [],
				},
				global: { stubs: tooltipStub },
			});

			expect(wrapper.findAll('[data-test="group-source"]')).toHaveLength(2);
		});
	});
});

describe('components/media/MediaGroupRow', () => {
	it('dims a missing row and counts what is missing under it', () => {
		const { wrapper } = mountWithApp(MediaGroupRow, {
			props: { group: group({ sync: SyncState.MISSING, missingCount: 3 }) },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-row"]').classes()).toContain('media-row--missing');
		expect(wrapper.text()).toContain('3 missing');
	});

	it('carries the state, the quality and the sources the whole interface reads', () => {
		const { wrapper } = mountWithApp(MediaGroupRow, {
			props: { group: group() },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-row"]').attributes('data-state')).toBe(SyncState.IN_SYNC);
		expect(wrapper.find('[data-test="sync-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="quality-chip"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="source-marks"]').exists()).toBe(true);
	});

	it('reports a selection, so a page can offer to sync what was picked', async () => {
		const { wrapper } = mountWithApp(MediaGroupRow, {
			props: { group: group(), selectable: true },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="media-select"] input').setValue(true);

		expect(wrapper.emitted('update:selected')?.[0]).toEqual([true]);
	});
});

describe('components/peer/CatalogueList', () => {
	function entry (overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
		return {
			externalId: 'x1',
			kind: MediaKind.MOVIE,
			title: 'Arrival',
			year: 2016,
			seasonNumber: null,
			episodeNumber: null,
			parentExternalId: null,
			externalIds: {},
			contentId: 'v1:cid',
			size: 900,
			quality: 'x265 · 1080p',
			...overrides,
		};
	}

	it('offers a pull for what the peer actually serves', async () => {
		const { wrapper } = mountWithApp(CatalogueList, {
			props: { entries: [entry()] },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="catalogue-pull"]').trigger('click');

		expect(wrapper.emitted('pull')?.[0]?.[0]).toMatchObject({ externalId: 'x1' });
	});

	/** No content identifier means catalogue only; a pull button would only fail. */
	it('offers no pull for an entry shared as a catalogue only', () => {
		const { wrapper } = mountWithApp(CatalogueList, {
			props: { entries: [entry({ contentId: null })] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="catalogue-pull"]').exists()).toBe(false);
		expect(wrapper.find('[data-shared="false"]').exists()).toBe(true);
	});

	it('shows the empty state rather than an empty table', () => {
		const { wrapper } = mountWithApp(CatalogueList, { props: { entries: [] } });

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
	});
});
