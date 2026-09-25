import type { PeerCopy, ReleaseGrab, ReleaseGroup, ReleaseSearchResult } from '@mcs/shared';
import {
	EventName,
	GrabState,
	MediaOrigin,
	MediaServiceType,
	PEER_SUGGESTION_PREFIX,
	ReleaseKind,
	ReleaseSearchKind,
	SuggestionSource,
} from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useReleasesStore } from '@/stores/releases';
import { connectFakeSocket, createStoreContext, emitServerEvent, stubFetch, stubFetchRoutes } from './helpers';

/**
 * Two kinds of answer, two machines, and one way each of reaching them.
 *
 * The thing worth pinning here is not that a call happens but *which* call happens. A
 * peer copy handed to the download client is a magnetless add: the client takes nothing,
 * answers no error, and every screen says it was handed over while no byte ever moves. A
 * magnet handed to the transfer engine names no file anybody holds. Both failures are
 * silent, and neither is something a viewer could attribute to the button they pressed —
 * so the store keeps one function per kind and these tests watch the URL.
 */

function group (overrides: Partial<ReleaseGroup> = {}): ReleaseGroup {
	return {
		key: 'grp-1',
		title: 'Spartacus.S01E01.1080p.WEB-DL-GRP',
		kind: ReleaseKind.EPISODE,
		seasonNumber: 1,
		episodeNumber: 1,
		quality: '1080p',
		source: 'WEB-DL',
		languages: [],
		size: 3000,
		seeders: 40,
		releases: [],
		flags: [],
		indexers: ['prowlarr'],
		coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false },
		fills: [],
		brings: [],
		heldAlready: false,
		...overrides,
	};
}

function copy (overrides: Partial<PeerCopy> = {}): PeerCopy {
	return {
		id: `${PEER_SUGGESTION_PREFIX}svc-alice:1`,
		itemIds: ['their-ep-1', 'their-ep-2'],
		title: 'Spartacus',
		serviceId: 'svc-alice',
		serviceName: 'Alice Jellyfin',
		serviceType: MediaServiceType.JELLYFIN,
		peerId: 'peer-alice',
		peerName: 'Alice',
		origin: MediaOrigin.FRIEND,
		seasonNumber: 1,
		episodeNumber: null,
		size: 4000,
		quality: null,
		path: null,
		fills: [
			{ itemId: 'our-ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Episode 1' },
			{ itemId: 'our-ep-2', seasonNumber: 1, episodeNumber: 2, title: 'Episode 2' },
		],
		...overrides,
	};
}

function result (overrides: Partial<ReleaseSearchResult> = {}): ReleaseSearchResult {
	return {
		query: 'Spartacus S01',
		suggestions: [
			{ source: SuggestionSource.PEER, key: copy().id, copy: copy() },
			{ source: SuggestionSource.INDEXER, key: 'grp-1', release: group() },
		],
		missing: [{ itemId: 'our-ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Episode 1' }],
		failed: [],
		...overrides,
	};
}

function grab (overrides: Partial<ReleaseGrab> = {}): ReleaseGrab {
	return {
		id: 'grab-1',
		itemId: 'ep-1',
		title: 'Spartacus.S01E01.1080p.WEB-DL-GRP',
		indexer: 'prowlarr',
		state: GrabState.SENT,
		clientId: 'hash-1',
		bytesDone: 0,
		bytesTotal: 1000,
		rate: 0,
		savePath: null,
		targetPath: null,
		targetLibraryId: null,
		targetFolder: null,
		placements: [],
		error: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('stores/releases', () => {
	let pinia: ReturnType<typeof createStoreContext>['pinia'];

	beforeEach(() => {
		pinia = createStoreContext().pinia;
	});

	describe('search', () => {
		/**
		 * The defect the field exists for: a film asked for without saying so is asked of
		 * the television categories, which answers nothing and reports no fault.
		 */
		it('always says whether it is looking for a film or a show', async () => {
			const fetched = stubFetch([{ body: result() }]);
			const store = useReleasesStore();

			await store.search({ itemId: 'movie-1', kind: ReleaseSearchKind.MOVIE });

			expect(String(fetched.mock.calls[0][0])).toContain('kind=movie');
		});

		it('leaves the parameter out rather than sending an empty one', async () => {
			const fetched = stubFetch([{ body: result() }]);
			const store = useReleasesStore();

			await store.search({ itemId: 'series-1' });

			expect(String(fetched.mock.calls[0][0])).not.toContain('kind=');
		});

		it('holds the whole answer, both kinds of row, in the order it arrived', async () => {
			stubFetch([{ body: result() }]);
			const store = useReleasesStore();

			await store.search({ itemId: 'series-1' });

			expect(store.suggestions.map(one => one.source)).toEqual([
				SuggestionSource.PEER,
				SuggestionSource.INDEXER,
			]);
			expect(store.peerSuggestions.map(one => one.serviceName)).toEqual(['Alice Jellyfin']);
		});

		it('forgets the answer when the page moves to another media', async () => {
			stubFetch([{ body: result() }]);
			const store = useReleasesStore();

			await store.search({ itemId: 'series-1' });
			store.clear();

			expect(store.suggestions).toEqual([]);
			expect(store.peerSuggestions).toEqual([]);
			expect(store.searchedFor).toBeNull();
		});
	});

	describe('fetching the two kinds', () => {
		it('sends a tracker release to the download client and nowhere else', async () => {
			const fetched = stubFetchRoutes({ '/releases/grab': { body: grab() } });
			const store = useReleasesStore();

			await store.grab('release-1', 'ep-1');

			expect(fetched).toHaveBeenCalledTimes(1);
			expect(String(fetched.mock.calls[0][0])).toContain('/releases/grab');
			expect(store.grabs).toHaveLength(1);
		});

		/**
		 * A peer copy is one of our own catalogue rows on somebody else's server, which is
		 * exactly what a sync run reads from. There is no magnet on it and nothing for a
		 * torrent client to add.
		 */
		it('pulls a peer copy through the transfer machinery, never the download client', async () => {
			const fetched = stubFetchRoutes({
				'/sync/run': { body: { id: 'job-1', planId: null, planName: null } },
			});
			const store = useReleasesStore();

			await store.pull(copy());

			const [url, options] = fetched.mock.calls[0] as [unknown, { body: string }];

			expect(String(url)).toContain('/sync/run');
			expect(String(url)).not.toContain('/releases/grab');

			const body = JSON.parse(options.body) as {
				scope: { itemIds: string[] };
				sourceServiceIds: string[];
				filter: { includeHeld: boolean };
			};

			// The *holder's* rows. Naming our own would plan a pull from the disk the file
			// is missing off, which succeeds at planning nothing.
			expect(body.scope.itemIds).toEqual(['their-ep-1', 'their-ep-2']);
			expect(body.sourceServiceIds).toEqual(['svc-alice']);
			// Pressing the row is the decision, already made: without this the planner drops
			// a media we hold in another version and answers a run that plans nothing.
			expect(body.filter.includeHeld).toBe(true);
		});

		it('never writes a peer copy into the grab list, because it is not a grab', async () => {
			stubFetchRoutes({ '/sync/run': { body: { id: 'job-1' } } });
			const store = useReleasesStore();

			await store.pull(copy());

			expect(store.grabs).toEqual([]);
		});
	});

	describe('the plan', () => {
		it('asks for a plan with the same terms the search used, kind included', async () => {
			const fetched = stubFetch([{ body: { steps: [], uncovered: [] } }]);
			const store = useReleasesStore();

			await store.planFor({ itemId: 'movie-1', kind: ReleaseSearchKind.MOVIE });

			const [, options] = fetched.mock.calls[0] as [unknown, { body: string }];

			expect(JSON.parse(options.body)).toMatchObject({ kind: 'movie', itemId: 'movie-1' });
			expect(store.plannedFor).toBe('movie-1');
		});

		it('forgets the plan alone when a new search makes it stale', async () => {
			stubFetch([{ body: { steps: [], uncovered: [] } }, { body: result() }]);
			const store = useReleasesStore();

			await store.planFor({ itemId: 'series-1' });
			await store.search({ itemId: 'series-1' });
			store.clearPlan();

			expect(store.plan).toBeNull();
			expect(store.suggestions).toHaveLength(2);
		});
	});

	/**
	 * The stream pushes a frame per poll, and a list that grew by one every five seconds
	 * would be a progress bar repeated four hundred times by the end of a film.
	 */
	it('replaces a grab in place when the stream reports on it', async () => {
		stubFetch([{ body: [grab()] }]);
		connectFakeSocket(pinia);
		const store = useReleasesStore();

		await store.loadGrabs('ep-1');
		emitServerEvent(EventName.RELEASE_GRAB, grab({ state: GrabState.DOWNLOADING }));

		expect(store.grabs).toHaveLength(1);
		expect(store.grabs[0].state).toBe(GrabState.DOWNLOADING);
	});
});
