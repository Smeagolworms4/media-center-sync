import type { Library, LibraryCheck, MediaService } from '@mcs/shared';
import {
	LibraryKind,
	MediaServiceMode,
	MediaServiceStatus,
	MediaServiceType,
	PathMatch,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
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
		shared: true,
		filesMounted: true,
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

const DESTINATIONS = [
	{ id: 'l1', name: 'Movies', serviceName: 'Jellyfin (mine)', path: '/media/movies' },
	{ id: 'l2', name: 'Shows', serviceName: 'Plex (mine)', path: '/media/shows' },
];

/*
 * The per-category destination table used to live here.
 *
 * It is gone: a local category now owns its destination beside its keywords, in
 * `CategoryMapping`, because one category in two places on one pane is the same
 * sentence said twice — and the table repeated the merge explanation under every one
 * of its selects, three identical paragraphs in one viewport. Every claim it made is
 * asserted against the new control in `components.category-mapping.spec.ts`.
 */

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
					shared: true,
					filesMounted: false,
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
				serverPaths: ['/data/movies'],
				match: PathMatch.UNKNOWN,
				error: null,
			}],
		);

		expect(destinations.value).toEqual([]);
	});
});
