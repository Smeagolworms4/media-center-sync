import {
	MatchStrategy,
	MediaKind,
	MediaLandingState,
	MediaServiceType,
	SyncState,
	type MediaFileInfo,
} from '@mcs/shared';
import type { MediaItem, MediaMatch, MediaService as MediaServiceEntity } from '@/entities';
import type {
	MediaItemRepository,
	MediaLandingRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import { CorrelationService } from './correlation.service';
import { MatchingService } from './matching.service';
import { QualityService } from './quality.service';

/**
 * The threshold the gateway would have read from its settings.
 *
 * Handed in rather than mocked, which is the point of the signature: this class applies
 * a threshold and never decides one, so there is no setting to fake and no cache to
 * stand up. It is also what lets a worker thread build it — see `CorrelationService`.
 */
const THRESHOLD = 0.8;

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
	items: {
		find: jest.Mock;
		findForCorrelation: jest.Mock;
		findOne: jest.Mock;
		findCandidatesForMatch: jest.Mock;
		setSyncState: jest.Mock;
		save: jest.Mock;
	};
	matches: {
		find: jest.Mock;
		findAppliedPairs: jest.Mock;
		upsertPair: jest.Mock;
		delete: jest.Mock;
	};
	services: { find: jest.Mock };
	landings: { findOpen: jest.Mock };
}

const build = (
	world: { items?: MediaItem[]; matches?: MediaMatch[] } = {},
): { correlation: CorrelationService; fakes: Fakes } => {
	const items = world.items ?? [];
	// The match table, seeded by the tests that are about what a pass does to rows it
	// finds already there rather than about the rows it writes.
	const pairs = world.matches ?? [];
	const fakes: Fakes = {
		items: {
			find: jest.fn().mockResolvedValue(items),
			// The same rows, minus the columns a correlation pass never reads. The fake
			// hands back whole ones: what the projection is for is memory, not behaviour,
			// and a test that split them would be testing TypeORM.
			// Paged: the pass reads the catalogue a page at a time so that no single
			// statement holds the thread. The fake answers the slice it was asked for, and
			// an unpaged call the whole thing.
			findForCorrelation: jest.fn((skip = 0, take = 0) =>
				Promise.resolve(take > 0 ? items.slice(skip, skip + take) : items)),
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(items.find((candidate) => candidate.id === options.where.id) ?? null),
			),
			findCandidatesForMatch: jest.fn().mockResolvedValue([]),
			setSyncState: jest.fn().mockResolvedValue(undefined),
			save: jest.fn((value: MediaItem) => {
				if (!items.includes(value)) {
					items.push(value);
				}

				return Promise.resolve(value);
			}),
		},
		matches: {
			find: jest.fn().mockResolvedValue(pairs),
			// What is already paired, which is the gate the season/episode strategy opens
			// on. Empty unless a test says otherwise.
			findAppliedPairs: jest.fn().mockResolvedValue([]),
			upsertPair: jest.fn((claim: unknown) => Promise.resolve(claim as MediaMatch)),
			delete: jest.fn((where: { id: string }) => {
				const at = pairs.findIndex((pair) => pair.id === where.id);

				if (at >= 0) {
					pairs.splice(at, 1);
				}

				return Promise.resolve(undefined);
			}),
		},
		services: { find: jest.fn().mockResolvedValue([]) },
		// Nothing landed unless a test says so: an empty table is the ordinary state of
		// a gateway that is not mid-download, and every correlation rule here is about
		// what the services said rather than about what we downloaded.
		landings: { findOpen: jest.fn().mockResolvedValue([]) },
	};

	const correlation = new CorrelationService(
		fakes.items as unknown as MediaItemRepository,
		fakes.matches as unknown as MediaMatchRepository,
		fakes.services as unknown as MediaServiceRepository,
		fakes.landings as unknown as MediaLandingRepository,
		// The real scoring service: the rule under test is what the pass does with a
		// proposal, and a fake that produced one would prove nothing about the pair the
		// lab fixture is built around.
		new MatchingService(new QualityService()),
	);

	return { correlation, fakes };
};

describe('CorrelationService', () => {
	describe('labels that contradict the bytes', () => {
		it('calls the same file under two episode numbers a conflict, not a match', () => {
			const { correlation } = build();

			const reason = correlation.labelDisagreement(
				item(),
				item({ id: 'item-b', serviceId: 'service-b', episodeNumber: 3 }),
			);

			expect(reason).toBe(
				'content identical, episode numbers differ: S01E05 here, S01E03 there',
			);
		});

		it('names the season when that is what disagrees', () => {
			const { correlation } = build();

			expect(
				correlation.labelDisagreement(item(), item({ id: 'item-b', seasonNumber: 2 })),
			).toBe('content identical, season numbers differ: S01E05 here, S02E05 there');
		});

		it('says nothing when the numbers agree, whatever the names are', () => {
			const { correlation } = build();

			expect(
				correlation.labelDisagreement(item(), item({ id: 'item-b', title: 'BigBuckBunny INTERNAL' })),
			).toBeNull();
		});

		it('says nothing when the content differs: that is an ordinary comparison', () => {
			const { correlation } = build();

			expect(
				correlation.labelDisagreement(
					item(),
					item({ id: 'item-b', episodeNumber: 3, file: file({ contentId: 'v1:other:999' }) }),
				),
			).toBeNull();
		});

		it('never calls two files the same on size alone', () => {
			const { correlation } = build();

			expect(
				correlation.labelDisagreement(
					item({ file: file({ contentId: null, quickHash: null }) }),
					item({ id: 'item-b', episodeNumber: 3, file: file({ contentId: null, quickHash: null }) }),
				),
			).toBeNull();
		});
	});


	describe('correlating a service', () => {
		it('finds the pair a title comparison could never have reconciled', async () => {
			const here = item();
			const there = item({
				id: 'item-b',
				serviceId: 'service-b',
				libraryId: 'library-b',
				externalId: 'b-5',
				title: 'BigBuckBunny.S01E05.INTERNAL.1080p.x265-OTHER',
				normalizedTitle: 'bigbuckbunny s01e05 internal',
				year: null,
			});
			const { correlation, fakes } = build({ items: [here, there] });

			await correlation.correlate('service-a', THRESHOLD);

			// The title lookup answers with nothing; only the content identity brings the
			// two rows together, which is the whole argument for deriving one from the file.
			expect(fakes.items.findCandidatesForMatch).toHaveBeenCalled();
			expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
				expect.objectContaining({
					localItemId: 'item-a',
					remoteItemId: 'item-b',
					strategy: MatchStrategy.CHECKSUM,
				}),
			);
		});

		it('lets the gateway answer while it correlates', async () => {
			/*
			 * Correlation is the longest pass of a scan and it was the one with no yield in
			 * it. The walk handed the event loop back and this did not, so a scan stopped
			 * blocking for twenty minutes and started blocking in bursts of ten seconds —
			 * which looked fixed and was not. The test is the same one the walk has: a
			 * macrotask queued beforehand must get to run while the pass is still going.
			 */
			const items = Array.from({ length: 120 }, (_, index) =>
				item({ id: `row-${index}`, externalId: `a-${index}` }));
			const { correlation } = build({ items });

			let served = 0;
			const serving = setInterval(() => { served += 1; }, 0);

			await correlation.correlate('service-a', THRESHOLD);
			clearInterval(serving);

			// A timer is a macrotask, exactly like an inbound request.
			expect(served).toBeGreaterThan(0);
		});

		it('pairs seasons the two sides name differently, through their matched show', async () => {
			/*
			 * The failure a live catalogue showed, after the gate above was already fixed.
			 * A row has to be *offered* as a candidate before anything scores it, and the
			 * only offer a season of a request source gets is the title lookup — no file to
			 * be found by content, no identifier of its own. That lookup compares normalised
			 * titles for equality, and the two sides disagree for an ordinary reason: the
			 * provider says "Marvel's Runaways" and the library says "Runaways".
			 *
			 * The series does not care, because it matches on an identifier both carry. Its
			 * seasons have none, so they were never put in front of each other: a series
			 * held in full came out with every season duplicated and counted missing.
			 */
			const here = item({
				id: 'season-a',
				kind: MediaKind.SEASON,
				parentId: 'series-a',
				seasonNumber: 2,
				episodeNumber: null,
				normalizedTitle: 'runaways',
				file: null,
				externalIds: {},
			});
			const there = item({
				id: 'season-b',
				serviceId: 'service-b',
				libraryId: 'library-b',
				externalId: 'b-s2',
				kind: MediaKind.SEASON,
				parentId: 'series-b',
				seasonNumber: 2,
				episodeNumber: null,
				// The provider's name for the same show, which is why the title lookup
				// answers nothing and why this test exists.
				normalizedTitle: 'marvels runaways',
				file: null,
				externalIds: {},
			});
			const { correlation, fakes } = build({ items: [here, there] });

			// Nothing offers them to each other: the titles differ and neither has a file.
			fakes.items.findCandidatesForMatch.mockResolvedValue([]);
			fakes.matches.findAppliedPairs.mockResolvedValue([
				{ localItemId: 'series-a', remoteItemId: 'series-b', state: SyncState.IN_SYNC },
			]);

			await correlation.correlate('service-a', THRESHOLD);

			expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
				expect.objectContaining({
					localItemId: 'season-a',
					remoteItemId: 'season-b',
					strategy: MatchStrategy.SEASON_EPISODE,
				}),
			);
		});

		it('never offers a season its own siblings as candidates', async () => {
			/*
			 * The regression the first version of that discovery caused, seen on a live
			 * catalogue: three seasons of a show collapsed into one. Every season carries
			 * the *show's* normalised title, so offering season one the other seasons let
			 * the title strategy pair all three together. The title lookup this stands
			 * beside has always constrained the coordinate; this has to as well.
			 */
			const one = item({
				id: 'season-1', kind: MediaKind.SEASON, parentId: 'series-a',
				seasonNumber: 1, episodeNumber: null, normalizedTitle: 'runaways',
				file: null, externalIds: {},
			});
			const two = item({
				id: 'season-2', serviceId: 'service-b', libraryId: 'library-b', externalId: 'b-s2',
				kind: MediaKind.SEASON, parentId: 'series-b',
				seasonNumber: 2, episodeNumber: null, normalizedTitle: 'runaways',
				file: null, externalIds: {},
			});
			const { correlation, fakes } = build({ items: [one, two] });

			fakes.items.findCandidatesForMatch.mockResolvedValue([]);
			fakes.matches.findAppliedPairs.mockResolvedValue([
				{ localItemId: 'series-a', remoteItemId: 'series-b', state: SyncState.IN_SYNC },
			]);

			await correlation.correlate('service-a', THRESHOLD);

			// Season one and season two are not the same season, whatever they are called.
			expect(fakes.matches.upsertPair).not.toHaveBeenCalledWith(
				expect.objectContaining({ localItemId: 'season-1', remoteItemId: 'season-2' }),
			);
		});

		it('pairs two episodes by their place in a show, once the show is paired', async () => {
			/*
			 * The strategy that never once fired. `MatchingService` reads a map of which
			 * rows are already paired to gate this — "every library has an S01E02, and
			 * matching on it alone would correlate the second episode of every series with
			 * the second of every other" — and no caller ever built one. The option
			 * existed, the service was unit-tested against it, and the gate was shut on
			 * every real correlation this product has ever run.
			 *
			 * What it cost: a source that enumerates a series by season and episode without
			 * an identifier per episode — a request source — could never be joined to the
			 * copies on a shelf, so a complete series read as a wall of missing episodes.
			 */
			const here = item({ id: 'ep-a', parentId: 'season-a', file: null, externalIds: {} });
			const there = item({
				id: 'ep-b',
				serviceId: 'service-b',
				libraryId: 'library-b',
				externalId: 'b-5',
				parentId: 'season-b',
				file: null,
				externalIds: {},
			});
			const { correlation, fakes } = build({ items: [here, there] });

			// Neither row has a file or an identifier, so nothing but the title lookup can
			// offer one as a candidate for the other — which is exactly the case this
			// strategy exists for.
			fakes.items.findCandidatesForMatch.mockResolvedValue([there]);
			// The seasons are already paired, which is the only thing that makes two
			// `S01E05` rows the same episode rather than a coincidence.
			fakes.matches.findAppliedPairs.mockResolvedValue([
				{ localItemId: 'season-a', remoteItemId: 'season-b', state: SyncState.IN_SYNC },
			]);

			await correlation.correlate('service-a', THRESHOLD);

			expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
				expect.objectContaining({
					localItemId: 'ep-a',
					remoteItemId: 'ep-b',
					strategy: MatchStrategy.SEASON_EPISODE,
				}),
			);
		});

		it('refuses the same two episodes when nothing above them is paired', async () => {
			// The other half of the rule, and the reason the gate exists at all: without a
			// paired parent these numbers say nothing, and every `S01E05` in the catalogue
			// would be the same episode.
			const here = item({ id: 'ep-a', parentId: 'season-a', file: null, externalIds: {} });
			const there = item({
				id: 'ep-b',
				serviceId: 'service-b',
				libraryId: 'library-b',
				externalId: 'b-5',
				parentId: 'season-b',
				file: null,
				externalIds: {},
			});
			const { correlation, fakes } = build({ items: [here, there] });

			fakes.items.findCandidatesForMatch.mockResolvedValue([there]);

			await correlation.correlate('service-a', THRESHOLD);

			expect(fakes.matches.upsertPair).not.toHaveBeenCalledWith(
				expect.objectContaining({ strategy: MatchStrategy.SEASON_EPISODE }),
			);
		});

		it('records a mislabelled pair as a conflict a person has to settle', async () => {
			const here = item();
			const there = item({
				id: 'item-b',
				serviceId: 'service-b',
				externalId: 'b-3',
				episodeNumber: 3,
			});
			const { correlation, fakes } = build({ items: [here, there] });

			await correlation.correlate('service-a', THRESHOLD);

			expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
				expect.objectContaining({
					state: SyncState.CONFLICT,
					reason: 'content identical, episode numbers differ: S01E05 here, S01E03 there',
				}),
			);
			expect(fakes.items.setSyncState).toHaveBeenCalledWith(['item-a'], SyncState.CONFLICT);
		});

		it('tells an item we hold from one we merely know about', async () => {
			// With nothing to match against, an item on a service the gateway can write
			// into is `local_only` and one on a friend's is `missing`. Getting the scope
			// wrong here turns the whole library into a list of things to fetch.
			const mine = item({ id: 'item-mine', serviceId: 'service-a' });
			const theirs = item({
				id: 'item-theirs',
				serviceId: 'service-b',
				file: file({ contentId: 'v1:other:1', checksum: null }),
			});
			const { correlation, fakes } = build({ items: [mine, theirs] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'service-a', filesMounted: true }),
				mediaService({ id: 'service-b', filesMounted: false, peerId: 'peer-1' }),
			]);

			await correlation.correlate('service-a', THRESHOLD);
			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-mine'],
				SyncState.LOCAL_ONLY,
			);

			fakes.items.setSyncState.mockClear();
			await correlation.correlate('service-b', THRESHOLD);
			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-theirs'],
				SyncState.MISSING,
			);
		});

		it('keeps a media the gateway has just downloaded out of missing', async () => {
			/*
			 * Correlation recomputes every state from scratch, so it is the one place
			 * that can undo a landing — and it did, on the first scan after a download,
			 * putting the file back on the list of things to fetch while it sat in the
			 * library folder.
			 */
			const theirs = item({ id: 'item-theirs', serviceId: 'service-b' });
			const { correlation, fakes } = build({ items: [theirs] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'service-b', filesMounted: false, peerId: 'peer-1' }),
			]);
			fakes.landings.findOpen.mockResolvedValue([
				{ itemId: 'item-theirs', state: MediaLandingState.WAITING },
			]);

			await correlation.correlate('service-b', THRESHOLD);

			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-theirs'],
				SyncState.AWAITING_INDEX,
			);
		});

		it('says a landed file was never indexed once its landing has gone stale', async () => {
			const theirs = item({ id: 'item-theirs', serviceId: 'service-b' });
			const { correlation, fakes } = build({ items: [theirs] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'service-b', filesMounted: false, peerId: 'peer-1' }),
			]);
			fakes.landings.findOpen.mockResolvedValue([
				{ itemId: 'item-theirs', state: MediaLandingState.STALE },
			]);

			await correlation.correlate('service-b', THRESHOLD);

			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-theirs'],
				SyncState.NOT_INDEXED,
			);
		});

		it('never lets a landing overrule what comparing two real copies decided', async () => {
			// A landing knows one thing: bytes are on the disk. `conflict` was reached by
			// comparing files, and replacing it with a note about a download would hide
			// the disagreement somebody has to settle.
			const here = item();
			const there = item({
				id: 'item-b',
				serviceId: 'service-b',
				externalId: 'b-3',
				episodeNumber: 3,
			});
			const { correlation, fakes } = build({ items: [here, there] });

			fakes.landings.findOpen.mockResolvedValue([
				{ itemId: 'item-a', state: MediaLandingState.WAITING },
			]);

			await correlation.correlate('service-a', THRESHOLD);

			expect(fakes.items.setSyncState).toHaveBeenCalledWith(['item-a'], SyncState.CONFLICT);
		});

		/**
		 * What a second pass makes of the pairs the first one left behind.
		 *
		 * Reading Plex's identifiers only ever helps the pairs correlated after the
		 * reading. Everything already on the owner's gateway was decided when a Plex item
		 * carried nothing but its own row key, which made every Plex-to-Jellyfin pair a
		 * title guess — so the feature has to re-open the decisions it made blind, or it
		 * changes nothing on the only catalogue that matters.
		 *
		 * The film in these tests is deliberately the hard one: two works that share a
		 * title exactly, which is precisely what identifiers exist to separate.
		 */
		describe('re-correlating pairs decided before the identifiers arrived', () => {
			const film = (overrides: Partial<MediaItem> = {}): MediaItem =>
				item({
					kind: MediaKind.MOVIE,
					title: 'The Office',
					normalizedTitle: 'office',
					seasonNumber: null,
					episodeNumber: null,
					year: null,
					file: null,
					...overrides,
				});

			const here = (externalIds: Record<string, string> = {}): MediaItem =>
				film({ id: 'item-a', serviceId: 'service-a', externalIds } as Partial<MediaItem>);

			const there = (externalIds: Record<string, string> = {}): MediaItem =>
				film({
					id: 'item-b',
					serviceId: 'service-b',
					libraryId: 'library-b',
					externalId: 'b-1',
					externalIds,
				} as Partial<MediaItem>);

			const titleMatch = (overrides: Partial<MediaMatch> = {}): MediaMatch =>
				match({
					id: 'match-title',
					localItemId: 'item-a',
					remoteItemId: 'item-b',
					strategy: MatchStrategy.NORMALIZED_TITLE,
					confidence: 0.75,
					...overrides,
				});

			it('revokes a title match the two identifiers now contradict', async () => {
				const pairs = [titleMatch()];
				const { correlation, fakes } = build({
					items: [here({ imdb: 'tt0386676' }), there({ imdb: 'tt0290978' })],
					matches: pairs,
				});

				await correlation.correlate('service-a', THRESHOLD);

				expect(fakes.matches.delete).toHaveBeenCalledWith({ id: 'match-title' });
				expect(pairs).toHaveLength(0);
				// And nothing was written back in its place: a pair nothing vouches for is
				// not a weaker match, it is not a match.
				expect(fakes.matches.upsertPair).not.toHaveBeenCalled();
			});

			/**
			 * The rule that stopped firing, and the rows it had to take with it.
			 *
			 * An episode used to be matched on an identifier shared with every other
			 * episode of its show. That is refused now — but the two sides still name the
			 * same *series*, so nothing contradicts them and the check above kept every
			 * wrong pair. A whole show read as held, a re-scan said the same thing, and
			 * the only way out was emptying the database.
			 */
			it('revokes a pair the rules no longer support at all', async () => {
				const episode = (overrides: Partial<MediaItem> = {}): MediaItem =>
					item({
						kind: MediaKind.EPISODE,
						title: 'Mine',
						normalizedTitle: 'mine',
						// The show's own number, stamped onto the episode — which is what
						// very many servers do, and what this used to believe.
						externalIds: { tvdb: '432104' },
						seasonNumber: null,
						episodeNumber: null,
						year: null,
						file: null,
						...overrides,
					} as Partial<MediaItem>);

				const pairs = [
					match({
						id: 'match-series-id',
						localItemId: 'item-a',
						remoteItemId: 'item-b',
						strategy: MatchStrategy.EXTERNAL_ID,
						confidence: 0.9,
					}),
				];
				const { correlation, fakes } = build({
					items: [
						episode({ id: 'item-a', serviceId: 'service-a' }),
						episode({
							id: 'item-b',
							serviceId: 'service-b',
							libraryId: 'library-b',
							externalId: 'b-1',
							title: 'Theirs',
							normalizedTitle: 'theirs',
						}),
					],
					matches: pairs,
				});

				await correlation.correlate('service-a', THRESHOLD);

				expect(fakes.matches.delete).toHaveBeenCalledWith({ id: 'match-series-id' });
				expect(pairs).toHaveLength(0);
			});

			it('upgrades a title guess into proof when the numbers agree', async () => {
				const { correlation, fakes } = build({
					items: [here({ imdb: 'tt0417299' }), there({ imdb: 'tt0417299' })],
					matches: [titleMatch()],
				});

				await correlation.correlate('service-a', THRESHOLD);

				expect(fakes.matches.delete).not.toHaveBeenCalled();
				expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
					expect.objectContaining({
						localItemId: 'item-a',
						remoteItemId: 'item-b',
						strategy: MatchStrategy.EXTERNAL_ID,
						// Above the 0.8 threshold the fake settings answer, which is what
						// moves the pair from proposed to applied.
						applied: true,
					}),
				);
			});

			it('leaves a pair alone when only one side ever carried a number', async () => {
				// One library scrapes and the other does not, which is the ordinary house.
				// Absence is not disagreement, and treating it as one would revoke every
				// correct match somebody has.
				const pairs = [titleMatch()];
				const remote = there();
				const { correlation, fakes } = build({
					items: [here({ imdb: 'tt0417299' }), remote],
					matches: pairs,
				});

				// The work index cannot introduce these two — only one of them carries a
				// number — so the title lookup is what brings them together, exactly as it
				// did when the pair was first written.
				fakes.items.findCandidatesForMatch.mockResolvedValue([remote]);

				await correlation.correlate('service-a', THRESHOLD);

				expect(fakes.matches.delete).not.toHaveBeenCalled();
				expect(pairs).toHaveLength(1);
				expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
					expect.objectContaining({ strategy: MatchStrategy.NORMALIZED_TITLE }),
				);
			});

			it('never overrules a pair somebody decided by hand', async () => {
				const pairs = [
					titleMatch({
						id: 'match-manual',
						strategy: MatchStrategy.MANUAL,
						confidence: 1,
						confirmedAt: new Date('2026-02-01T00:00:00.000Z'),
					}),
				];
				const { correlation, fakes } = build({
					// The identifiers say two different works, and a person said otherwise.
					items: [here({ imdb: 'tt0386676' }), there({ imdb: 'tt0290978' })],
					matches: pairs,
				});

				await correlation.correlate('service-a', THRESHOLD);

				expect(fakes.matches.delete).not.toHaveBeenCalled();
				expect(pairs).toHaveLength(1);
			});

			it('keeps a confirmation while still refreshing what the two copies are', async () => {
				/*
				 * The two halves of a row answer two different questions. Whether these are
				 * the same media is the person's answer and is restored; what state the two
				 * copies are in is measured and is not, or a confirmed pair would report a
				 * quality comparison from the day it was confirmed for ever.
				 */
				const { correlation, fakes } = build({
					items: [here({ imdb: 'tt0417299' }), there({ imdb: 'tt0417299' })],
					matches: [
						titleMatch({
							strategy: MatchStrategy.MANUAL,
							confidence: 1,
							confirmedAt: new Date('2026-02-01T00:00:00.000Z'),
						}),
					],
				});

				await correlation.correlate('service-a', THRESHOLD);

				expect(fakes.matches.upsertPair).toHaveBeenCalledWith(
					expect.objectContaining({
						strategy: MatchStrategy.MANUAL,
						confidence: 1,
						applied: true,
						// Measured, not remembered: two copies with nothing to tell them
						// apart are in sync, and that half of the row keeps moving.
						state: SyncState.IN_SYNC,
					}),
				);
			});

			it('runs twice without doing anything the second time', async () => {
				// A revocation has to be safe to repeat: whoever re-scans a service twice
				// in a row must not get a different answer the second time.
				const pairs = [titleMatch()];
				const { correlation, fakes } = build({
					items: [here({ imdb: 'tt0386676' }), there({ imdb: 'tt0290978' })],
					matches: pairs,
				});

				await correlation.correlate('service-a', THRESHOLD);
				await correlation.correlate('service-a', THRESHOLD);

				expect(fakes.matches.delete).toHaveBeenCalledTimes(1);
				expect(pairs).toHaveLength(0);
			});
		});

		it('correlates two rows of one service, which is how a second cut is found', async () => {
			/*
			 * This used to be refused, in two places — here and in the scoring — and
			 * lifting only one changed nothing, because a candidate dropped here is never
			 * scored at all.
			 *
			 * The owner keeps two cuts of a show on one Jellyfin, `HD - VOST` beside
			 * `SD`. They were two unrelated series, and filing episodes under the season
			 * their numbers name then stacked both into the same seasons: forty-eight
			 * episodes in a season of twenty-four, each of them twice.
			 */
			const here = item();
			const twin = item({ id: 'item-a2', externalId: 'a-5-again' });
			const { correlation, fakes } = build({ items: [here, twin] });

			await correlation.correlate('service-a', THRESHOLD);

			expect(fakes.matches.upsertPair).toHaveBeenCalled();
		});

		it('never correlates a row with itself', async () => {
			const alone = item();
			const { correlation, fakes } = build({ items: [alone] });

			await correlation.correlate('service-a', THRESHOLD);

			expect(fakes.matches.upsertPair).not.toHaveBeenCalled();
		});
	});

	/**
	 * A show published straight through against the same show cut into seasons.
	 *
	 * Tested through the pass rather than only through the alignment, because the
	 * half that is easy to get wrong lives here: nothing in the candidate lookup would
	 * ever put `E153` and `S06E12` side by side — it joins on the title and on the
	 * episode coordinates, and neither agrees — so a correct conversion with no
	 * candidate to apply it to would pass every unit test and change nothing.
	 */

	describe('a series numbered straight through', () => {
		/** A show as one continuous run of `count` episodes under its own series row. */
		const runningShow = (count: number): MediaItem[] => [
			item({
				id: 'run-series',
				serviceId: 'service-a',
				libraryId: 'library-a',
				externalId: 'a-series',
				kind: MediaKind.SERIES,
				parentId: null,
				title: 'Dragon Ball',
				normalizedTitle: 'dragon ball',
				year: 1986,
				seasonNumber: null,
				episodeNumber: null,
				file: null,
			}),
			...Array.from({ length: count }, (_, index) =>
				item({
					id: `run-e${index + 1}`,
					serviceId: 'service-a',
					libraryId: 'library-a',
					externalId: `a-e${index + 1}`,
					parentId: 'run-series',
					title: `Episode ${index + 1}`,
					normalizedTitle: `episode ${index + 1}`,
					year: null,
					seasonNumber: 1,
					episodeNumber: index + 1,
					file: null,
				}),
			),
		];

		/** The same show as seasons of the given lengths, with a season row each. */
		const seasonedShow = (lengths: number[]): MediaItem[] => [
			item({
				id: 'cut-series',
				serviceId: 'service-b',
				libraryId: 'library-b',
				externalId: 'b-series',
				kind: MediaKind.SERIES,
				parentId: null,
				title: 'Dragon Ball',
				normalizedTitle: 'dragon ball',
				year: 1986,
				seasonNumber: null,
				episodeNumber: null,
				file: null,
			}),
			...lengths.flatMap((length, index) => [
				item({
					id: `cut-s${index + 1}`,
					serviceId: 'service-b',
					libraryId: 'library-b',
					externalId: `b-s${index + 1}`,
					kind: MediaKind.SEASON,
					parentId: 'cut-series',
					title: `Season ${index + 1}`,
					normalizedTitle: `season ${index + 1}`,
					year: null,
					seasonNumber: index + 1,
					episodeNumber: null,
					file: null,
				}),
				...Array.from({ length }, (_, position) =>
					item({
						id: `cut-s${index + 1}e${position + 1}`,
						serviceId: 'service-b',
						libraryId: 'library-b',
						externalId: `b-s${index + 1}e${position + 1}`,
						parentId: `cut-s${index + 1}`,
						title: `Chapter ${position + 1}`,
						normalizedTitle: `chapter ${position + 1}`,
						year: null,
						seasonNumber: index + 1,
						episodeNumber: position + 1,
						file: null,
					}),
				),
			]),
		];

		const pairedWith = (fakes: Fakes, localItemId: string): unknown[] =>
			fakes.matches.upsertPair.mock.calls
				.map(([claim]) => claim as { localItemId: string })
				.filter((claim) => claim.localItemId === localItemId);

		it('relates an absolute number to the season and episode it falls in', async () => {
			const { correlation, fakes } = build({
				items: [...runningShow(25), ...seasonedShow([13, 12])],
			});

			await correlation.correlate('service-a', THRESHOLD);

			expect(pairedWith(fakes, 'run-e14')).toEqual([
				expect.objectContaining({
					remoteItemId: 'cut-s2e1',
					strategy: MatchStrategy.ABSOLUTE_EPISODE,
					applied: true,
				}),
			]);
			expect(pairedWith(fakes, 'run-e25')).toEqual([
				expect.objectContaining({ remoteItemId: 'cut-s2e12' }),
			]);
		});

		it('relates them the same way from the side that has the seasons', async () => {
			const { correlation, fakes } = build({
				items: [...runningShow(25), ...seasonedShow([13, 12])],
			});

			await correlation.correlate('service-b', THRESHOLD);

			expect(pairedWith(fakes, 'cut-s2e1')).toEqual([
				expect.objectContaining({
					remoteItemId: 'run-e14',
					strategy: MatchStrategy.ABSOLUTE_EPISODE,
				}),
			]);
		});

		it('pairs nothing when the two sides do not account for the same show', async () => {
			// Forty episodes against twenty-five. The season lengths in hand may belong
			// to a neighbouring cut, and a near miss is exactly what that looks like.
			const { correlation, fakes } = build({
				items: [...runningShow(40), ...seasonedShow([13, 12])],
			});

			await correlation.correlate('service-a', THRESHOLD);

			expect(pairedWith(fakes, 'run-e14')).toEqual([]);
		});

		it('pairs nothing when both sides number by season and disagree', async () => {
			// Neither side is a continuous run, so there is no convention to convert
			// between: the numbers are the evidence and they say these differ.
			const left = seasonedShow([13, 12]).map((one) => ({ ...one, serviceId: 'service-a' }));
			const right = seasonedShow([12, 13]).map((one) => ({
				...one,
				id: `alt-${one.id}`,
				parentId: one.parentId === null ? null : `alt-${one.parentId}`,
				externalId: `alt-${one.externalId}`,
			})) as MediaItem[];
			const { correlation, fakes } = build({ items: [...(left as MediaItem[]), ...right] });

			await correlation.correlate('service-a', THRESHOLD);

			expect(pairedWith(fakes, 'cut-s1e13')).toEqual([]);
		});

		it('leaves a series nothing has matched alone', async () => {
			const unrelated = seasonedShow([13, 12]).map((one) =>
				one.kind === MediaKind.SERIES
					? ({ ...one, title: 'Cowboy Bebop', normalizedTitle: 'cowboy bebop' } as MediaItem)
					: one,
			);
			const { correlation, fakes } = build({ items: [...runningShow(25), ...unrelated] });

			await correlation.correlate('service-a', THRESHOLD);

			expect(pairedWith(fakes, 'run-e14')).toEqual([]);
		});

		it('lets an episode identifier pair the two numberings on its own', async () => {
			// Rule one, end to end: each episode carries its own number, so no arithmetic
			// is needed and the pair is recorded as the identifier it came from.
			const running = runningShow(25).map((one, index) =>
				one.kind === MediaKind.SERIES ? one : ({ ...one, externalIds: { tvdb: `e${index}` } } as MediaItem),
			);
			const seasoned = seasonedShow([13, 12]).map((one) =>
				one.kind !== MediaKind.EPISODE
					? one
					: ({
						...one,
						externalIds: {
							tvdb: `e${((one.seasonNumber as number) === 1 ? 0 : 13) + (one.episodeNumber as number)}`,
						},
					} as MediaItem),
			);
			const { correlation, fakes } = build({ items: [...running, ...seasoned] });

			await correlation.correlate('service-a', THRESHOLD);

			expect(pairedWith(fakes, 'run-e14')).toEqual([
				expect.objectContaining({
					remoteItemId: 'cut-s2e1',
					strategy: MatchStrategy.EXTERNAL_ID,
				}),
			]);
		});

		it('refuses to pair on the show identifier every episode was stamped with', async () => {
			// The trap. Both sides carry `81472` on all twenty-five rows, which says which
			// show they are and nothing about which episode. Without the numbering
			// conversion underneath, `E14` would have to stay unrelated rather than be
			// paired with whichever row the lookup handed over first.
			const stamped = (rows: MediaItem[]): MediaItem[] =>
				rows.map((one) =>
					one.kind === MediaKind.EPISODE
						? ({ ...one, externalIds: { tvdb: '81472' } } as MediaItem)
						: one,
				);
			const { correlation, fakes } = build({
				items: [...stamped(runningShow(40)), ...stamped(seasonedShow([13, 12]))],
			});

			await correlation.correlate('service-a', THRESHOLD);

			expect(pairedWith(fakes, 'run-e14')).toEqual([]);
		});
	});


	describe('what counts as the same content', () => {
		it('recognises two files by a checksum when neither has a content identity', () => {
			const { correlation } = build();
			const same = file({ contentId: null, checksum: 'sha256:abc' });

			expect(
				correlation.labelDisagreement(
					item({ file: same }),
					item({ id: 'item-b', episodeNumber: 3, file: same }),
				),
			).toBe('content identical, episode numbers differ: S01E05 here, S01E03 there');
		});

		it('writes a question mark where a library told us nothing', () => {
			// A film carries no season or episode number, and a disagreement about one
			// still has to be readable rather than saying `SnullEnull`.
			const { correlation } = build();
			const same = file();

			expect(
				correlation.labelDisagreement(
					item({ kind: MediaKind.MOVIE, seasonNumber: null, episodeNumber: null, file: same }),
					item({
						id: 'item-b',
						kind: MediaKind.MOVIE,
						seasonNumber: 1,
						episodeNumber: null,
						file: same,
					}),
				),
			).toBe('content identical, season numbers differ: S??E?? here, S01E?? there');
		});

		it('says nothing about a node that holds no file at all', () => {
			// A series and a season have no bytes of their own, and comparing them by
			// content would make every parent identical to every other.
			const { correlation } = build();

			expect(
				correlation.labelDisagreement(
					item({ kind: MediaKind.SERIES, file: null }),
					item({ id: 'item-b', kind: MediaKind.SERIES, episodeNumber: 3, file: null }),
				),
			).toBeNull();
		});
	});

	describe('saying where it has got to', () => {
		it('reports every two hundred rows, and the last one whatever the total', async () => {
			/*
			 * The cadence lives here rather than at either call site, and that is the fix:
			 * the worker throttled its own messages while the in-process path called the
			 * reporter once per row, so the same pass spoke once per two hundred or tens of
			 * thousands of times depending on where it happened to run. On a real catalogue
			 * the second is a structured clone per row, pushed to every open browser, to
			 * move a bar by a pixel.
			 */
			const mine = Array.from({ length: 450 }, (_, at) =>
				item({ id: `mine-${at}`, externalId: `a-${at}`, episodeNumber: at + 1 }));
			const { correlation } = build({ items: mine });
			const seen: number[] = [];

			await correlation.correlate('service-a', THRESHOLD, (done) => {
				seen.push(done);
			});

			expect(seen).toEqual([200, 400, 450]);
		});

		it('says nothing to a caller that asked for nothing', async () => {
			// The reporter is optional, and a pass nobody is watching must not pay for one.
			const { correlation } = build({ items: [item()] });

			await expect(correlation.correlate('service-a', THRESHOLD)).resolves.toBe(0);
		});
	});
});
