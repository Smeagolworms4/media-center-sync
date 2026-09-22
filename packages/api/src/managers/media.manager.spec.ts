import { Readable } from 'node:stream';
import {
	ErrorKey,
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
import {
	MatchingService,
	QualityService,
	type CacheService,
	type HandlerRegistry,
	type SettingsService,
} from '@/services';
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
	items: {
		find: jest.Mock;
		findOne: jest.Mock;
		findByExternalId: jest.Mock;
		findChildren: jest.Mock;
		findCandidatesForMatch: jest.Mock;
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
		upsertPair: jest.Mock;
		save: jest.Mock;
		delete: jest.Mock;
		deleteForItems: jest.Mock;
	};
	services: { find: jest.Mock; findOne: jest.Mock; findWithSecrets: jest.Mock };
	landings: { findOpen: jest.Mock };
	cache: { get: jest.Mock; set: jest.Mock };
	openArtwork: jest.Mock;
}

const build = (
	world: { items?: MediaItem[]; matches?: MediaMatch[] } = {},
): { manager: MediaManager; fakes: Fakes } => {
	const items = world.items ?? [];
	// The match table, seeded by the tests that are about what a pass does to rows it
	// finds already there rather than about the rows it writes.
	const pairs = world.matches ?? [];
	const fakes: Fakes = {
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
		// Nothing landed unless a test says so: an empty table is the ordinary state of
		// a gateway that is not mid-download, and every correlation rule here is about
		// what the services said rather than about what we downloaded.
		landings: { findOpen: jest.fn().mockResolvedValue([]) },
		openArtwork: jest.fn(async () => ({
			stream: Readable.from([Buffer.from('poster bytes')]),
			contentType: 'image/jpeg',
		})),
	};

	const manager = new MediaManager(
		fakes.items as unknown as MediaItemRepository,
		fakes.matches as unknown as MediaMatchRepository,
		fakes.services as unknown as MediaServiceRepository,
		fakes.landings as unknown as MediaLandingRepository,
		// The real scoring service: the rule under test is what the manager does with a
		// proposal, and a fake that produced one would prove nothing about the pair the
		// lab fixture is built around.
		new MatchingService(new QualityService()),
		{ getValue: jest.fn().mockResolvedValue(0.8) } as unknown as SettingsService,
		fakes.cache as unknown as CacheService,
		{ get: jest.fn(() => ({ openArtwork: fakes.openArtwork })) } as unknown as HandlerRegistry,
	);

	return { manager, fakes };
};

describe('MediaManager', () => {
	describe('labels that contradict the bytes', () => {
		it('calls the same file under two episode numbers a conflict, not a match', () => {
			const { manager } = build();

			const reason = manager.labelDisagreement(
				item(),
				item({ id: 'item-b', serviceId: 'service-b', episodeNumber: 3 }),
			);

			expect(reason).toBe(
				'content identical, episode numbers differ: S01E05 here, S01E03 there',
			);
		});

		it('names the season when that is what disagrees', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(item(), item({ id: 'item-b', seasonNumber: 2 })),
			).toBe('content identical, season numbers differ: S01E05 here, S02E05 there');
		});

		it('says nothing when the numbers agree, whatever the names are', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(item(), item({ id: 'item-b', title: 'BigBuckBunny INTERNAL' })),
			).toBeNull();
		});

		it('says nothing when the content differs: that is an ordinary comparison', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(
					item(),
					item({ id: 'item-b', episodeNumber: 3, file: file({ contentId: 'v1:other:999' }) }),
				),
			).toBeNull();
		});

		it('never calls two files the same on size alone', () => {
			const { manager } = build();

			expect(
				manager.labelDisagreement(
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
			const { manager, fakes } = build({ items: [here, there] });

			await manager.correlateService('service-a');

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

		it('records a mislabelled pair as a conflict a person has to settle', async () => {
			const here = item();
			const there = item({
				id: 'item-b',
				serviceId: 'service-b',
				externalId: 'b-3',
				episodeNumber: 3,
			});
			const { manager, fakes } = build({ items: [here, there] });

			await manager.correlateService('service-a');

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
			const { manager, fakes } = build({ items: [mine, theirs] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'service-a', filesMounted: true }),
				mediaService({ id: 'service-b', filesMounted: false, peerId: 'peer-1' }),
			]);

			await manager.correlateService('service-a');
			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-mine'],
				SyncState.LOCAL_ONLY,
			);

			fakes.items.setSyncState.mockClear();
			await manager.correlateService('service-b');
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
			const { manager, fakes } = build({ items: [theirs] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'service-b', filesMounted: false, peerId: 'peer-1' }),
			]);
			fakes.landings.findOpen.mockResolvedValue([
				{ itemId: 'item-theirs', state: MediaLandingState.WAITING },
			]);

			await manager.correlateService('service-b');

			expect(fakes.items.setSyncState).toHaveBeenCalledWith(
				['item-theirs'],
				SyncState.AWAITING_INDEX,
			);
		});

		it('says a landed file was never indexed once its landing has gone stale', async () => {
			const theirs = item({ id: 'item-theirs', serviceId: 'service-b' });
			const { manager, fakes } = build({ items: [theirs] });

			fakes.services.find.mockResolvedValue([
				mediaService({ id: 'service-b', filesMounted: false, peerId: 'peer-1' }),
			]);
			fakes.landings.findOpen.mockResolvedValue([
				{ itemId: 'item-theirs', state: MediaLandingState.STALE },
			]);

			await manager.correlateService('service-b');

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
			const { manager, fakes } = build({ items: [here, there] });

			fakes.landings.findOpen.mockResolvedValue([
				{ itemId: 'item-a', state: MediaLandingState.WAITING },
			]);

			await manager.correlateService('service-a');

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
				const { manager, fakes } = build({
					items: [here({ imdb: 'tt0386676' }), there({ imdb: 'tt0290978' })],
					matches: pairs,
				});

				await manager.correlateService('service-a');

				expect(fakes.matches.delete).toHaveBeenCalledWith({ id: 'match-title' });
				expect(pairs).toHaveLength(0);
				// And nothing was written back in its place: a pair nothing vouches for is
				// not a weaker match, it is not a match.
				expect(fakes.matches.upsertPair).not.toHaveBeenCalled();
			});

			it('upgrades a title guess into proof when the numbers agree', async () => {
				const { manager, fakes } = build({
					items: [here({ imdb: 'tt0417299' }), there({ imdb: 'tt0417299' })],
					matches: [titleMatch()],
				});

				await manager.correlateService('service-a');

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
				const { manager, fakes } = build({
					items: [here({ imdb: 'tt0417299' }), remote],
					matches: pairs,
				});

				// The work index cannot introduce these two — only one of them carries a
				// number — so the title lookup is what brings them together, exactly as it
				// did when the pair was first written.
				fakes.items.findCandidatesForMatch.mockResolvedValue([remote]);

				await manager.correlateService('service-a');

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
				const { manager, fakes } = build({
					// The identifiers say two different works, and a person said otherwise.
					items: [here({ imdb: 'tt0386676' }), there({ imdb: 'tt0290978' })],
					matches: pairs,
				});

				await manager.correlateService('service-a');

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
				const { manager, fakes } = build({
					items: [here({ imdb: 'tt0417299' }), there({ imdb: 'tt0417299' })],
					matches: [
						titleMatch({
							strategy: MatchStrategy.MANUAL,
							confidence: 1,
							confirmedAt: new Date('2026-02-01T00:00:00.000Z'),
						}),
					],
				});

				await manager.correlateService('service-a');

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
				const { manager, fakes } = build({
					items: [here({ imdb: 'tt0386676' }), there({ imdb: 'tt0290978' })],
					matches: pairs,
				});

				await manager.correlateService('service-a');
				await manager.correlateService('service-a');

				expect(fakes.matches.delete).toHaveBeenCalledTimes(1);
				expect(pairs).toHaveLength(0);
			});
		});

		it('never correlates an item with another row of its own service', async () => {
			const here = item();
			const twin = item({ id: 'item-a2', externalId: 'a-5-again' });
			const { manager, fakes } = build({ items: [here, twin] });

			await manager.correlateService('service-a');

			expect(fakes.matches.upsertPair).not.toHaveBeenCalled();
		});
	});

	/**
	 * A show published straight through against the same show cut into seasons.
	 *
	 * Tested through the manager rather than only through the alignment, because the
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
			const { manager, fakes } = build({
				items: [...runningShow(25), ...seasonedShow([13, 12])],
			});

			await manager.correlateService('service-a');

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
			const { manager, fakes } = build({
				items: [...runningShow(25), ...seasonedShow([13, 12])],
			});

			await manager.correlateService('service-b');

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
			const { manager, fakes } = build({
				items: [...runningShow(40), ...seasonedShow([13, 12])],
			});

			await manager.correlateService('service-a');

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
			const { manager, fakes } = build({ items: [...(left as MediaItem[]), ...right] });

			await manager.correlateService('service-a');

			expect(pairedWith(fakes, 'cut-s1e13')).toEqual([]);
		});

		it('leaves a series nothing has matched alone', async () => {
			const unrelated = seasonedShow([13, 12]).map((one) =>
				one.kind === MediaKind.SERIES
					? ({ ...one, title: 'Cowboy Bebop', normalizedTitle: 'cowboy bebop' } as MediaItem)
					: one,
			);
			const { manager, fakes } = build({ items: [...runningShow(25), ...unrelated] });

			await manager.correlateService('service-a');

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
			const { manager, fakes } = build({ items: [...running, ...seasoned] });

			await manager.correlateService('service-a');

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
			const { manager, fakes } = build({
				items: [...stamped(runningShow(40)), ...stamped(seasonedShow([13, 12]))],
			});

			await manager.correlateService('service-a');

			expect(pairedWith(fakes, 'run-e14')).toEqual([]);
		});
	});

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

			expect(fakes.items.findCandidatesForMatch).toHaveBeenCalled();
			expect(fakes.services.find).toHaveBeenCalled();
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
		it('files it back where the service says when the correction is withdrawn', async () => {
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

	describe('what counts as the same content', () => {
		it('recognises two files by a checksum when neither has a content identity', () => {
			const { manager } = build();
			const same = file({ contentId: null, checksum: 'sha256:abc' });

			expect(
				manager.labelDisagreement(
					item({ file: same }),
					item({ id: 'item-b', episodeNumber: 3, file: same }),
				),
			).toBe('content identical, episode numbers differ: S01E05 here, S01E03 there');
		});

		it('writes a question mark where a library told us nothing', () => {
			// A film carries no season or episode number, and a disagreement about one
			// still has to be readable rather than saying `SnullEnull`.
			const { manager } = build();
			const same = file();

			expect(
				manager.labelDisagreement(
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
			const { manager } = build();

			expect(
				manager.labelDisagreement(
					item({ kind: MediaKind.SERIES, file: null }),
					item({ id: 'item-b', kind: MediaKind.SERIES, episodeNumber: 3, file: null }),
				),
			).toBeNull();
		});
	});
});
