import { Readable } from 'node:stream';

/*
 * The one call in this manager that touches the disk, replaced rather than sandboxed.
 * A test that really unlinked would need a real file to destroy, and the rule being
 * pinned here is which path is computed and when the call is refused — not whether
 * `fs` works.
 */
const mockUnlink = jest.fn<Promise<void>, [string]>();

jest.mock('node:fs/promises', () => ({
	unlink: (path: string) => mockUnlink(path),
}));
import {
	ErrorKey,
	MatchStrategy,
	MediaKind,
	RequestSourceType,
	MediaServiceType,
	ReleasePreferenceDimension,
	SyncState,
	type MediaFileInfo,
} from '@mcs/shared';
import type { MediaItem, MediaMatch, MediaService as MediaServiceEntity } from '@/entities';
import type {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import {
	type CorrelationService,
	type RemoteFingerprintService,
	type CacheService,
	type HandlerRegistry,
	type SettingsService,
	type WorkerPoolService,
} from '@/services';
import type { RequestSourceRegistry } from '@/services/requests';
import { JobKind } from '@/worker/protocol';
import { MediaManager } from './media.manager';

const file = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
	path: '/library-a/Big Buck Bunny (2008) - S01E05 - The Flight.mp4',
	size: 1_048_576,
	container: 'mp4',
	videoCodec: 'hevc',
	audioCodec: 'aac',
	width: 1920,
	height: 1080,
	durationMs: 4000,
	bitrate: 2_000_000,
	quickHash: 'v1:abc',
	contentId: 'v1:abc:1048576',
	checksum: null,
	...overrides,
});

const item = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'item-a',
		serviceId: 'service-a',
		libraryId: 'library-a',
		externalId: 'a-5',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'The Flight',
		normalizedTitle: 'big buck bunny',
		year: 2008,
		seasonNumber: 1,
		episodeNumber: 5,
		externalIds: {},
		overview: null,
		artworkUrl: null,
		file: file(),
		quality: null,
		syncState: SyncState.UNKNOWN,
		addedAt: null,
		childCount: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaItem;

const match = (overrides: Partial<MediaMatch> = {}): MediaMatch =>
	({
		id: 'match-1',
		localItemId: 'item-a',
		remoteItemId: 'item-b',
		remoteServiceId: 'service-b',
		remotePeerId: null,
		strategy: MatchStrategy.NORMALIZED_TITLE,
		confidence: 0.7,
		state: SyncState.MISSING,
		reason: null,
		confirmedAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaMatch;

const mediaService = (overrides: Partial<MediaServiceEntity> = {}): MediaServiceEntity =>
	({
		id: 'service-a',
		name: 'Living room',
		type: MediaServiceType.PLEX,
		filesMounted: true,
		baseUrl: 'http://plex:32400',
		token: null,
		username: null,
		password: null,
		peerId: null,
		...overrides,
	}) as MediaServiceEntity;

interface Fakes {
	/** Asked which episodes exist, which no media server here can answer. */
	requestSource: { episodes: jest.Mock };
	settings: { getValue: jest.Mock; get: jest.Mock };
	items: {
		find: jest.Mock;
		findForCorrelation: jest.Mock;
		findFileIdentities: jest.Mock;
		findOne: jest.Mock;
		findByExternalId: jest.Mock;
		findChildren: jest.Mock;
		findCandidatesForMatch: jest.Mock;
		findPlacements: jest.Mock;
		search: jest.Mock;
		setSyncState: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		update: jest.Mock;
		remove: jest.Mock;
	};
	matches: {
		find: jest.Mock;
		findOne: jest.Mock;
		findForLocalItem: jest.Mock;
		findForRemoteItem: jest.Mock;
		findAppliedPairs: jest.Mock;
		upsertPair: jest.Mock;
		save: jest.Mock;
		delete: jest.Mock;
		deleteForItems: jest.Mock;
	};
	services: { find: jest.Mock; findOne: jest.Mock; findWithSecrets: jest.Mock };
	libraries: { findOne: jest.Mock };
	/*
	 * The pass the manager no longer runs itself, and the thread it would run it on.
	 *
	 * This is the line the split draws: what `MediaManager` does with a correlation is ask
	 * for one, and what a correlation does is its own suite. See `CorrelationService`.
	 */
	correlation: { correlate: jest.Mock };
	workers: { available: boolean; run: jest.Mock; start: jest.Mock };
	remoteFingerprint: jest.Mock;
	cache: { get: jest.Mock; set: jest.Mock };
	openArtwork: jest.Mock;
}

/**
 * Let what was started rather than awaited actually start.
 *
 * A correction answers before its re-correlation has run — that is the point of it — so
 * a test about the pass has to give the loop the turns the detour takes: reading the
 * threshold is itself a promise. A fixed number of `Promise.resolve()` calls is the same
 * wait spelled as a flake.
 */
const settled = (): Promise<void> => new Promise((resolve) => {
	setImmediate(resolve);
});

const build = (
	world: { items?: MediaItem[]; matches?: MediaMatch[] } = {},
): { manager: MediaManager; fakes: Fakes } => {
	const items = world.items ?? [];
	// The match table, seeded by the tests that are about what a pass does to rows it
	// finds already there rather than about the rows it writes.
	const pairs = world.matches ?? [];
	const fakes: Fakes = {
		// Nothing to add by default: a test that never mentions a metadata source gets a
		// catalogue with no news in it, which is what every other test here is about.
		requestSource: { episodes: jest.fn().mockResolvedValue([]) },
		settings: {
			getValue: jest.fn().mockResolvedValue(0.8),
			// A source configured and answering, because the tests that are about it say
			// what it answers and the rest never reach it.
			get: jest.fn().mockResolvedValue({
				requestSource: { type: RequestSourceType.SEERR, baseUrl: 'http://seerr', enabled: true },
			}),
		},
		/*
		 * The index, small enough to hold in an array.
		 *
		 * Reads and writes go through the same list rather than through canned answers,
		 * because re-filing is a rule about the shape of a tree: an episode moved under a
		 * season that did not exist a moment ago is only provable if the fake remembers
		 * the season it was just asked to create. A `mockResolvedValue` per call would
		 * pin the calls and prove nothing about the tree they leave behind.
		 */
		items: {
			find: jest.fn().mockResolvedValue(items),
			// The same rows, minus the columns a correlation pass never reads. The fake
			// hands back whole ones: what the projection is for is memory, not behaviour,
			// and a test that split them would be testing TypeORM.
			// Paged: the manager reads the catalogue a page at a time so that no single
			// statement holds the thread. The fake answers the slice it was asked for, and
			// an unpaged call the whole thing.
			findForCorrelation: jest.fn((skip = 0, take = 0) =>
				Promise.resolve(take > 0 ? items.slice(skip, skip + take) : items)),
			// Identities and the file, for the pass that looks for two copies of one file.
			findFileIdentities: jest.fn().mockResolvedValue(items),
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(items.find((candidate) => candidate.id === options.where.id) ?? null),
			),
			findByExternalId: jest.fn((serviceId: string, externalId: string) =>
				Promise.resolve(
					items.find(
						(candidate) =>
							candidate.serviceId === serviceId && candidate.externalId === externalId,
					) ?? null,
				),
			),
			findChildren: jest.fn((parentId: string) =>
				Promise.resolve(items.filter((candidate) => candidate.parentId === parentId)),
			),
			findCandidatesForMatch: jest.fn().mockResolvedValue([]),
			findPlacements: jest.fn((serviceId: string) =>
				Promise.resolve(
					items
						.filter(
							(candidate) =>
								candidate.serviceId === serviceId && candidate.kind !== MediaKind.MOVIE,
						)
						.map((candidate) => ({
							id: candidate.id,
							parentId: candidate.parentId,
							kind: candidate.kind,
							seasonNumber: candidate.seasonNumber,
							synthetic: candidate.synthetic,
						})),
				),
			),
			search: jest.fn().mockResolvedValue([[], 0]),
			setSyncState: jest.fn().mockResolvedValue(undefined),
			create: jest.fn((values: Partial<MediaItem>) => ({ id: `made-${items.length}`, ...values })),
			save: jest.fn((value: MediaItem) => {
				if (!items.includes(value)) {
					items.push(value);
				}

				return Promise.resolve(value);
			}),
			update: jest.fn((where: { id: string }, values: Partial<MediaItem>) => {
				const row = items.find((candidate) => candidate.id === where.id);

				if (row !== undefined) {
					Object.assign(row, values);
				}

				return Promise.resolve(undefined);
			}),
			remove: jest.fn((value: MediaItem) => {
				const at = items.indexOf(value);

				if (at >= 0) {
					items.splice(at, 1);
				}

				return Promise.resolve(value);
			}),
		},
		matches: {
			find: jest.fn().mockResolvedValue(pairs),
			findOne: jest.fn().mockResolvedValue(null),
			findForLocalItem: jest.fn().mockResolvedValue([]),
			findForRemoteItem: jest.fn().mockResolvedValue([]),
			// What is already paired, which is the gate the season/episode strategy opens
			// on. Empty unless a test says otherwise.
			findAppliedPairs: jest.fn().mockResolvedValue([]),
			upsertPair: jest.fn((claim: unknown) => Promise.resolve(claim as MediaMatch)),
			save: jest.fn((value: MediaMatch) => Promise.resolve(value)),
			delete: jest.fn((where: { id: string }) => {
				const at = pairs.findIndex((pair) => pair.id === where.id);

				if (at >= 0) {
					pairs.splice(at, 1);
				}

				return Promise.resolve(undefined);
			}),
			deleteForItems: jest.fn().mockResolvedValue(0),
		},
		services: {
			find: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(mediaService()),
			findWithSecrets: jest.fn().mockResolvedValue(mediaService({ token: 'plex-token' })),
		},
		cache: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) },
		correlation: { correlate: jest.fn().mockResolvedValue(0) },
		/*
		 * No thread, so the manager runs the pass through the dependency above.
		 *
		 * `available` is what a worker itself reports, and false is the honest default here:
		 * a unit test has no built `dist/worker` to spawn, and a fake that claimed one would
		 * pin the delegation without ever proving the thread can run the pass. The journey
		 * that proves that is in `test/worker.spec.ts`.
		 */
		workers: { available: false, run: jest.fn(), start: jest.fn() },
		/*
		 * One library whose mapping is the identity, so a path a service reports is a
		 * path the gateway can name. Erasing is the only thing here that needs it, and
		 * the tests that refuse an erasure replace it.
		 */
		remoteFingerprint: jest.fn().mockResolvedValue(null),
		libraries: {
			findOne: jest.fn().mockResolvedValue({
				id: 'library-a',
				localPath: '/mnt/media',
				paths: ['/media'],
			}),
		},
		openArtwork: jest.fn(async () => ({
			stream: Readable.from([Buffer.from('poster bytes')]),
			contentType: 'image/jpeg',
		})),
	};

	const manager = new MediaManager(
		fakes.items as unknown as MediaItemRepository,
		fakes.matches as unknown as MediaMatchRepository,
		fakes.services as unknown as MediaServiceRepository,
		fakes.correlation as unknown as CorrelationService,
		fakes.workers as unknown as WorkerPoolService,
		fakes.settings as unknown as SettingsService,
		fakes.cache as unknown as CacheService,
		{ get: jest.fn(() => ({ openArtwork: fakes.openArtwork })) } as unknown as HandlerRegistry,
		fakes.libraries as unknown as LibraryRepository,
		// Nothing is identified remotely unless a test asks: fetching windows from a
		// server is the one thing here that leaves the machine, and a fake that answered
		// by default would hide a pass that started doing it for every copy.
		{ fingerprint: fakes.remoteFingerprint } as unknown as RemoteFingerprintService,
		// The metadata source, which is the only thing that knows an episode nobody holds
		// exists. Empty by default: a test that never mentions it gets a catalogue with
		// nothing to add, which is what every other test is about.
		{ get: jest.fn(() => fakes.requestSource) } as unknown as RequestSourceRegistry,
	);

	return { manager, fakes };
};

describe('MediaManager', () => {
	describe('matches', () => {
		it('lists both sides, because an item is the remote half of somebody else’s', async () => {
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findForLocalItem.mockResolvedValue([match({ id: 'match-1', confidence: 0.7 })]);
			fakes.matches.findForRemoteItem.mockResolvedValue([
				match({ id: 'match-1', confidence: 0.7 }),
				match({ id: 'match-2', confidence: 0.9 }),
			]);

			const listed = await manager.matches('item-a');

			// The same row on both sides is one entry, and the strongest comes first.
			expect(listed.map((entry) => entry.id)).toEqual(['match-2', 'match-1']);
		});

		it('records a confirmation as a human decision, not as a better score', async () => {
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(match());

			const confirmed = await manager.confirmMatch('item-a', 'match-1', 'item-a');

			expect(confirmed.strategy).toBe(MatchStrategy.MANUAL);
			expect(confirmed.confidence).toBe(1);
			expect(confirmed.confirmedAt).not.toBeNull();
		});

		it('refuses a match that has nothing to do with the item in the path', async () => {
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(
				match({ localItemId: 'somebody-else', remoteItemId: 'somebody-else-too' }),
			);

			await expect(manager.confirmMatch('item-a', 'match-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});
	});

	describe('browsing', () => {
		it('caps a page rather than trusting what was asked for', async () => {
			const { manager, fakes } = build();

			await manager.search({ page: 0, limit: 10_000 });

			expect(fakes.items.search).toHaveBeenCalledWith(
				expect.objectContaining({ page: 1, limit: 200 }),
			);
		});

		it('takes the parent from the route and never from the query string', async () => {
			const { manager, fakes } = build({ items: [item()] });

			await manager.children('item-a', { parentId: 'somewhere-else' });

			expect(fakes.items.search).toHaveBeenCalledWith(
				expect.objectContaining({ parentId: 'item-a' }),
			);
		});

		it('refuses artwork for an item that has none', async () => {
			const { manager } = build({ items: [item({ artworkUrl: null })] });

			await expect(manager.artwork('item-a')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});

		it('refuses to browse under an item nobody has', async () => {
			const { manager } = build();

			await expect(manager.children('ghost', {})).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
			await expect(manager.node('ghost')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});
	});

	describe('undoing a correlation', () => {
		it('deletes the match the item in the path takes part in', async () => {
			// A correlation nobody can undo is one nobody will trust.
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(match());

			await manager.deleteMatch('item-a', 'match-1');

			expect(fakes.matches.delete).toHaveBeenCalledWith({ id: 'match-1' });
		});

		it('refuses a match that has nothing to do with the item in the path', async () => {
			// Without that check any identifier would do for the first half of the path,
			// and a deletion would land on a correlation nobody was looking at.
			const { manager, fakes } = build({ items: [item()] });

			fakes.matches.findOne.mockResolvedValue(
				match({ localItemId: 'somebody-else', remoteItemId: 'somebody-else-too' }),
			);

			await expect(manager.deleteMatch('item-a', 'match-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
			expect(fakes.matches.delete).not.toHaveBeenCalled();
		});

		it('answers a key for a match that is not there at all', async () => {
			const { manager } = build({ items: [item()] });

			await expect(manager.deleteMatch('item-a', 'ghost')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});
	});

	describe('correcting what a service got wrong', () => {
		it('writes the correction into the columns everything else reads', async () => {
			// A season reassigned by hand that only changed a label would be worse than
			// nothing: it has to reach correlation and filing too.
			const { manager, fakes } = build({ items: [item()] });

			await manager.setOverride('item-a', { seasonNumber: 2, episodeNumber: 14 });

			const saved = fakes.items.save.mock.calls[0][0] as MediaItem;

			expect(saved).toMatchObject({ seasonNumber: 2, episodeNumber: 14 });
			// And what the service said is kept, or the change could be neither shown
			// nor undone.
			expect(saved.reported).toMatchObject({ seasonNumber: 1, episodeNumber: 5 });
		});

		it('re-correlates at once rather than waiting for the next scan', async () => {
			// Renumbering an episode changes what it matches. Leaving that until the next
			// scan means the screen that made the correction still shows the old state.
			const { manager, fakes } = build({ items: [item()] });

			await manager.setOverride('item-a', { seasonNumber: 2 });
			await settled();

			// The service the corrected row belongs to, with the threshold this side read:
			// a correlation asked for without one would score every pair against a default
			// nobody chose. No reporter: nobody is watching a pass nobody waited for.
			expect(fakes.correlation.correlate).toHaveBeenCalledWith('service-a', 0.8);
		});

		it('answers the correction without waiting for the catalogue to be re-correlated', async () => {
			/*
			 * The pass is over sixty-five thousand rows on the owner's gateway, and the
			 * dialog was holding its request open for every one of them: "l'édition d'une
			 * corrélation est hyper lente". The correction itself is already written when
			 * the pass starts, so there is nothing in this answer that depends on it.
			 */
			const { manager, fakes } = build({ items: [item()] });
			let settled = false;

			fakes.correlation.correlate.mockImplementation(
				async () => new Promise(() => {
					// Never. A pass that does not finish must not stop this answering.
				}),
			);

			await manager.setOverride('item-a', { seasonNumber: 2 }).then(() => {
				settled = true;
			});

			expect(settled).toBe(true);
		});

		it('hands the re-correlation to a thread as a job nobody is waiting for', async () => {
			// The second of the two shapes, and what it is for: the caller takes a run
			// identifier and the result arrives on the stream the screens already read.
			const { manager, fakes } = build({ items: [item()] });

			fakes.workers.available = true;

			await manager.setOverride('item-a', { seasonNumber: 2 });
			await settled();

			expect(fakes.workers.start).toHaveBeenCalledWith(JobKind.CORRELATE, {
				serviceId: 'service-a',
				threshold: 0.8,
			});
			expect(fakes.workers.run).not.toHaveBeenCalled();
		});

		it('puts the service’s answer back when the correction is withdrawn', async () => {
			const corrected = item({
				seasonNumber: 2,
				overrides: { seasonNumber: 2 },
				reported: {
					libraryId: 'library-a',
					title: 'The Flight',
					seriesTitle: null,
					year: 2008,
					seasonNumber: 1,
					episodeNumber: 5,
					overview: null,
					externalIds: {},
				},
			} as Partial<MediaItem>);
			const { manager, fakes } = build({ items: [corrected] });

			await manager.setOverride('item-a', null);

			const saved = fakes.items.save.mock.calls[0][0] as MediaItem;

			expect(saved.seasonNumber).toBe(1);
			expect(saved.overrides).toBeNull();
			expect(saved.reported).toBeNull();
		});

		/**
		 * The case the owner asked for in as many words: reassign it *before* pulling it.
		 *
		 * A media this gateway holds no copy of is the ordinary case rather than the
		 * exotic one — a film on a friend's server, a row a peer reported and nothing
		 * local has ever seen — and it is exactly when reclassifying matters, because the
		 * library decides which folder the pull lands in. A guard that asked for a local
		 * file here would refuse most of what a gateway with one server can see, and the
		 * correction would become a tidy-up after a transfer had already filed the file
		 * under the wrong shelf.
		 */
		it('reclassifies a media we hold no copy of, rather than refusing it', async () => {
			const remote = item({
				id: 'remote-film',
				serviceId: 'peer-service',
				kind: MediaKind.MOVIE,
				libraryId: 'their-films',
				// Nothing on our disks: this row is somebody else's catalogue entry.
				file: null,
			});
			const { manager, fakes } = build({ items: [remote] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'peer-service', filesMounted: false, peerId: 'peer-1' }),
			]);

			const answered = await manager.setOverride('remote-film', { libraryId: 'our-documentaries' });

			expect(answered.libraryId).toBe('our-documentaries');

			const saved = fakes.items.save.mock.calls[0][0] as MediaItem;

			// And the service's own answer is kept, so the next scan re-applies the
			// correction instead of filing the row back under the shelf it came from.
			expect(saved.overrides).toMatchObject({ libraryId: 'our-documentaries' });
			expect(saved.reported).toMatchObject({ libraryId: 'their-films' });
		});

		/**
		 * The third level of a search order, and the one press that cancels it.
		 *
		 * It rides in the overrides blob because it is a household decision about one
		 * media, like `ignored` beside it. What has to be true is that cancelling leaves
		 * *nothing*: a blob still carrying `releasePreference: null` resolves exactly like
		 * an absent key, so the item would go on being labelled as corrected and the
		 * dialog would offer to restore a correction nobody made.
		 */
		it('keeps a media’s own search order, and cancelling it leaves no correction', async () => {
			const { manager, fakes } = build({ items: [item()] });

			await manager.setOverride('item-a', {
				releasePreference: {
					ranks: [{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p'] }],
				},
			});

			expect((fakes.items.save.mock.calls[0][0] as MediaItem).overrides).toMatchObject({
				releasePreference: {
					ranks: [{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p'] }],
				},
			});

			await manager.setOverride('item-a', { releasePreference: null });

			const cancelled = fakes.items.save.mock.calls.at(-1)?.[0] as MediaItem;

			expect(cancelled.overrides).toBeNull();
		});

		/**
		 * An empty order is a sentence, and it is not the same one as having none.
		 *
		 * "Order by nothing, on purpose" is how one series opts out of a household order
		 * that is wrong for it — see `isEmptyReleasePreference`. Pruning it as though it
		 * were absent would make that unsayable, and the only way to say it would be to
		 * list every value in the order they already arrive in.
		 */
		it('keeps an order that separates nothing, because that is a decision too', async () => {
			const { manager, fakes } = build({ items: [item()] });

			await manager.setOverride('item-a', { releasePreference: { ranks: [] } });

			expect((fakes.items.save.mock.calls[0][0] as MediaItem).overrides).toEqual({
				releasePreference: { ranks: [] },
			});
		});
	});

	/**
	 * A corrected number that does not move the item corrects nothing.
	 *
	 * The whole product navigates by `parentId` — the tree walks it, the missing counts
	 * group by it, the gap detection lists a season's children — so an episode reading
	 * `S2E1` from inside season one shows up under the wrong season and, because
	 * children are ordered by season and then episode, sorts after every episode of
	 * season one. "It doesn't show up under season 2" and "it disappeared" are the same
	 * missing write, described from two ends.
	 */
	/*
	 * The half of a catalogue no media server can supply.
	 *
	 * Our index mirrors what the servers declare, so an episode that aired last night and
	 * that nobody holds exists nowhere: no row, nothing counting it as missing, and a
	 * season three short reading as complete. The owner's words for it: "l'épisode 10 qui
	 * est sorti ne remonte pas". The metadata source has known all along.
	 */
	describe('the episodes only a metadata source knows about', () => {
		const show = (): MediaItem[] => [
			item({
				id: 'series-1',
				externalId: 'jf-series',
				kind: MediaKind.SERIES,
				title: 'Stuart Fails to Save the Universe',
				normalizedTitle: 'stuart fails to save the universe',
				externalIds: { tmdb: '1234' },
				seasonNumber: null,
				episodeNumber: null,
				file: null,
				childCount: 1,
			}),
			item({
				id: 'season-1',
				externalId: 'jf-season-1',
				kind: MediaKind.SEASON,
				title: 'Season 1',
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				seasonNumber: 1,
				episodeNumber: null,
				file: null,
				childCount: 1,
			}),
			item({
				id: 'episode-9',
				externalId: 'jf-episode-9',
				parentId: 'season-1',
				parentExternalId: 'jf-season-1',
				seasonNumber: 1,
				episodeNumber: 9,
			}),
		];

		it('writes a row for an aired episode no server here reports', async () => {
			const { manager, fakes } = build({ items: show() });

			fakes.requestSource.episodes.mockResolvedValue([
				{ seasonNumber: 1, episodeNumber: 9, title: 'Nine', airDate: '2026-09-11' },
				{ seasonNumber: 1, episodeNumber: 10, title: 'Ten', airDate: '2026-09-18' },
			]);

			expect(await manager.discoverEpisodes('series-1')).toBe(1);
			// Ours and not a server's, which is what the stale pass at the end of a scan
			// reads to know it must not delete it.
			expect(fakes.items.save).toHaveBeenCalledWith(expect.objectContaining({
				synthetic: true,
				kind: MediaKind.EPISODE,
				parentId: 'season-1',
				seasonNumber: 1,
				episodeNumber: 10,
				title: 'Ten',
				// No file, which is the entire point: it reads as missing everywhere an
				// episode's state is read, so a search offers to fill it.
				file: null,
			}));
		});

		it('does not offer to fetch the second half of a two-part file', async () => {
			/*
			 * The owner's Eureka, Monk and Beetlejuice, all four of them this shape.
			 *
			 * One file named `S01E09-E10` holds both episodes, the provider lists them
			 * separately, and a gap is the difference between those two lists. Reading
			 * only the first number made the second a hole, so a row was minted for it
			 * and the household was invited to download an episode it was watching.
			 */
			const { manager, fakes } = build({
				items: [
					...show().slice(0, -1),
					item({
						id: 'episode-9-10',
						externalId: 'jf-episode-9-10',
						parentId: 'season-1',
						parentExternalId: 'jf-season-1',
						seasonNumber: 1,
						episodeNumber: 9,
						episodeNumberEnd: 10,
					}),
				],
			});

			fakes.requestSource.episodes.mockResolvedValue([
				{ seasonNumber: 1, episodeNumber: 9, title: 'Nine', airDate: '2026-09-11' },
				{ seasonNumber: 1, episodeNumber: 10, title: 'Ten', airDate: '2026-09-18' },
			]);

			expect(await manager.discoverEpisodes('series-1')).toBe(0);
			expect(fakes.items.save).not.toHaveBeenCalled();
		});

		it('still finds a real hole beside a two-part file', async () => {
			// The range must not become a blanket excuse: episode eleven is genuinely
			// absent and has to keep being found.
			const { manager, fakes } = build({
				items: [
					...show().slice(0, -1),
					item({
						id: 'episode-9-10',
						externalId: 'jf-episode-9-10',
						parentId: 'season-1',
						parentExternalId: 'jf-season-1',
						seasonNumber: 1,
						episodeNumber: 9,
						episodeNumberEnd: 10,
					}),
				],
			});

			fakes.requestSource.episodes.mockResolvedValue([
				{ seasonNumber: 1, episodeNumber: 10, title: 'Ten', airDate: '2026-09-18' },
				{ seasonNumber: 1, episodeNumber: 11, title: 'Eleven', airDate: '2026-09-25' },
			]);

			expect(await manager.discoverEpisodes('series-1')).toBe(1);
			expect(fakes.items.save).toHaveBeenCalledWith(
				expect.objectContaining({ episodeNumber: 11 }),
			);
		});

		it('leaves an episode that has not aired alone', async () => {
			// It is not missing from a library; it is missing from the world. A row
			// proposing a search for it sends somebody looking for something that does not
			// exist yet.
			const { manager, fakes } = build({ items: show() });

			fakes.requestSource.episodes.mockResolvedValue([
				{ seasonNumber: 1, episodeNumber: 11, title: 'Eleven', airDate: '2099-01-01' },
			]);

			expect(await manager.discoverEpisodes('series-1')).toBe(0);
			expect(fakes.items.save).not.toHaveBeenCalled();
		});

		it('reads a missing date as not aired, which is the cautious half of the answer', async () => {
			const { manager, fakes } = build({ items: show() });

			fakes.requestSource.episodes.mockResolvedValue([
				{ seasonNumber: 1, episodeNumber: 12, title: 'Twelve', airDate: null },
			]);

			expect(await manager.discoverEpisodes('series-1')).toBe(0);
		});

		it('never asks about season zero, which is specials', async () => {
			// Nobody is missing a behind-the-scenes clip, and "the whole show" should not
			// mean a folder of them.
			const { manager, fakes } = build({
				items: [
					...show(),
					item({
						id: 'season-0',
						externalId: 'jf-season-0',
						kind: MediaKind.SEASON,
						parentId: 'series-1',
						seasonNumber: 0,
						episodeNumber: null,
						file: null,
					}),
				],
			});

			await manager.discoverEpisodes('series-1');

			expect(fakes.requestSource.episodes).toHaveBeenCalledTimes(1);
			expect(fakes.requestSource.episodes).toHaveBeenCalledWith(expect.anything(), '1234', 1);
		});

		/*
		 * Asked from the season, which is where somebody stands when they wonder where the
		 * rest of it is. The identifier still comes from the series — a season carries
		 * none — so only the list of seasons narrows.
		 */
		it('answers from a season, and asks about that season alone', async () => {
			const { manager, fakes } = build({
				items: [
					...show(),
					item({
						id: 'season-2',
						externalId: 'jf-season-2',
						kind: MediaKind.SEASON,
						parentId: 'series-1',
						seasonNumber: 2,
						episodeNumber: null,
						file: null,
					}),
				],
			});

			fakes.requestSource.episodes.mockResolvedValue([
				{ seasonNumber: 1, episodeNumber: 10, title: 'Ten', airDate: '2026-09-18' },
			]);

			expect(await manager.discoverEpisodes('season-1')).toBe(1);
			expect(fakes.requestSource.episodes).toHaveBeenCalledTimes(1);
			expect(fakes.requestSource.episodes).toHaveBeenCalledWith(expect.anything(), '1234', 1);
		});

		it('refuses a season whose series is gone, because the identifier lives there', async () => {
			const { manager } = build({
				items: show().filter(one => one.id !== 'series-1'),
			});

			await expect(manager.discoverEpisodes('season-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_IDENTIFIED,
			);
		});

		it('refuses a show nothing has matched to a provider', async () => {
			// A fixable state rather than a silent zero: the screen can say which of the
			// two nothings this is.
			const { manager } = build({
				items: show().map(one => (one.id === 'series-1' ? { ...one, externalIds: {} } : one)),
			});

			await expect(manager.discoverEpisodes('series-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_IDENTIFIED,
			);
		});

		it('refuses when no request source is configured', async () => {
			const { manager, fakes } = build({ items: show() });

			fakes.settings.get.mockResolvedValue({ requestSource: null });

			await expect(manager.discoverEpisodes('series-1')).rejects.toThrow(
				ErrorKey.REQUEST_SOURCE_NOT_CONFIGURED,
			);
		});

		it('refuses on anything that is not a show', async () => {
			const { manager } = build({ items: show() });

			await expect(manager.discoverEpisodes('episode-9')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_IDENTIFIED,
			);
		});
	});

	describe('re-filing a corrected episode', () => {
		const show = (): { series: MediaItem; seasonOne: MediaItem; episode: MediaItem } => {
			const series = item({
				id: 'series-1',
				externalId: 'jf-series',
				kind: MediaKind.SERIES,
				title: 'Beyblade',
				normalizedTitle: 'beyblade',
				seasonNumber: null,
				episodeNumber: null,
				file: null,
				childCount: 1,
			});
			const seasonOne = item({
				id: 'season-1',
				externalId: 'jf-season-1',
				kind: MediaKind.SEASON,
				title: 'Saison 1',
				normalizedTitle: 'beyblade',
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				seasonNumber: 1,
				episodeNumber: null,
				file: null,
				childCount: 1,
			});
			const episode = item({
				id: 'episode-14',
				externalId: 'jf-episode-14',
				title: 'L’Apparition d’un rival',
				normalizedTitle: 'beyblade',
				parentId: 'season-1',
				parentExternalId: 'jf-season-1',
				seasonNumber: 1,
				episodeNumber: 14,
			});

			return { series, seasonOne, episode };
		};


		it('hangs the episode under the season the correction names', async () => {
			const { series, seasonOne, episode } = show();
			const seasonTwo = item({
				id: 'season-2',
				externalId: 'jf-season-2',
				kind: MediaKind.SEASON,
				title: 'Saison 2',
				normalizedTitle: 'beyblade',
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				seasonNumber: 2,
				episodeNumber: null,
				file: null,
				childCount: 0,
			});
			const world = [series, seasonOne, seasonTwo, episode];
			const { manager } = build({ items: world });

			await manager.setOverride('episode-14', { seasonNumber: 2, episodeNumber: 1 });

			expect(episode.parentId).toBe('season-2');
			// And both ends of the move say what they now hold, because the tree draws the
			// count at once — a season that has just gained an episode and still reads
			// "no episodes" is the correction looking as though it had not worked.
			expect(seasonOne.childCount).toBe(0);
			expect(seasonTwo.childCount).toBe(1);
		});

		/**
		 * The owner's own case: there is no season two, and there never will be. The
		 * service files the episode in season one and no amount of asking it will
		 * produce a season it does not believe in, so the gateway makes the node or the
		 * correction has nowhere to land.
		 */
		it('creates the season when the service does not report one', async () => {
			const { series, seasonOne, episode } = show();
			const world = [series, seasonOne, episode];
			const { manager } = build({ items: world });

			await manager.setOverride('episode-14', { seasonNumber: 2, episodeNumber: 1 });

			const created = world.find(
				(one) => one.kind === MediaKind.SEASON && one.seasonNumber === 2,
			);

			// The season is the whole point: without it the episode has nowhere to hang.
			expect(created).toBeDefined();
			expect(episode.parentId).toBe(created?.id);
			// Under the series, on the same service and the same shelf: a season that
			// landed in another library would simply be missing from its series' summary,
			// which is computed one library at a time.
			expect(created).toMatchObject({
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				serviceId: series.serviceId,
				libraryId: series.libraryId,
				normalizedTitle: 'beyblade',
			});
			// Named beside its siblings rather than in our words: a household running
			// Jellyfin in French reads `Saison 1`, and `Season 2` next to it announces
			// that something other than their server made this row.
			expect(created?.title).toBe('Saison 2');
			// And marked, or the stale pass at the end of the next scan deletes it as a
			// row the service dropped.
			expect(created?.synthetic).toBe(true);
			expect(created?.externalId).toMatch(/^mcs:synthetic:/);
		});

		it('falls back to its own words when no sibling is numbered', async () => {
			const { series, episode } = show();
			const world = [series, { ...episode, parentId: 'series-1', parentExternalId: 'jf-series' }];
			const { manager } = build({ items: world as MediaItem[] });

			await manager.setOverride('episode-14', { seasonNumber: 3 });

			expect(world.find((one) => one.kind === MediaKind.SEASON)?.title).toBe('Season 3');
		});

		/**
		 * The other half of an undo. Clearing a correction has to put the episode back
		 * where the *service* files it, not back under whatever we had derived while the
		 * correction stood — which is why the parent is read from the identifier the
		 * service stated rather than from the link a correction moved.
		 */
		it('files it back where the service\'s own numbers say when the correction is withdrawn', async () => {
			const { series, seasonOne, episode } = show();
			const corrected = item({
				...episode,
				parentId: 'invented-2',
				seasonNumber: 2,
				episodeNumber: 1,
				overrides: { seasonNumber: 2, episodeNumber: 1 },
				reported: {
					libraryId: episode.libraryId,
					title: episode.title,
					seriesTitle: null,
					year: episode.year,
					seasonNumber: 1,
					episodeNumber: 14,
					overview: null,
					externalIds: {},
				},
			} as Partial<MediaItem>);
			const invented = item({
				id: 'invented-2',
				externalId: 'mcs:synthetic:abc',
				synthetic: true,
				kind: MediaKind.SEASON,
				title: 'Saison 2',
				normalizedTitle: 'beyblade',
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				seasonNumber: 2,
				episodeNumber: null,
				file: null,
				childCount: 1,
			});
			const world = [series, seasonOne, invented, corrected];
			const { manager } = build({ items: world });

			await manager.setOverride('episode-14', null);

			expect(corrected.parentId).toBe('season-1');
			expect(corrected.seasonNumber).toBe(1);
			// The season nobody is under any more goes with it. Nothing else could ever
			// remove it: no service will stop reporting a row no service ever reported.
			expect(world.some((one) => one.id === 'invented-2')).toBe(false);
		});

		it('files a numbered episode out of a folder that is not a season', async () => {
			/*
			 * The owner's Jellyfin publishes `Bonus`, `Saison inconnue` and `HD - VOST`
			 * as seasons of a show while stamping each episode inside them with the
			 * season it really belongs to. An earlier version withdrew a correction by
			 * putting the episode back under the parent the service *named*, which is
			 * this folder — the same defect reached from the other side.
			 */
			const { series, seasonOne, episode } = show();
			const bonus = item({
				id: 'bonus',
				externalId: 'jf-bonus',
				kind: MediaKind.SEASON,
				title: 'Bonus',
				normalizedTitle: 'beyblade',
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				seasonNumber: null,
				episodeNumber: null,
				file: null,
				childCount: 1,
			});
			const stray = item({
				...episode,
				parentId: 'bonus',
				parentExternalId: 'jf-bonus',
				seasonNumber: 1,
			} as Partial<MediaItem>);
			const { manager } = build({ items: [series, seasonOne, bonus, stray] });

			expect(await manager.refile(stray)).toBe(true);
			expect(stray.parentId).toBe('season-1');
		});

		it('leaves the filing alone when only the episode number changed', async () => {
			// The place an episode lives is decided by its season and nothing else, and
			// the ordering inside a season already follows the number. Writing the same
			// parent back would move `updatedAt` on a row nothing happened to.
			const { series, seasonOne, episode } = show();
			const { manager, fakes } = build({ items: [series, seasonOne, episode] });

			fakes.items.save.mockClear();

			await manager.setOverride('episode-14', { episodeNumber: 2 });

			expect(episode.parentId).toBe('season-1');
			expect(fakes.items.save).toHaveBeenCalledTimes(1);
		});

		it('leaves a season where it is: no correction changes which show it belongs to', async () => {
			const { series, seasonOne, episode } = show();
			const { manager } = build({ items: [series, seasonOne, episode] });

			await manager.setOverride('season-1', { seasonNumber: 4 });

			expect(seasonOne.parentId).toBe('series-1');
		});

		it('files an episode whose season number was erased under the show itself', async () => {
			const { series, seasonOne, episode } = show();
			const world = [series, seasonOne, episode];
			const { manager } = build({ items: world });

			await manager.setOverride('episode-14', { seasonNumber: null });

			expect(episode.parentId).toBe('series-1');
			expect(world.filter((one) => one.kind === MediaKind.SEASON)).toHaveLength(1);
		});

		it('leaves an episode that hangs from nothing alone rather than inventing a show', async () => {
			const orphan = item({ id: 'orphan', parentId: null, parentExternalId: null });
			const world = [orphan];
			const { manager } = build({ items: world });

			await manager.setOverride('orphan', { seasonNumber: 2 });

			expect(orphan.parentId).toBeNull();
			expect(world).toHaveLength(1);
		});
	});

	describe('identifying a copy nothing here can read', () => {
		const remote = (values: Partial<MediaItem> = {}): MediaItem =>
			item({
				id: 'remote-1',
				serviceId: 'service-b',
				externalId: 'plex-1',
				kind: MediaKind.MOVIE,
				file: file({ quickHash: '', contentId: '', size: 20_292_365_537 }),
				...values,
			} as Partial<MediaItem>);

		const ours = (values: Partial<MediaItem> = {}): MediaItem =>
			item({
				id: 'ours-1',
				serviceId: 'service-a',
				externalId: 'jf-1',
				kind: MediaKind.MOVIE,
				file: file({ quickHash: 'v1:abc', contentId: 'q1:abc', size: 20_292_365_537 }),
				...values,
			} as Partial<MediaItem>);

		const unmounted = () => mediaService({ id: 'service-b', filesMounted: false });

		it('fetches three windows for a copy whose byte count matches one we hold', async () => {
			// The owner's case: Jellyfin and Plex over the same disk, only one mounted.
			const twin = remote();
			const { manager, fakes } = build({ items: [ours(), twin] });

			fakes.services.find.mockResolvedValue([mediaService(), unmounted()]);
			fakes.services.findWithSecrets.mockResolvedValue(unmounted());
			fakes.remoteFingerprint.mockResolvedValue({
				size: 20_292_365_537,
				quickHash: 'v1:abc',
				contentId: 'q1:abc',
			});

			expect(await manager.identifyTwins('service-b')).toBe(1);
			expect(twin.file?.contentId).toBe('q1:abc');
			// And the two are now the same version, which is the whole point.
			expect(twin.file?.quickHash).toBe(ours().file?.quickHash);
		});

		it('reads nothing at all when no byte count matches', async () => {
			// Three windows is nothing per file and gigabytes across a catalogue. A copy
			// nothing here resembles is a copy worth leaving alone.
			const { manager, fakes } = build({
				items: [ours(), remote({ file: file({ quickHash: '', contentId: '', size: 999 }) })],
			});

			fakes.services.find.mockResolvedValue([mediaService(), unmounted()]);

			expect(await manager.identifyTwins('service-b')).toBe(0);
			expect(fakes.remoteFingerprint).not.toHaveBeenCalled();
		});

		it('reads nothing for a service whose files it can reach on a disk', async () => {
			// The scan fingerprints those for free; asking the server for bytes it has
			// already read would be paying twice for the same answer.
			const { manager, fakes } = build({ items: [ours(), remote()] });

			fakes.services.find.mockResolvedValue([
				mediaService(),
				mediaService({ id: 'service-b', filesMounted: true }),
			]);

			expect(await manager.identifyTwins('service-b')).toBe(0);
			expect(fakes.remoteFingerprint).not.toHaveBeenCalled();
		});

		it('leaves a copy that already knows what it is alone', async () => {
			const known = remote({ file: file({ quickHash: 'v1:zzz', contentId: 'q1:zzz', size: 20_292_365_537 }) });
			const { manager, fakes } = build({ items: [ours(), known] });

			fakes.services.find.mockResolvedValue([mediaService(), unmounted()]);

			expect(await manager.identifyTwins('service-b')).toBe(0);
			expect(fakes.remoteFingerprint).not.toHaveBeenCalled();
		});

		it('leaves the copy as it was when the server would not answer', async () => {
			// A refusal, a timeout, a server that will not serve ranges. The caller knew
			// nothing about this copy a moment ago and knows nothing now, which is not a
			// failure of anything.
			const twin = remote();
			const { manager, fakes } = build({ items: [ours(), twin] });

			fakes.services.find.mockResolvedValue([mediaService(), unmounted()]);
			fakes.services.findWithSecrets.mockResolvedValue(unmounted());
			fakes.remoteFingerprint.mockResolvedValue(null);

			expect(await manager.identifyTwins('service-b')).toBe(0);
			expect(twin.file?.contentId).toBe('');
		});
	});

	describe('filing a whole service by what its numbers say', () => {
		const tree = (): MediaItem[] => {
			const series = item({
				id: 'series-1',
				externalId: 'jf-series',
				kind: MediaKind.SERIES,
				title: 'Beyblade',
				normalizedTitle: 'beyblade',
				seasonNumber: null,
				episodeNumber: null,
				file: null,
				childCount: 2,
			});
			const seasonOne = item({
				id: 'season-1',
				externalId: 'jf-season-1',
				kind: MediaKind.SEASON,
				title: 'Saison 1',
				normalizedTitle: 'beyblade',
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				seasonNumber: 1,
				episodeNumber: null,
				file: null,
				childCount: 0,
			});
			// What the owner's Jellyfin publishes beside the real season: a folder it
			// calls a season, carrying no number, holding episodes that carry theirs.
			const bonus = item({
				id: 'bonus',
				externalId: 'jf-bonus',
				kind: MediaKind.SEASON,
				title: 'Saison inconnue',
				normalizedTitle: 'beyblade',
				parentId: 'series-1',
				parentExternalId: 'jf-series',
				seasonNumber: null,
				episodeNumber: null,
				file: null,
				childCount: 2,
			});

			return [series, seasonOne, bonus];
		};

		const episodeIn = (parentId: string, values: Partial<MediaItem>): MediaItem =>
			item({
				kind: MediaKind.EPISODE,
				normalizedTitle: 'beyblade',
				parentId,
				parentExternalId: 'jf-bonus',
				file: null,
				childCount: 0,
				...values,
			} as Partial<MediaItem>);

		it('moves every numbered episode under the season its number names', async () => {
			const world = tree();
			const first = episodeIn('bonus', {
				id: 'episode-1',
				externalId: 'jf-1',
				title: 'Premier',
				seasonNumber: 1,
				episodeNumber: 1,
			});
			const second = episodeIn('bonus', {
				id: 'episode-2',
				externalId: 'jf-2',
				title: 'Second',
				seasonNumber: 1,
				episodeNumber: 2,
			});
			const { manager } = build({ items: [...world, first, second] });

			expect(await manager.refileService('service-a')).toBe(2);
			expect(first.parentId).toBe('season-1');
			expect(second.parentId).toBe('season-1');
		});

		it('leaves an episode with no season number exactly where it is', async () => {
			// A real extra — a making-of, an interview — has nothing to file it by, and
			// sweeping it into season one would be inventing a fact rather than reading
			// one. It is also what keeps a folder of genuine bonuses on screen.
			const world = tree();
			const extra = episodeIn('bonus', {
				id: 'making-of',
				externalId: 'jf-making-of',
				title: 'Making-of',
				seasonNumber: null,
				episodeNumber: null,
			});
			const { manager } = build({ items: [...world, extra] });

			expect(await manager.refileService('service-a')).toBe(0);
			expect(extra.parentId).toBe('bonus');
		});

		it('writes the child counts of both ends, so the emptied folder stops being drawn', async () => {
			const world = tree();
			const moved = episodeIn('bonus', {
				id: 'episode-1',
				externalId: 'jf-1',
				title: 'Premier',
				seasonNumber: 1,
				episodeNumber: 1,
			});
			const { manager } = build({ items: [...world, moved] });

			await manager.refileService('service-a');

			const bonus = world.find((one) => one.id === 'bonus');
			const seasonOne = world.find((one) => one.id === 'season-1');

			expect(bonus?.childCount).toBe(0);
			expect(seasonOne?.childCount).toBe(1);
			// Kept rather than deleted: the service reports it, so a scan would write it
			// again on the next pass and the one after, taking its correlations with it
			// each time.
			expect(world.some((one) => one.id === 'bonus')).toBe(true);
		});

		it('leaves an episode alone when its series reports no season of that number', async () => {
			// Inventing a season here would be the gateway contradicting every server it
			// has, on nothing more than a number in a field. A correction says somebody
			// decided; a scan says nobody did.
			const world = tree();
			const stray = episodeIn('bonus', {
				id: 'episode-9',
				externalId: 'jf-9',
				title: 'Neuf',
				seasonNumber: 9,
				episodeNumber: 1,
			});
			const { manager } = build({ items: [...world, stray] });

			expect(await manager.refileService('service-a')).toBe(0);
			expect(stray.parentId).toBe('bonus');
		});

		it('writes nothing when every episode is already where its numbers say', async () => {
			const world = tree();
			const settled = episodeIn('season-1', {
				id: 'episode-1',
				externalId: 'jf-1',
				title: 'Premier',
				parentExternalId: 'jf-season-1',
				seasonNumber: 1,
				episodeNumber: 1,
			});
			const { manager, fakes } = build({ items: [...world, settled] });

			expect(await manager.refileService('service-a')).toBe(0);
			expect(fakes.items.update).not.toHaveBeenCalled();
		});

		it('files an episode hanging straight from its series, on a service with no season level', async () => {
			const world = tree();
			const flat = episodeIn('series-1', {
				id: 'episode-1',
				externalId: 'jf-1',
				title: 'Premier',
				parentExternalId: 'jf-series',
				seasonNumber: 1,
				episodeNumber: 1,
			});
			const { manager } = build({ items: [...world, flat] });

			expect(await manager.refileService('service-a')).toBe(1);
			expect(flat.parentId).toBe('season-1');
		});

		it('leaves an episode that hangs from nothing alone', async () => {
			const world = tree();
			const orphan = episodeIn('nowhere', {
				id: 'episode-1',
				externalId: 'jf-1',
				title: 'Premier',
				seasonNumber: 1,
				episodeNumber: 1,
			});
			const { manager } = build({ items: [...world, orphan] });

			expect(await manager.refileService('service-a')).toBe(0);
			expect(orphan.parentId).toBe('nowhere');
		});
	});

	describe('erasing a copy from the disk', () => {
		const unlinked: string[] = [];

		beforeEach(() => {
			unlinked.length = 0;
			mockUnlink.mockImplementation((path: string) => {
				unlinked.push(path);

				return Promise.resolve();
			});
		});

		const onDisk = (): MediaItem =>
			item({
				id: 'item-a',
				libraryId: 'library-a',
				file: file({ path: '/media/shows/Beyblade/S01E05.mkv' }),
			});

		it('erases the path the library mapping names, not the one the service reported', async () => {
			// Jellyfin says `/media/…` where this gateway sees `/mnt/media/…`. Unlinking
			// the reported path would erase nothing here and something else elsewhere.
			const { manager } = build({ items: [onDisk()] });

			expect(await manager.deleteFile('item-a')).toEqual({
				path: '/mnt/media/shows/Beyblade/S01E05.mkv',
			});
			expect(unlinked).toEqual(['/mnt/media/shows/Beyblade/S01E05.mkv']);
		});

		it('leaves the row exactly as it is, for the next scan to put right', async () => {
			// The media server still lists the file it no longer has. Writing `missing`
			// here would be the gateway asserting something about a server it has not
			// asked.
			const row = onDisk();
			const { manager, fakes } = build({ items: [row] });

			await manager.deleteFile('item-a');

			expect(row.file).not.toBeNull();
			expect(fakes.items.save).not.toHaveBeenCalled();
			expect(fakes.items.update).not.toHaveBeenCalled();
		});

		it('treats a file somebody had already removed as the state that was asked for', async () => {
			const { manager } = build({ items: [onDisk()] });

			mockUnlink.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

			await expect(manager.deleteFile('item-a')).resolves.toEqual({
				path: '/mnt/media/shows/Beyblade/S01E05.mkv',
			});
		});

		it('passes on a failure that is not the file being absent', async () => {
			const { manager } = build({ items: [onDisk()] });

			mockUnlink.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

			await expect(manager.deleteFile('item-a')).rejects.toThrow('denied');
		});

		it('refuses a row that carries no file at all', async () => {
			// A show, a season or a folder. Walking its subtree to erase what is under it
			// is a different feature, with a confirmation that says how many files.
			const { manager } = build({
				items: [item({ id: 'item-a', kind: MediaKind.SERIES, file: null })],
			});

			await expect(manager.deleteFile('item-a')).rejects.toThrow(ErrorKey.MEDIA_HAS_NO_FILE);
			expect(unlinked).toEqual([]);
		});

		it('refuses a copy on a server whose files are not mounted here', async () => {
			const { manager, fakes } = build({ items: [onDisk()] });

			fakes.services.findOne.mockResolvedValue(mediaService({ filesMounted: false }));

			await expect(manager.deleteFile('item-a')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_ON_OUR_DISK,
			);
			expect(unlinked).toEqual([]);
		});

		it('refuses a copy reached through a friend', async () => {
			const { manager, fakes } = build({ items: [onDisk()] });

			fakes.services.findOne.mockResolvedValue(mediaService({ peerId: 'peer-1' }));

			await expect(manager.deleteFile('item-a')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_ON_OUR_DISK,
			);
			expect(unlinked).toEqual([]);
		});

		it('refuses a path no mapping resolves rather than guessing at one', async () => {
			// The row and the mounts disagree, and erasing the wrong file is worse than
			// erasing none.
			const { manager, fakes } = build({ items: [onDisk()] });

			fakes.libraries.findOne.mockResolvedValue({
				id: 'library-a',
				localPath: '/mnt/media',
				paths: ['/somewhere-else'],
			});

			await expect(manager.deleteFile('item-a')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_ON_OUR_DISK,
			);
			expect(unlinked).toEqual([]);
		});
	});

	describe('artwork', () => {
		it('asks the service once and answers from the cache afterwards', async () => {
			// A grid of sixty posters is sixty requests from the browser, and without the
			// cache every one of them would reach somebody's Raspberry Pi.
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			const first = await manager.artwork('item-a');

			expect(first.contentType).toBe('image/jpeg');
			expect(first.body.toString()).toBe('poster bytes');

			const [key, stored] = fakes.cache.set.mock.calls[0] as [
				string,
				{ body: string; contentType: string },
			];

			fakes.cache.get.mockResolvedValue(stored);
			fakes.openArtwork.mockClear();

			const second = await manager.artwork('item-a');

			expect(key).toContain('item-a');
			expect(second.body.toString()).toBe('poster bytes');
			expect(fakes.openArtwork).not.toHaveBeenCalled();
		});

		it('asks with the token rather than anonymously', async () => {
			// Jellyfin serves images to anyone; Plex answers 401 without its token, and
			// every poster would be a broken image with nothing saying it was a
			// credential rather than a missing file.
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			await manager.artwork('item-a');

			expect(fakes.openArtwork.mock.calls[0][0]).toMatchObject({ token: 'plex-token' });
		});

		it('falls back to the row without secrets rather than failing', async () => {
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			fakes.services.findWithSecrets.mockResolvedValue(null);

			await expect(manager.artwork('item-a')).resolves.toMatchObject({
				contentType: 'image/jpeg',
			});
		});

		it('names a media type when the service gave none', async () => {
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			fakes.openArtwork.mockResolvedValue({
				stream: Readable.from([Buffer.from('bytes')]),
				contentType: null,
			});

			await expect(manager.artwork('item-a')).resolves.toMatchObject({
				contentType: 'application/octet-stream',
			});
		});

		it('answers a key when the service the item belongs to has gone', async () => {
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });

			fakes.services.findOne.mockResolvedValue(null);

			await expect(manager.artwork('item-a')).rejects.toThrow(ErrorKey.SERVICE_NOT_FOUND);
		});

		it('drops a response too large to be a poster', async () => {
			// Past the ceiling it is either a video somebody put in the poster field or a
			// service answering with the wrong thing entirely, and buffering it would be
			// the gateway spending its memory on somebody else's mistake.
			const { manager, fakes } = build({ items: [item({ artworkUrl: '/poster.jpg' })] });
			const megabyte = Buffer.alloc(1024 * 1024);

			fakes.openArtwork.mockResolvedValue({
				stream: Readable.from(Array.from({ length: 9 }, () => megabyte)),
				contentType: 'image/jpeg',
			});

			await expect(manager.artwork('item-a')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
			expect(fakes.cache.set).not.toHaveBeenCalled();
		});
	});

	describe('where the correlation runs', () => {
		it('hands the pass to a thread when there is one, and runs none of it here', async () => {
			// The reason this manager delegates at all: `better-sqlite3` is synchronous, so
			// a pass over a real catalogue does not slow this process, it stops it.
			const { manager, fakes } = build({ items: [item()] });

			fakes.workers.available = true;
			fakes.workers.run.mockResolvedValue(7);

			await expect(manager.correlateService('service-a')).resolves.toBe(7);

			expect(fakes.workers.run).toHaveBeenCalledWith(
				JobKind.CORRELATE,
				{ serviceId: 'service-a', threshold: 0.8 },
				// The reporter the pass's position comes back through, so a scan can draw it.
				expect.any(Function),
			);
			// Not both. A pass that ran on the thread and here again would write every row
			// twice and cost the stall this exists to remove.
			expect(fakes.correlation.correlate).not.toHaveBeenCalled();
		});

		it('runs the pass here when this process is the thread', async () => {
			// Which is what `available` says inside a worker, and what stops a thread
			// spawning a thread spawning a thread.
			const { manager, fakes } = build({ items: [item()] });

			fakes.correlation.correlate.mockResolvedValue(3);

			await expect(manager.correlateService('service-a')).resolves.toBe(3);

			expect(fakes.correlation.correlate).toHaveBeenCalledWith('service-a', 0.8, undefined);
			expect(fakes.workers.run).not.toHaveBeenCalled();
		});

		it('never swallows a thread that will not answer', async () => {
			// A worker that cannot start is a deployment that is broken. Falling back to
			// running it here would restore the stall and say nothing about why.
			const { manager, fakes } = build({ items: [item()] });

			fakes.workers.available = true;
			fakes.workers.run.mockRejectedValue(new Error('The worker exited with 1'));

			await expect(manager.correlateService('service-a')).rejects.toThrow('exited with 1');
			expect(fakes.correlation.correlate).not.toHaveBeenCalled();
		});
	});
});
