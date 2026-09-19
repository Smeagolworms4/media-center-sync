import type { CatalogueEntry, Library, MediaItem, MediaService } from '@mcs/shared';
import {
	LibraryKind,
	MediaKind,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import MediaFilters from '@/components/media/MediaFilters.vue';
import MediaRow from '@/components/media/MediaRow.vue';
import SourcePicker from '@/components/media/SourcePicker.vue';
import CatalogueList from '@/components/peer/CatalogueList.vue';
import { mountWithApp, tooltipStub } from './helpers';

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
		id: 's1',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		scope: MediaServiceScope.LOCAL,
		baseUrl: 'http://10.0.0.2:8096',
		status: MediaServiceStatus.ONLINE,
		version: null,
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

function item (overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 'm1',
		serviceId: 's1',
		libraryId: 'l1',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'Pilot',
		normalizedTitle: 'pilot',
		year: 2019,
		seasonNumber: 1,
		episodeNumber: 1,
		externalIds: {},
		overview: null,
		artworkUrl: null,
		file: null,
		quality: null,
		addedAt: null,
		sync: SyncState.IN_SYNC,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('components/media/MediaFilters', () => {
	const libraries = [library({ id: 'l1', serviceId: 's1' }), library({ id: 'l2', serviceId: 's2' })];

	it('offers only the libraries of the service being looked at', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, serviceId: 's1' },
		});

		expect((wrapper.vm as any).libraryItems.map((one: Library) => one.id)).toEqual(['l1']);
	});

	it('offers every library when no service is chosen', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries },
		});

		expect((wrapper.vm as any).libraryItems).toHaveLength(2);
	});

	it('drops the library filter when the service changes, or it would filter everything out', async () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, serviceId: 's1', libraryId: 'l1' },
		});

		(wrapper.vm as any).onServiceChange();

		expect(wrapper.emitted('update:libraryId')?.at(-1)).toEqual([null]);
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

describe('components/media/SourcePicker', () => {
	it('lists the sources in the order the gateway would consult them', () => {
		const { wrapper } = mountWithApp(SourcePicker, {
			props: {
				services: [
					service({ id: 'slow', name: 'Slow', priority: 50 }),
					service({ id: 'fast', name: 'Fast', priority: 1 }),
				],
			},
		});

		expect((wrapper.vm as any).ordered.map((one: MediaService) => one.id)).toEqual(['fast', 'slow']);
	});

	/** An empty choice is a decision — follow the configured priority — and says so. */
	it('defaults to the configured priority and names what that means', () => {
		const { wrapper } = mountWithApp(SourcePicker, {
			props: { services: [service({ id: 'fast', name: 'Fast', priority: 1 })] },
		});

		expect(wrapper.find('[data-test="source-default"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Follow the configured priority');
		expect(wrapper.text()).toContain('Fast');
	});

	it('names the friend a source is reached through', () => {
		const { wrapper } = mountWithApp(SourcePicker, {
			props: {
				services: [service({ id: 'remote', name: 'Bob’s Plex', peerId: 'p1' })],
				peerNames: { p1: 'Bob' },
			},
		});

		expect(wrapper.text()).toContain('through Bob');
	});

	it('says nothing else holds the item rather than showing an empty list', () => {
		const { wrapper } = mountWithApp(SourcePicker, { props: { services: [] } });

		expect(wrapper.text()).toContain('No other service holds this item');
	});
});

describe('components/media/MediaRow', () => {
	it('greys a missing row and names who holds it', () => {
		const { wrapper } = mountWithApp(MediaRow, {
			props: { item: item({ sync: SyncState.MISSING }), holders: ['Bob’s Jellyfin'] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-row"]').classes()).toContain('media-row--missing');
		expect(wrapper.text()).toContain('held by Bob’s Jellyfin');
	});

	it('carries the state and the quality the whole interface reads', () => {
		const { wrapper } = mountWithApp(MediaRow, {
			props: { item: item() },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-row"]').attributes('data-state')).toBe(SyncState.IN_SYNC);
		expect(wrapper.find('[data-test="sync-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="quality-chip"]').exists()).toBe(true);
	});

	it('reports a selection, so a page can offer to sync what was picked', async () => {
		const { wrapper } = mountWithApp(MediaRow, {
			props: { item: item(), selectable: true },
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
