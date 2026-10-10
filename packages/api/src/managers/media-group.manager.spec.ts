import {
	ActionableReason,
	CacheRefreshReason,
	MatchStrategy,
	MediaKind,
	MediaResolution,
	MediaServiceType,
	MediaWatchState,
	NewsSignal,
	SyncState,
	type MediaFileInfo,
	type MediaGroupQuery,
	type QualitySummary,
} from '@mcs/shared';
import type { MediaItem, MediaService, Peer, SyncPlan } from '@/entities';
import type {
	MediaItemDigest,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
	PeerRepository,
	SyncPlanRepository,
	GroupSeedQuery,
	MatchPair,
} from '@/repositories';
import {
	type CatalogueCacheService,
	CatalogueProjectionService,
	QualityService,
	type SettingsService,
	SIGHTED_FRESH_FOR,
	type WorkerPoolService,
} from '@/services';
import { JobKind } from '@/worker/protocol';
import type { LibraryManager } from './library.manager';
import { MediaGroupManager } from './media-group.manager';

/** One correlation as the table holds it, before anything decides whether it applies. */
interface Correlation {
	localItemId: string | null;
	remoteItemId: string;
	strategy: MatchStrategy;
	confidence: number;
	state: SyncState;
	confirmedAt: Date | null;
}

const file = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
	path: '/library/Big Buck Bunny - S01E01 - 1080p.mp4',
	size: 1_048_576,
	container: 'mp4',
	videoCodec: 'hevc',
	audioCodec: 'aac',
	width: 1920,
	height: 1080,
	durationMs: 4000,
	bitrate: 2_000_000,
	quickHash: null,
	contentId: null,
	checksum: null,
	...overrides,
});

const item = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'item',
		serviceId: 'local',
		libraryId: 'library-local',
		externalId: 'x',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'The Flight',
		normalizedTitle: 'big buck bunny the flight',
		year: 2008,
		seasonNumber: 1,
		episodeNumber: 1,
		episodeNumberEnd: null,
		externalIds: {},
		overview: null,
		artworkUrl: null,
		file: file(),
		quality: null,
		syncState: SyncState.IN_SYNC,
		ignored: false,
		addedAt: null,
		childCount: 0,
		// Nothing seen, which is what most of the catalogue says: the watch looks at a
		// batch of followed shows per pass, so a default of "seen" would make every
		// fixture in this file fetchable and prove the filter against nothing.
		releaseSeenAt: null,
		copySeenAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaItem;

const service = (overrides: Partial<MediaService> = {}): MediaService =>
	({
		id: 'local',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		filesMounted: true,
		baseUrl: 'http://127.0.0.1:8096',
		priority: 100,
		peerId: null,
		...overrides,
	}) as MediaService;

/**
 * The summary a scan writes onto a row, built by the service that writes the real one.
 *
 * Never a hand-written literal: the resolution and the codec in there are *derived*
 * values, and a test that spelled them itself would pass while the filter matched
 * something the gateway never stores.
 */
const summarised = (...files: MediaFileInfo[]): QualitySummary =>
	new QualityService().summarise(files);

const plan = (overrides: Partial<SyncPlan> = {}): SyncPlan =>
	({
		id: 'plan',
		name: 'The Flight',
		enabled: true,
		scope: {},
		filter: {},
		...overrides,
	}) as SyncPlan;

const correlation = (overrides: Partial<Correlation> = {}): Correlation => ({
	localItemId: 'a',
	remoteItemId: 'b',
	strategy: MatchStrategy.EXTERNAL_ID,
	confidence: 0.95,
	state: SyncState.IN_SYNC,
	confirmedAt: null,
	...overrides,
});

interface World {
	items: MediaItem[];
	matches: Correlation[];
	services: MediaService[];
	libraries: { id: string; serviceId: string; externalId: string }[];
	peers: Peer[];
	plans: SyncPlan[];
	threshold: number;
}

/**
 * The `LIKE` the repository writes against the stored quality summary.
 *
 * Repeated here rather than approximated, and serialised the way the driver serialises
 * a `simple-json` column, because that is what the filter actually is: a substring test
 * naming the key and the whole value. A fake that compared the deserialised object
 * instead would prove the manager against a filter nobody ships — and would hide the
 * one way the real one can go wrong, which is a row nothing has summarised yet.
 */
const holdsVariant = (row: MediaItem, field: string, values: string[]): boolean =>
	values.some((value) =>
		JSON.stringify(row.quality ?? null).includes(`"${field}":"${value}"`),
	);

const digest = (row: MediaItem): MediaItemDigest => ({
	id: row.id,
	serviceId: row.serviceId,
	libraryId: row.libraryId,
	parentId: row.parentId,
	kind: row.kind,
	episodeNumber: row.episodeNumber,
	episodeNumberEnd: row.episodeNumberEnd,
	syncState: row.syncState,
	ignored: row.ignored ?? false,
	// Read off the fixture rather than defaulted, because a default would make every
	// fileless row in this file read as a copy and silence the rule that says it is not.
	hasFile: row.file !== null,
	releaseSeenAt: row.releaseSeenAt ?? null,
	copySeenAt: row.copySeenAt ?? null,
});

/**
 * The repositories, answering out of an in-memory world.
 *
 * `findAppliedPairs` repeats here the condition the repository expresses in SQL —
 * not null, not a conflict nothing naming the work vouched for, above the threshold or
 * confirmed. That duplication is deliberate and bounded: this file is about what the
 * manager does with the edges it is given, and the functional tests run the real
 * statement against a real database, which is the only place the SQL itself can be
 * proven.
 */
const build = (
	world: Partial<World> = {},
	/**
	 * Whether this gateway has a thread to send the catalogue pass to.
	 *
	 * False by default, because that is what a unit run really is: an in-memory database
	 * belongs to the connection that opened it, so there is nothing a second thread could
	 * read. The tests that pass a thread are about the delegation itself.
	 */
	workers: { available: boolean; run?: jest.Mock } = { available: false },
): {
	manager: MediaGroupManager;
	world: World;
	reads: {
		items: Record<string, jest.Mock>;
		matches: Record<string, jest.Mock>;
		cache: { onRefresh: jest.Mock; schedule: jest.Mock; refreshNow: jest.Mock; refreshing: boolean };
		workers: { available: boolean; run: jest.Mock };
	};
} => {
	const full: World = {
		items: [],
		matches: [],
		services: [service(), service({ id: 'remote', name: 'Cabin', filesMounted: false, priority: 200 })],
		libraries: [],
		peers: [],
		plans: [],
		threshold: 0.8,
		...world,
	};

	const byId = (id: string): MediaItem | undefined => full.items.find((row) => row.id === id);

	const items = {
		findGroupSeeds: jest.fn((query: GroupSeedQuery) =>
			Promise.resolve(
				full.items
					.filter(
						(row) =>
							(query.serviceIds === undefined || query.serviceIds.includes(row.serviceId)) &&
							(query.libraryIds === undefined ||
								query.libraryIds.includes(row.libraryId)) &&
							(query.kind === undefined || row.kind === query.kind) &&
							(query.rootsOnly !== true || row.parentId === null) &&
							(query.parentIds === undefined ||
								(row.parentId !== null && query.parentIds.includes(row.parentId))) &&
							(query.resolutions === undefined ||
								holdsVariant(row, 'resolution', query.resolutions)) &&
							(query.videoCodecs === undefined ||
								holdsVariant(row, 'videoCodec', query.videoCodecs)) &&
							(query.watchStates === undefined ||
								query.watchStates.some(
									state => (row.watchStates ?? []).includes(state))) &&
							(query.coveredIds === undefined ||
								query.coveredIds.includes(row.id) ||
								(row.parentId !== null &&
									(query.coveredParentIds ?? []).includes(row.parentId)) ||
								// Kept because of what the household said about it, which is how a
								// whole watchlist is named without one parameter per row.
								(query.coveredWatchStates ?? []).some(
									state => (row.watchStates ?? []).includes(state))) &&
							(query.search === undefined ||
								row.normalizedTitle.includes(query.search.toLowerCase())),
					)
					.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
					.map(digest)
					/*
					 * The slice the caller asked for, honoured rather than ignored.
					 *
					 * `_wholeScope` reads the scope a page at a time and stops when a page
					 * comes back short. A double that answered the whole scope to every
					 * page would never return a short one, so any world larger than
					 * `SCOPE_PAGE` would loop here for ever — a hang in the suite rather
					 * than a failure, which is the worst kind to diagnose.
					 */
					.slice(
						query.skip ?? 0,
						query.take === undefined ? undefined : (query.skip ?? 0) + query.take,
					),
			),
		),
		findDigests: jest.fn((ids: string[]) =>
			Promise.resolve(full.items.filter((row) => ids.includes(row.id)).map(digest)),
		),
		findChildDigests: jest.fn((parentIds: string[]) =>
			Promise.resolve(
				full.items
					.filter((row) => row.parentId !== null && parentIds.includes(row.parentId))
					.map(digest),
			),
		),
		findByIds: jest.fn((ids: string[]) =>
			Promise.resolve(full.items.filter((row) => ids.includes(row.id))),
		),
		// Everything a set of services reports, which is how the whole request source is
		// scoped: a row exists there because somebody asked for it.
		findByServices: jest.fn((serviceIds: string[]) =>
			Promise.resolve(full.items.filter((row) => serviceIds.includes(row.serviceId))),
		),
		// One list of a source rather than the whole of it: a watchlist entry is followed,
		// a request is merely asked for, and they sit in different libraries.
		findByLibraries: jest.fn((libraryIds: string[]) =>
			Promise.resolve(full.items.filter((row) => libraryIds.includes(row.libraryId))),
		),
		// The children of a set of parents, which is how a folder is worked out for a
		// row that carries no file of its own. TypeORM's `In` is a value object here, so
		// the fake reads the identifiers back off it rather than pretending to be a
		// query builder.
		find: jest.fn(({ where }: { where: { parentId: { _value: string[] } } }) =>
			Promise.resolve(
				full.items.filter(
					(row) => row.parentId !== null && where.parentId._value.includes(row.parentId),
				),
			),
		),
		findOne: jest.fn(({ where }: { where: { id: string } }) =>
			Promise.resolve(byId(where.id) ?? null),
		),
	};

	const matches = {
		// What the table looks like, so a cached graph can tell whether it is still the
		// truth. Derived from the fixtures, so a test that adds a match changes it.
		version: jest.fn(() => Promise.resolve(`${full.matches.length}`)),
		findAppliedPairs: jest.fn((threshold: number, skip = 0, take = 0) =>
			Promise.resolve(
				full.matches
					.filter(
						(match) =>
							match.localItemId !== null &&
							(match.state !== SyncState.CONFLICT ||
								[
									MatchStrategy.EXTERNAL_ID,
									MatchStrategy.SEASON_EPISODE,
									MatchStrategy.MANUAL,
								].includes(match.strategy)) &&
							(match.confidence >= threshold || match.confirmedAt !== null),
					)
					.map(
						(match): MatchPair => ({
							localItemId: match.localItemId as string,
							remoteItemId: match.remoteItemId,
							state: match.state,
						}),
					)
					// Paged only when asked, like the repository: the background rebuild reads
					// in slices and a fake that ignored them would never exercise the loop.
					.slice(skip, take > 0 ? skip + take : undefined),
			),
		),
	};

	const cache = { onRefresh: jest.fn(), schedule: jest.fn(), refreshNow: jest.fn(), refreshing: false };
	const services = {
		find: jest.fn(() => Promise.resolve(full.services)),
	} as unknown as MediaServiceRepository;

	/*
	 * The real pass, over the fake repositories, and that is the point of it here.
	 *
	 * In a gateway this runs on a worker thread; an in-memory database cannot be opened
	 * twice, so there is nothing to send it to in a unit run and `available` is false.
	 * Handing the manager a stub instead would leave the catalogue walk — the expensive
	 * half of every `actionable` read — untested, so these tests run it in process and
	 * count the reads it makes.
	 */
	const projection = new CatalogueProjectionService(
		items as unknown as MediaItemRepository,
		matches as unknown as MediaMatchRepository,
		services,
	);

	const pool = { available: workers.available, run: workers.run ?? jest.fn() };

	return {
		manager: new MediaGroupManager(
			items as unknown as MediaItemRepository,
			matches as unknown as MediaMatchRepository,
			services,
			{ find: jest.fn(() => Promise.resolve(full.peers)) } as unknown as PeerRepository,
			new QualityService(),
			{ getValue: jest.fn(() => Promise.resolve(full.threshold)) } as unknown as SettingsService,
			// Categories are the library manager's business; these tests filter by
			// library identifier, which never reaches it.
			{
				librariesOfCategory: jest.fn(() => Promise.resolve([])),
				// The watched filter reads which list of a request source a row is in: a
				// watchlist entry is followed, a request is merely asked for.
				list: jest.fn((serviceId: string) =>
					Promise.resolve(full.libraries.filter((one) => one.serviceId === serviceId)),
				),
			} as unknown as LibraryManager,
			// Following is a sync plan covering a media and nothing else, so the plans are
			// the whole of what the followed filter reads.
			{ find: jest.fn(() => Promise.resolve(full.plans)) } as unknown as SyncPlanRepository,
			// The warm path registers itself here at module init and is asked for a build at
			// boot. These tests call the manager directly and never boot a module, so
			// nothing is scheduled unless a test says so — the lazy rebuild in
			// `_cachedGraph` is what the rest of them exercise.
			cache as unknown as CatalogueCacheService,
			projection,
			pool as unknown as WorkerPoolService,
		),
		world: full,
		reads: { items, matches, cache, workers: pool },
	};
};

const query = (overrides: MediaGroupQuery = {}): MediaGroupQuery => ({ limit: 50, ...overrides });

describe('MediaGroupManager', () => {
	describe('the grouping rule', () => {
		it('joins two items an applied match put together', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local' }),
					item({ id: 'b', serviceId: 'remote', libraryId: 'library-remote' }),
				],
				matches: [correlation({ confidence: 0.95 })],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].sources.map((source) => source.itemId).sort()).toEqual(['a', 'b']);
			expect(page.pagination.total).toBe(1);
		});

		it('leaves a proposal below the threshold as two groups', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local', syncState: SyncState.LOCAL_ONLY }),
					item({ id: 'b', serviceId: 'remote', syncState: SyncState.MISSING }),
				],
				// Scored, written, and not applied: the honest rendering of "we are not
				// sure these are the same thing" is two posters, not one.
				matches: [correlation({ confidence: 0.6 })],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(2);
			expect(page.items.every((group) => group.sources.length === 1)).toBe(true);
		});

		it('joins the same pair once a human has confirmed it', async () => {
			const { manager } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation({ confidence: 0.6, confirmedAt: new Date() })],
			});

			expect((await manager.groups(query())).items).toHaveLength(1);
		});

		it('leaves the same bytes under two labels as two groups, which is what that conflict is for', async () => {
			// Nobody has decided which episode the file is; joining the two would
			// renumber one library after the other on a guess.
			const { manager } = build({
				items: [
					item({ id: 'a', syncState: SyncState.CONFLICT }),
					item({ id: 'b', serviceId: 'remote', syncState: SyncState.CONFLICT }),
				],
				matches: [
					correlation({
						confidence: 1,
						state: SyncState.CONFLICT,
						strategy: MatchStrategy.CHECKSUM,
					}),
				],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(2);
			expect(page.items[0].sync).toBe(SyncState.CONFLICT);
		});

		it('joins two cuts of one film into one group that reads conflict', async () => {
			// The identifier decided the work, the running time the version: one card that
			// says "two versions", where there used to be two cards that looked unrelated.
			const { manager } = build({
				items: [
					item({
						id: 'a',
						kind: MediaKind.MOVIE,
						syncState: SyncState.CONFLICT,
						file: file({ durationMs: 11_640_000, contentId: 'q1-theatrical' }),
					}),
					item({
						id: 'b',
						serviceId: 'remote',
						kind: MediaKind.MOVIE,
						syncState: SyncState.CONFLICT,
						file: file({ durationMs: 12_540_000, contentId: 'q1-extended' }),
					}),
				],
				matches: [correlation({ confidence: 0.98, state: SyncState.CONFLICT })],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].sync).toBe(SyncState.CONFLICT);
			expect(page.items[0].versions).toEqual([
				expect.objectContaining({ versionId: 'q1-theatrical', heldLocally: true }),
				expect.objectContaining({ versionId: 'q1-extended', heldLocally: false }),
			]);
		});

		it('folds three services into one group with three sources', async () => {
			const { manager } = build({
				services: [
					service(),
					service({ id: 'remote', filesMounted: false, priority: 200 }),
					service({ id: 'friend', filesMounted: false, priority: 300, peerId: 'peer-1' }),
				],
				peers: [{ id: 'peer-1', name: 'Théo' } as Peer],
				items: [
					item({ id: 'a' }),
					item({ id: 'b', serviceId: 'remote' }),
					item({ id: 'c', serviceId: 'friend' }),
				],
				// The transitive case: a joined b, b joined c, and nobody ever compared a
				// with c. A group is a connected component, not a pair.
				matches: [
					correlation({ localItemId: 'a', remoteItemId: 'b' }),
					correlation({ localItemId: 'b', remoteItemId: 'c' }),
				],
			});

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].sources).toHaveLength(3);
			expect(page.items[0].sources.find((source) => source.serviceId === 'friend')).toMatchObject({
				peerId: 'peer-1',
				peerName: 'Théo',
				local: false,
			});
		});

		it('gives an item nobody matched a group of its own', async () => {
			const { manager } = build({ items: [item({ id: 'a' })] });

			const page = await manager.groups(query());

			expect(page.items).toHaveLength(1);
			expect(page.items[0].id).toBe('a');
		});
	});

	describe('the representative', () => {
		const world = (order: string[]): World['items'] => {
			const rows: Record<string, MediaItem> = {
				z: item({ id: 'z', serviceId: 'remote', title: 'Le vol' }),
				a: item({ id: 'a', serviceId: 'local', title: 'The Flight' }),
				m: item({ id: 'm', serviceId: 'remote', title: 'The Flight (2008)' }),
			};

			return order.map((id) => rows[id]);
		};

		const matches = [
			correlation({ localItemId: 'a', remoteItemId: 'z' }),
			correlation({ localItemId: 'a', remoteItemId: 'm' }),
		];

		it('prefers a local copy and answers the same identifier twice running', async () => {
			const first = build({ items: world(['z', 'a', 'm']), matches });
			const second = build({ items: world(['m', 'z', 'a']), matches });

			const one = await first.manager.groups(query());
			const again = await first.manager.groups(query());
			const other = await second.manager.groups(query());

			expect(one.items[0].id).toBe('a');
			expect(again.items[0].id).toBe('a');
			// Same world, rows handed back in a different order: an interface that
			// reloads must not find the poster under a new identifier.
			expect(other.items[0].id).toBe('a');
			expect(one.items[0].title).toBe('The Flight');
		});

		it('falls back on the identifier when nothing local separates the copies', async () => {
			const { manager } = build({
				items: [
					item({ id: 'y', serviceId: 'remote' }),
					item({ id: 'x', serviceId: 'remote' }),
				],
				matches: [correlation({ localItemId: 'y', remoteItemId: 'x' })],
			});

			expect((await manager.groups(query())).items[0].id).toBe('x');
		});

		it('fills its gaps from the other copies rather than showing nothing', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', overview: null, year: null, externalIds: { provider: 'jf-1' } }),
					item({
						id: 'b',
						serviceId: 'remote',
						overview: 'A rabbit takes his revenge.',
						year: 2008,
						externalIds: { tvdb: '99', provider: 'plex-1' },
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.overview).toBe('A rabbit takes his revenge.');
			expect(group.year).toBe(2008);
			// The remote identifier is kept, the representative's own wins where both
			// have one.
			expect(group.externalIds).toEqual({ tvdb: '99', provider: 'jf-1' });
		});
	});

	describe('hideOwned', () => {
		/*
		 * The filter is "nothing left to fetch here", not "the row exists".
		 *
		 * A series present locally but three episodes short is precisely what somebody
		 * opens this screen to find; hiding it because the series row is held would
		 * drop the only case the filter was asked for.
		 */
		it('keeps a series we hold that is still missing an episode', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'ep-there', serviceId: 'remote', parentId: 'show-remote' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
				],
				matches: [correlation({ localItemId: 'show', remoteItemId: 'show-remote' })],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			expect(answer.items.map((group) => group.id)).toContain('show');
		});

		it('drops a series we hold with no gap under it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-there', serviceId: 'remote', parentId: 'show-remote' }),
				],
				matches: [
					correlation({ localItemId: 'show', remoteItemId: 'show-remote' }),
					correlation({ localItemId: 'ep-here', remoteItemId: 'ep-there' }),
				],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			// Named rather than counted, so the assertion stays about the show rather than
			// about how many other groups the world happens to hold.
			expect(answer.items.map((group) => group.id)).not.toContain('show');
		});

		it('keeps a film whose only copy here is a different cut', async () => {
			// Holding the theatrical cut is not holding the extended one, and hiding the
			// group would make the other cut unfindable the moment the two were joined.
			const { manager } = build({
				items: [
					item({ id: 'a', kind: MediaKind.MOVIE, syncState: SyncState.CONFLICT }),
					item({ id: 'b', serviceId: 'remote', kind: MediaKind.MOVIE, syncState: SyncState.CONFLICT }),
				],
				matches: [correlation({ state: SyncState.CONFLICT })],
			});

			const answer = await manager.groups(query({ hideOwned: true }));

			expect(answer.items.map((group) => group.id)).toEqual(['a']);
		});

		it('counts an episode held here only in another cut as a gap', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show', syncState: SyncState.CONFLICT }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-there', serviceId: 'remote', parentId: 'show-remote' }),
				],
				matches: [
					correlation({ localItemId: 'show', remoteItemId: 'show-remote' }),
					correlation({
						localItemId: 'ep-here',
						remoteItemId: 'ep-there',
						state: SyncState.CONFLICT,
					}),
				],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			expect(answer.items.find((group) => group.id === 'show')?.missingCount).toBe(1);
		});

		it('keeps what only somebody else holds', async () => {
			const { manager } = build({
				items: [item({ id: 'theirs', serviceId: 'remote' })],
			});

			const answer = await manager.groups(query({ hideOwned: true }));

			expect(answer.items.map((group) => group.id)).toEqual(['theirs']);
		});

		it('answers the whole shelf when the filter is not asked for', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
				],
			});

			const answer = await manager.groups(query({ rootsOnly: true }));

			expect(answer.items.map((group) => group.id)).toContain('show');
		});

		it('does not count an ignored episode as a gap', async () => {
			// The special that would otherwise keep a finished season looking unfinished.
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({
						id: 'special',
						serviceId: 'remote',
						parentId: 'show-remote',
						seasonNumber: 0,
						ignored: true,
					}),
				],
				matches: [correlation({ localItemId: 'show', remoteItemId: 'show-remote' })],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			// The show is held and its only outstanding child is one nobody counts, so
			// there is nothing left to fetch and it goes.
			expect(answer.items.map((group) => group.id)).not.toContain('show');
		});
	});

	describe('artwork', () => {
		it('points at a local copy, because a friend’s server may be asleep', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local', artworkUrl: '/local/poster.jpg' }),
					item({ id: 'b', serviceId: 'remote', artworkUrl: '/remote/poster.jpg' }),
				],
				matches: [correlation()],
			});

			expect((await manager.groups(query())).items[0].artworkItemId).toBe('a');
		});

		it('takes a remote poster rather than none when the local copy has no artwork', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'local', artworkUrl: null }),
					item({ id: 'b', serviceId: 'remote', artworkUrl: '/remote/poster.jpg' }),
				],
				matches: [correlation()],
			});

			expect((await manager.groups(query())).items[0].artworkItemId).toBe('b');
		});

		it('answers null when nobody reported one', async () => {
			const { manager } = build({ items: [item({ id: 'a', artworkUrl: '' })] });

			expect((await manager.groups(query())).items[0].artworkItemId).toBeNull();
		});
	});

	describe('quality', () => {
		it('spans every source rather than whichever server won the representative', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ height: 1080, videoCodec: 'hevc', size: 100 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ height: 2160, videoCodec: 'hevc', size: 400 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.quality?.mixed).toBe(true);
			expect(group.quality?.fileCount).toBe(2);
			expect(group.quality?.totalBytes).toBe(500);
			expect(group.quality?.variants.map((variant) => variant.resolution).sort()).toEqual([
				'1080p',
				'2160p',
			]);
		});

		it('folds the aggregates a season carries, which have no file to re-read', async () => {
			const quality = new QualityService();
			const { manager } = build({
				items: [
					item({
						id: 'a',
						kind: MediaKind.SEASON,
						file: null,
						quality: quality.summarise([file({ height: 1080 })]),
					}),
					item({
						id: 'b',
						serviceId: 'remote',
						kind: MediaKind.SEASON,
						file: null,
						// The width with the height, because a resolution is read off both:
						// leaving the default 1920 would describe a 1080p scope master
						// rather than the 720p encode this case is about.
						quality: quality.summarise([
							file({ height: 720, width: 1280 }),
							file({ height: 720, width: 1280 }),
						]),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.quality?.fileCount).toBe(3);
			expect(group.quality?.dominant?.resolution).toBe('720p');
		});

		it('says nothing at all when nothing has been scanned', async () => {
			const { manager } = build({ items: [item({ id: 'a', file: null, quality: null })] });

			expect((await manager.groups(query())).items[0].quality).toBeNull();
		});
	});

	/**
	 * What the poster expands into when somebody asks which copies are worth holding.
	 *
	 * The fold is on the fingerprint and on nothing else, which is the only rule that
	 * survives contact with a real library: the same file on three servers is one thing
	 * to pull, and two files under one title are two, whatever their titles, their
	 * editions or their scrapers agree on.
	 */
	describe('versions', () => {
		it('folds the copies of one file into a single version', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same' }) }),
					item({ id: 'b', serviceId: 'remote', file: file({ contentId: 'q1-same' }) }),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toHaveLength(1);
			expect(group.versions[0].sourceItemIds.sort()).toEqual(['a', 'b']);
			expect(group.versions[0].heldLocally).toBe(true);
		});

		it('shows two copies of one server as two sources of one media', async () => {
			/*
			 * The owner's Scrubs: two cuts on one Jellyfin, `HD - VOST` beside `SD`.
			 * Correlation refused to relate two rows of one service, so they were two
			 * unrelated shows — and filing episodes by their numbers then stacked both
			 * cuts into the same seasons, forty-eight episodes in a season of twenty-four.
			 *
			 * One media, two sources, two versions is what it always was; only the
			 * refusal stood in the way.
			 */
			const { manager } = build({
				items: [
					item({ id: 'hd', file: file({ contentId: 'q1-hd', size: 4096 }) }),
					item({ id: 'sd', file: file({ contentId: 'q1-sd', size: 1024 }) }),
				],
				matches: [correlation({ localItemId: 'hd', remoteItemId: 'sd' })],
			});

			const groups = (await manager.groups(query())).items;

			expect(groups).toHaveLength(1);
			expect(groups[0].sources.map((one) => one.itemId).sort()).toEqual(['hd', 'sd']);
			expect(groups[0].versions).toHaveLength(2);
		});

		it('folds a copy with no identity onto the version its bytes say it is', async () => {
			/*
			 * The owner's Jellyfin and Plex over one NAS: the same file, only one of them
			 * mounted, so only one can be fingerprinted. Left apart, the page offers to
			 * fetch twenty gigabytes already on the disk it would write them to.
			 */
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same', size: 20_292_365_537 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: '', quickHash: '', size: 20_292_365_537 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toHaveLength(1);
			expect(group.versions[0].sourceItemIds.sort()).toEqual(['a', 'b']);
		});

		it('leaves a copy of a different size where it is, however close', async () => {
			// A near miss is a different cut, and calling two cuts one copy is how
			// somebody ends up without the version they wanted.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same', size: 20_292_365_537 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: '', quickHash: '', size: 20_292_365_536 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions[0].sourceItemIds).toEqual(['a']);
		});

		it('leaves a copy of the same size but a different encoding alone', async () => {
			// Byte equality is conclusive on a film and a coincidence on a clip. The
			// encoding is what makes an accident implausible without inventing a
			// threshold nobody could justify.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same', size: 4096, height: 1080 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: '', quickHash: '', size: 4096, height: 2160 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions[0].sourceItemIds).toEqual(['a']);
		});

		it('keeps two encodes of one cut as two things to choose between', async () => {
			// They correlate — same cut, same running time — and they are still two
			// files. Holding one of them is an ordinary state and not a failed sync.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-1080', height: 1080 }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: 'q1-2160', height: 2160 }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions.map((version) => version.versionId)).toEqual(['q1-1080', 'q1-2160']);
			expect(group.versions.map((version) => version.heldLocally)).toEqual([true, false]);
			expect(group.versions[1].quality?.dominant?.resolution).toBe('2160p');
		});

		it('says a version is not held when only somebody else has it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'remote', file: file({ contentId: 'q1-theirs' }) }),
				],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toEqual([
				expect.objectContaining({ versionId: 'q1-theirs', heldLocally: false }),
			]);
		});

		it('carries the edition, wherever among the copies it was found', async () => {
			// Only Plex reports one and only some filenames carry the tag, so a label
			// found on any copy of the same bytes describes them all.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: 'q1-same' }) }),
					item({
						id: 'b',
						serviceId: 'remote',
						file: file({ contentId: 'q1-same', edition: 'Extended Cut' }),
					}),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions[0].edition).toBe('Extended Cut');
			expect(group.sources.find((source) => source.itemId === 'b')?.edition).toBe('Extended Cut');
		});

		it('reads the edition tag off a filename when nobody reported one', async () => {
			const { manager } = build({
				items: [
					item({
						id: 'a',
						file: file({
							contentId: 'q1-x',
							path: '/library/Titanic (1997) {edition-Theatrical}.mkv',
						}),
					}),
				],
			});

			expect((await manager.groups(query())).items[0].versions[0].edition).toBe('Theatrical');
		});

		it('lists no version for a copy nobody has fingerprinted', async () => {
			// Honest rather than convenient: giving an unfingerprinted row an identity of
			// its own would show the one file two servers hold as two versions, and
			// offering both would download it twice into one path.
			const { manager } = build({
				items: [
					item({ id: 'a', file: file({ contentId: null }) }),
					item({ id: 'b', serviceId: 'remote', file: file({ contentId: null }) }),
				],
				matches: [correlation()],
			});

			const group = (await manager.groups(query())).items[0];

			expect(group.versions).toEqual([]);
			expect(group.sources.map((source) => source.versionId)).toEqual([null, null]);
		});
	});

	/**
	 * Where a media is on this gateway's own disks, which is the next question after
	 * "do I have it".
	 *
	 * `path` beside it is the media server's spelling — `/library/…` inside its
	 * container — and until now that was the only answer on offer, which is a directory
	 * nobody can open from a shell.
	 */
	describe('the local path', () => {
		const mounted = (): MediaService[] => [
			service({ rootMappings: [{ remoteRoot: '/library', localRoot: '/share/media' }] }),
			service({ id: 'remote', name: 'A friend', peerId: 'peer-1', filesMounted: false }),
		];

		it('translates a file through the service that reported it', async () => {
			const { manager } = build({ items: [item({ id: 'a' })], services: mounted() });

			const group = (await manager.group('a'));

			expect(group.sources[0].path).toBe('/library/Big Buck Bunny - S01E01 - 1080p.mp4');
			expect(group.sources[0].localPath).toBe('/share/media/Big Buck Bunny - S01E01 - 1080p.mp4');
		});

		it('says nothing for a copy whose files this gateway does not hold', async () => {
			const { manager } = build({
				items: [item({ id: 'a', serviceId: 'remote' })],
				services: mounted(),
			});

			// A friend's server has paths and none of them mean anything here. Printing
			// one is a directory somebody goes looking for and never finds.
			expect((await manager.group('a')).sources[0].localPath).toBeNull();
		});

		it('answers a season the folder its episodes share', async () => {
			const { manager } = build({
				items: [
					item({ id: 'season', kind: MediaKind.SEASON, file: null, title: 'Season 1' }),
					item({ id: 'e1', parentId: 'season', file: file({ path: '/library/Show/Season 1/E1.mkv' }) }),
					item({ id: 'e2', parentId: 'season', file: file({ path: '/library/Show/Season 1/E2.mkv' }) }),
				],
				services: mounted(),
			});

			expect((await manager.group('season')).sources[0].localPath)
				.toBe('/share/media/Show/Season 1');
		});

		it('answers a series the folder every season of it is under', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', kind: MediaKind.SERIES, file: null, title: 'Show' }),
					item({ id: 's1', parentId: 'show', kind: MediaKind.SEASON, file: null }),
					item({ id: 's2', parentId: 'show', kind: MediaKind.SEASON, file: null }),
					item({ id: 'e1', parentId: 's1', file: file({ path: '/library/Show/Season 1/E1.mkv' }) }),
					item({ id: 'e2', parentId: 's2', file: file({ path: '/library/Show/Season 2/E1.mkv' }) }),
				],
				services: mounted(),
			});

			expect((await manager.group('show')).sources[0].localPath).toBe('/share/media/Show');
		});

		it('compares folders by whole components, never by letters', async () => {
			const { manager } = build({
				items: [
					item({ id: 'show', kind: MediaKind.SERIES, file: null }),
					item({ id: 'e1', parentId: 'show', file: file({ path: '/library/Show/E1.mkv' }) }),
					item({ id: 'e2', parentId: 'show', file: file({ path: '/library/Show2/E1.mkv' }) }),
				],
				services: mounted(),
			});

			// A prefix test on the raw strings calls `/library/Show2` a child of
			// `/library/Show`, and the page would name a folder the media is not in.
			expect((await manager.group('show')).sources[0].localPath).toBe('/share/media');
		});

		it('says nothing for a folder with no file anywhere beneath it', async () => {
			const { manager } = build({
				items: [item({ id: 'empty', kind: MediaKind.SERIES, file: null })],
				services: mounted(),
			});

			expect((await manager.group('empty')).sources[0].localPath).toBeNull();
		});
	});

	describe('children', () => {
		const season = (): World =>
			({
				items: [
					item({ id: 'season-local', kind: MediaKind.SEASON, file: null, title: 'Season 1' }),
					item({
						id: 'season-remote',
						serviceId: 'remote',
						kind: MediaKind.SEASON,
						file: null,
						title: 'Season 1',
					}),
					// Held on both, under one group: one child, not two.
					item({ id: 'e1-local', parentId: 'season-local', title: 'E1' }),
					item({ id: 'e1-remote', serviceId: 'remote', parentId: 'season-remote', title: 'E1' }),
					// Only on the friend's server: this is what `missingCount` counts.
					item({ id: 'e2-remote', serviceId: 'remote', parentId: 'season-remote', title: 'E2' }),
					item({ id: 'e3-remote', serviceId: 'remote', parentId: 'season-remote', title: 'E3' }),
					// Only ours.
					item({ id: 'e4-local', parentId: 'season-local', title: 'E4' }),
				],
				matches: [
					correlation({ localItemId: 'season-local', remoteItemId: 'season-remote' }),
					correlation({ localItemId: 'e1-local', remoteItemId: 'e1-remote' }),
				],
			}) as World;

		it('counts child groups, and how many of them we do not hold', async () => {
			const { manager } = build(season());

			const group = (await manager.groups(query({ kind: MediaKind.SEASON }))).items[0];

			expect(group.childCount).toBe(4);
			// E2 and E3, known on the friend's server and absent here. E1 is held under
			// two rows and counts once; E4 is ours and is not missing from anywhere we
			// are being asked about.
			expect(group.missingCount).toBe(2);
		});

		it('does not count the second half of a two-part file as a gap', async () => {
			/*
			 * The rows an older gateway already minted, which nothing deletes.
			 *
			 * Before the range was read, a file named `S01E01-E02` reported one episode,
			 * the provider listed two, and the difference was written to the database as
			 * a row for episode two. Reading the range now stops new ones appearing; it
			 * does nothing about the ones already there, and they are the ones the owner
			 * is looking at. The row stays — it is a real episode and the provider really
			 * lists it — and simply stops being counted against the season.
			 */
			const { manager } = build({
				items: [
					item({ id: 'season-local', kind: MediaKind.SEASON, file: null, title: 'Season 1' }),
					item({
						id: 'season-remote',
						serviceId: 'remote',
						kind: MediaKind.SEASON,
						file: null,
						title: 'Season 1',
					}),
					// One file on our disk, holding both episodes.
					item({
						id: 'e1-e2',
						parentId: 'season-local',
						title: 'E1-E2',
						episodeNumber: 1,
						episodeNumberEnd: 2,
					}),
					// Episode two as the followed show lists it, which nothing here matched
					// to the file above because the file reports a single number.
					item({
						id: 'e2-listed',
						serviceId: 'remote',
						parentId: 'season-remote',
						title: 'E2',
						episodeNumber: 2,
						file: null,
					}),
				],
				matches: [correlation({ localItemId: 'season-local', remoteItemId: 'season-remote' })],
			});

			const group = (await manager.groups(query({ kind: MediaKind.SEASON }))).items[0];

			expect(group.missingCount).toBe(0);
		});

		it('still counts a hole the two-part file does not reach', async () => {
			// The range excuses the episodes it covers and no others, or one two-part
			// file would mark a whole season held.
			const { manager } = build({
				items: [
					item({ id: 'season-local', kind: MediaKind.SEASON, file: null, title: 'Season 1' }),
					item({
						id: 'season-remote',
						serviceId: 'remote',
						kind: MediaKind.SEASON,
						file: null,
						title: 'Season 1',
					}),
					item({
						id: 'e1-e2',
						parentId: 'season-local',
						title: 'E1-E2',
						episodeNumber: 1,
						episodeNumberEnd: 2,
					}),
					item({
						id: 'e4-listed',
						serviceId: 'remote',
						parentId: 'season-remote',
						title: 'E4',
						episodeNumber: 4,
						file: null,
					}),
				],
				matches: [correlation({ localItemId: 'season-local', remoteItemId: 'season-remote' })],
			});

			const group = (await manager.groups(query({ kind: MediaKind.SEASON }))).items[0];

			expect(group.missingCount).toBe(1);
		});

		it('counts a child we hold under a parent that never matched as held', async () => {
			// The lab case: the two servers never agreed on the series title, so the
			// seasons are two groups while the episode inside is correctly one. Counting
			// only the rows filed under this parent would report that episode missing on
			// the season card while its own poster says we hold it.
			const { manager } = build({
				items: [
					item({ id: 'season-theirs', serviceId: 'remote', kind: MediaKind.SEASON, file: null }),
					item({ id: 'season-ours', kind: MediaKind.SEASON, file: null, title: 'Ours' }),
					item({ id: 'e5-theirs', serviceId: 'remote', parentId: 'season-theirs' }),
					item({ id: 'e5-ours', parentId: 'season-ours' }),
				],
				matches: [correlation({ localItemId: 'e5-ours', remoteItemId: 'e5-theirs' })],
			});

			const page = await manager.groups(query({ kind: MediaKind.SEASON }));
			const theirs = page.items.find((group) => group.id === 'season-theirs');

			expect(theirs?.childCount).toBe(1);
			expect(theirs?.missingCount).toBe(0);
		});

		it('merges the children of every copy, wherever the seasons live', async () => {
			const { manager } = build(season());

			const page = await manager.groupChildren('season-local', query());

			expect(page.pagination.total).toBe(4);
			expect(page.items.map((group) => group.title).sort()).toEqual(['E1', 'E2', 'E3', 'E4']);
			expect(page.items.find((group) => group.title === 'E1')?.sources).toHaveLength(2);
		});

		it('reaches the same children from the far side of the parent group', async () => {
			const { manager } = build(season());

			// Addressed by a copy that is not the representative: a series page opened
			// from a friend's row has to show the same seasons.
			const page = await manager.groupChildren('season-remote', query());

			expect(page.pagination.total).toBe(4);
		});

		it('ignores a parent the caller tried to smuggle into the query string', async () => {
			const { manager } = build(season());

			const page = await manager.groupChildren(
				'season-local',
				query({ parentId: 'season-remote' }),
			);

			expect(page.pagination.total).toBe(4);
		});
	});

	describe('the state a group shows', () => {
		it('is missing when no local service holds it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', serviceId: 'remote', syncState: SyncState.IN_SYNC }),
					item({ id: 'b', serviceId: 'friend', syncState: SyncState.IN_SYNC }),
				],
				services: [
					service(),
					service({ id: 'remote', filesMounted: false }),
					service({ id: 'friend', filesMounted: false }),
				],
				matches: [correlation({ localItemId: 'a', remoteItemId: 'b' })],
			});

			// Two friends agreeing with each other is not an answer to "do I have this".
			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.MISSING);
		});

		it('takes the most urgent of the states our own copies are in', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', syncState: SyncState.IN_SYNC }),
					item({ id: 'b', serviceId: 'second', syncState: SyncState.OUTDATED }),
				],
				services: [service(), service({ id: 'second', name: 'Attic' })],
				matches: [correlation()],
			});

			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.OUTDATED);
		});

		it('filters on the group’s state, not on the rows behind it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', title: 'Held', syncState: SyncState.IN_SYNC }),
					item({
						id: 'b',
						serviceId: 'remote',
						title: 'Held',
						// The remote row of a media we do hold reads `in_sync` too, and a
						// filter on rows would return this group under `missing`.
						syncState: SyncState.IN_SYNC,
					}),
					item({ id: 'c', serviceId: 'remote', title: 'Theirs', syncState: SyncState.MISSING }),
				],
				matches: [correlation()],
			});

			const missing = await manager.groups(query({ states: [SyncState.MISSING] }));

			expect(missing.pagination.total).toBe(1);
			expect(missing.items[0].title).toBe('Theirs');
		});

		it('reads as downloaded rather than missing while the library resyncs', async () => {
			/*
			 * The case the whole state exists for: the file is in the library folder and
			 * no service has scanned yet, so there is no local row and every other test
			 * above would answer `missing` — which is what offered the same episode a
			 * second time.
			 */
			const { manager } = build({
				items: [
					item({
						id: 'b',
						serviceId: 'remote',
						title: 'Theirs',
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.AWAITING_INDEX);
		});

		it('says it was never indexed once the gateway has stopped waiting', async () => {
			const { manager } = build({
				items: [
					item({
						id: 'b',
						serviceId: 'remote',
						title: 'Theirs',
						syncState: SyncState.NOT_INDEXED,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			expect((await manager.groups(query())).items[0].sync).toBe(SyncState.NOT_INDEXED);
		});

		it('answers the landed state to a filter that asks for it', async () => {
			const { manager } = build({
				items: [
					item({ id: 'a', title: 'Held', syncState: SyncState.IN_SYNC }),
					item({
						id: 'c',
						serviceId: 'remote',
						title: 'Landed',
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			const landed = await manager.groups(query({ states: [SyncState.AWAITING_INDEX] }));

			expect(landed.items.map((group) => group.title)).toEqual(['Landed']);
		});
	});

	describe('a child already on the disk', () => {
		it('is not counted as a gap under its season', async () => {
			// Counting it would put a number on a season card that nothing anybody does
			// can bring down: fetching it again writes the same bytes to the same path.
			const { manager } = build({
				items: [
					item({ id: 'show', serviceId: 'local', kind: MediaKind.SERIES, file: null }),
					item({ id: 'ep-here', serviceId: 'local', parentId: 'show' }),
					item({ id: 'show-remote', serviceId: 'remote', kind: MediaKind.SERIES, file: null }),
					item({
						id: 'ep-landed',
						serviceId: 'remote',
						parentId: 'show-remote',
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				matches: [correlation({ localItemId: 'show', remoteItemId: 'show-remote' })],
			});

			const answer = await manager.groups(query({ rootsOnly: true }));

			expect(answer.items[0].missingCount).toBe(0);
		});

		it('is hidden by "hide what I already have", like anything else we hold', async () => {
			const { manager } = build({
				items: [
					item({
						id: 'landed',
						serviceId: 'remote',
						kind: MediaKind.SERIES,
						file: null,
						syncState: SyncState.AWAITING_INDEX,
					}),
				],
				services: [service(), service({ id: 'remote', filesMounted: false })],
			});

			const answer = await manager.groups(query({ hideOwned: true, rootsOnly: true }));

			expect(answer.items).toHaveLength(0);
		});
	});

	describe('filtering and paging', () => {
		const library = (): World =>
			({
				items: [
					item({ id: 'a', title: 'Alpha' }),
					item({ id: 'a-remote', serviceId: 'remote', title: 'Alpha' }),
					item({ id: 'b', title: 'Bravo' }),
					item({ id: 'c-remote', serviceId: 'remote', title: 'Charlie' }),
					item({ id: 'd', title: 'Delta', kind: MediaKind.MOVIE }),
				],
				matches: [correlation({ localItemId: 'a', remoteItemId: 'a-remote' })],
			}) as World;

		it('narrows which groups appear without ungrouping the ones that stay', async () => {
			const { manager } = build(library());

			const page = await manager.groups(query({ serviceIds: ['remote'] }));

			expect(page.items.map((group) => group.title)).toEqual(['Alpha', 'Charlie']);
			// Alpha is shown because the friend holds a copy, and it is still shown with
			// both of them.
			expect(page.items[0].sources).toHaveLength(2);
			expect(page.items[0].id).toBe('a');
		});

		it('pages groups rather than rows', async () => {
			const { manager } = build(library());

			const first = await manager.groups(query({ limit: 2, page: 1 }));
			const second = await manager.groups(query({ limit: 2, page: 2 }));

			// Five rows, four groups: a page of rows would have answered a total of five
			// and shown Alpha twice.
			expect(first.pagination).toMatchObject({ total: 4, pages: 2, limit: 2 });
			expect(first.items.map((group) => group.title)).toEqual(['Alpha', 'Bravo']);
			expect(second.items.map((group) => group.title)).toEqual(['Charlie', 'Delta']);
		});

		it('filters by kind and by search', async () => {
			const { manager } = build(library());

			expect((await manager.groups(query({ kind: MediaKind.MOVIE }))).pagination.total).toBe(1);
			expect((await manager.groups(query({ search: 'bunny' }))).pagination.total).toBe(4);
			expect((await manager.groups(query({ search: 'nothing' }))).pagination.total).toBe(0);
		});
	});

	describe('one group', () => {
		it('is reachable from any copy in it', async () => {
			const { manager } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			await expect(manager.group('b')).resolves.toMatchObject({ id: 'a' });
		});

		it('answers a key for an item nobody holds', async () => {
			const { manager } = build({ items: [item({ id: 'a' })] });

			await expect(manager.group('nope')).rejects.toMatchObject({
				message: 'error.media.not_found',
			});
		});

		it('refuses a parent nobody holds rather than answering an empty page', async () => {
			const { manager } = build({ items: [item({ id: 'a' })] });

			await expect(manager.groups(query({ parentId: 'nope' }))).rejects.toMatchObject({
				message: 'error.media.not_found',
			});
		});
	});

	/**
	 * Whose word the group takes, field by field.
	 *
	 * The order the household actually wants is three deep: **a correction, then what
	 * our own servers report, then what a friend's does.** The middle and the last were
	 * already right. The first was missing, and it mattered: a correction is written
	 * onto the copy it was made on, and a wrong season number is usually noticed on the
	 * shelf where it makes a mess — which is often a friend's. That copy ranks behind
	 * every local one, so the local server's value went on winning and the person who
	 * made the correction saw nothing change.
	 */
	describe('which copy decides a field', () => {
		const pair = (
			localOverrides: Partial<MediaItem>,
			remoteOverrides: Partial<MediaItem>,
		): MediaItem[] => [
			item({ id: 'a', serviceId: 'local', ...localOverrides }),
			item({ id: 'b', serviceId: 'remote', libraryId: 'library-remote', ...remoteOverrides }),
		];

		/** What a corrected copy looks like: the column changed, the snapshot kept. */
		const corrected = (
			changes: Partial<MediaItem>,
			reported: Partial<MediaItem> = {},
		): Partial<MediaItem> => {
			const base = item({ ...reported });

			return {
				...changes,
				reported: {
					libraryId: base.libraryId,
					title: base.title,
					seriesTitle: null,
					year: base.year,
					seasonNumber: base.seasonNumber,
					episodeNumber: base.episodeNumber,
					overview: base.overview,
					externalIds: base.externalIds,
				},
			} as Partial<MediaItem>;
		};

		/**
		 * The range, which is the one field a friend's copy must never decide.
		 *
		 * Every reader of it expands the range and treats what is inside as held, so a
		 * remote row claiming `E01-E04` would silence three real gaps on the strength of
		 * somebody else's file name — and the gap it silences is a gap on *our* disk.
		 */
		it('takes the episode range off a copy we hold, not off the widest claim', async () => {
			const { manager } = build({
				items: pair(
					{ episodeNumber: 1, episodeNumberEnd: null },
					{ episodeNumber: 1, episodeNumberEnd: 4, syncState: SyncState.MISSING },
				),
				matches: [correlation()],
			});

			expect((await manager.groups(query({}))).items[0].episodeNumberEnd).toBeNull();
		});

		it('answers the range our own two-part file carries', async () => {
			// The other half: `S01E01-E02` on the disk really does hold both, and a
			// reader that answered null here would offer the second for download.
			const { manager } = build({
				items: pair(
					{ episodeNumber: 1, episodeNumberEnd: 2 },
					{ episodeNumber: 1, episodeNumberEnd: null, syncState: SyncState.MISSING },
				),
				matches: [correlation()],
			});

			expect((await manager.groups(query({}))).items[0].episodeNumberEnd).toBe(2);
		});

		it('lets a correction made on a friend’s copy win over our server’s answer', async () => {
			const { manager } = build({
				items: pair(
					{ year: 2008, seasonNumber: 1 },
					corrected({ year: 1999, seasonNumber: 4 }),
				),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(1999);
			expect(group.seasonNumber).toBe(4);
			// The group is still represented by the copy we can actually ask for artwork
			// and bytes: what moved is the value, not which server answers.
			expect(group.id).toBe('a');
		});

		it('keeps our server’s answer ahead of a friend’s when neither is corrected', async () => {
			const { manager } = build({
				items: pair({ year: 2008 }, { year: 1999 }),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(2008);
		});

		it('still fills a gap from a friend’s copy, which is not the same as overruling', async () => {
			const { manager } = build({
				items: pair({ year: null, overview: null }, { year: 1999, overview: 'What it is about.' }),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(1999);
			expect(group.overview).toBe('What it is about.');
		});

		it('takes only the field that was corrected, never the emptier ones beside it', async () => {
			// Promoting the whole row would drag a friend’s missing overview along with
			// their corrected year and blank out the description our own server has.
			const { manager } = build({
				items: pair(
					{ year: 2008, overview: 'Ours, and complete.' },
					corrected({ year: 1999, overview: null }, { year: 2008 }),
				),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(1999);
			expect(group.overview).toBe('Ours, and complete.');
		});

		it('puts our server back in front once the correction is withdrawn', async () => {
			// Withdrawing a correction clears both halves, so there is nothing left to
			// outrank anything: the order falls back to local before remote on its own.
			const { manager } = build({
				items: pair({ year: 2008 }, { year: 1999, overrides: null, reported: null }),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBe(2008);
		});

		it('carries the corrected title and the form the wall de-duplicates on together', async () => {
			// Two rows disagreeing about which media this is would put the same poster on
			// the screen twice.
			const { manager } = build({
				items: pair(
					{ title: 'The Flight', normalizedTitle: 'big buck bunny the flight' },
					corrected(
						{ title: 'Le Vol', normalizedTitle: 'le vol' },
						{ title: 'The Flight' },
					),
				),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.title).toBe('Le Vol');
			expect(group.normalizedTitle).toBe('le vol');
		});

		it('does not let a field erased on one copy blank out a value another one has', async () => {
			// "This value is wrong and there is no right one" is a statement about one
			// server's answer, not a reason to take a year off the media.
			const { manager } = build({
				items: pair({ year: null }, corrected({ year: null }, { year: 1999 })),
				matches: [correlation({ confidence: 0.95 })],
			});

			const [group] = (await manager.groups(query())).items;

			expect(group.year).toBeNull();
		});
	});

	describe('what it reads', () => {
		it('loads the matches once for the page, not once per item', async () => {
			const { manager, reads } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' }), item({ id: 'c' })],
				matches: [correlation()],
			});

			await manager.groups(query());

			expect(reads.matches.findAppliedPairs).toHaveBeenCalledTimes(1);
			expect(reads.matches.findAppliedPairs).toHaveBeenCalledWith(0.8);
		});

		it('loads them once for a burst of pages, not once per page', async () => {
			/*
			 * The price of every click. The graph is built from *every applied match in the
			 * catalogue* — the whole table, read and walked into a union-find — and nothing
			 * in it depends on what was asked for. Rebuilt per request, opening a series
			 * with three episodes in it cost the same as drawing the whole library.
			 */
			const { manager, reads } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			await manager.groups(query());
			await manager.groups(query({ rootsOnly: true }));
			await manager.groups(query());

			expect(reads.matches.findAppliedPairs).toHaveBeenCalledTimes(1);
		});

		it('builds it again when the threshold that decides it changes', async () => {
			// It is a setting somebody can move, and it decides which matches count — an
			// answer from a graph built under the old one would be the setting not taking.
			const { manager, reads, world } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			await manager.groups(query());
			world.threshold = 0.95;
			await manager.groups(query());

			expect(reads.matches.findAppliedPairs).toHaveBeenCalledTimes(2);
			expect(reads.matches.findAppliedPairs).toHaveBeenLastCalledWith(0.95);
		});

		it('warms the graph so the next page does not pay to build it', async () => {
			/*
			 * The half that yielding never fixed. The graph is cached against a version of
			 * the match table, so a scan invalidates it — and whoever opened a page next
			 * rebuilt it, on their clock, for seconds. `refresh` is that rebuild done at the
			 * end of the scan instead, which is the one moment the gateway knows it is coming.
			 */
			const { manager, reads } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			expect(await manager.refresh()).toBe(true);

			const built = reads.matches.findAppliedPairs.mock.calls.length;

			await manager.groups(query());

			expect(reads.matches.findAppliedPairs.mock.calls.length).toBe(built);
		});

		it('asks for the graph to be built at boot, before anybody opens a page', async () => {
			/*
			 * The cache lives in memory, so every deployment and every crash leaves it
			 * empty — and warming only after a scan left the one case where it is certain
			 * to be cold completely uncovered. The minute after an update is also the
			 * minute somebody is most likely to be looking at it.
			 */
			const { manager, reads } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			manager.onApplicationBootstrap();

			expect(reads.cache.schedule).toHaveBeenCalledWith(CacheRefreshReason.BOOT);
		});

		it('waits for a rebuild already running rather than racing it', async () => {
			/*
			 * The two paths do the same work and the wrong one wins: the background pass
			 * reads in slices and breathes between them, this one reads the whole table in a
			 * single synchronous statement. A page arriving during a warm must join it, or
			 * it blocks the process for the length of a rebuild — the minute after a restart,
			 * which is the minute somebody is most likely to be looking.
			 */
			const { manager, reads } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			let warming = false;

			reads.cache.refreshNow.mockImplementation(async () => {
				await manager.refresh();
				warming = false;
			});
			Object.defineProperty(reads.cache, 'refreshing', { get: () => warming });

			warming = true;

			const before = reads.matches.findAppliedPairs.mock.calls.length;

			await manager.groups(query());

			// Only the paged reads the warm itself made: nothing read the whole table at once.
			expect(reads.cache.refreshNow).toHaveBeenCalled();
			expect(
				reads.matches.findAppliedPairs.mock.calls
					.slice(before)
					.every(([, , take]) => take > 0),
			).toBe(true);
		});

		it('refuses to rebuild a graph that is already the current one', async () => {
			// Returned so the caller does not tell every open tab to re-read a catalogue
			// identical to the one it is holding.
			const { manager } = build({
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' })],
				matches: [correlation()],
			});

			await manager.groups(query());

			expect(await manager.refresh()).toBe(false);
		});

		it('builds the same grouping a page at a time as it does in one read', async () => {
			/*
			 * The rebuild reads the table in slices so it can hand the event loop back
			 * between them. Union-find does not care in what order it is told things, and
			 * this is what says so: the grouping a warmed graph produces has to be the one
			 * the lazy path produced, or warming would quietly change what people see.
			 */
			const world = {
				items: [item({ id: 'a' }), item({ id: 'b', serviceId: 'remote' }), item({ id: 'c' })],
				matches: [correlation()],
			};
			const lazy = build(world);
			const warmed = build(world);

			await warmed.manager.refresh();

			expect((await warmed.manager.groups(query())).items).toEqual(
				(await lazy.manager.groups(query())).items,
			);
		});

		it('reads the full rows only for the page it returns', async () => {
			const { manager, reads } = build({
				items: [
					item({ id: 'a', title: 'Alpha' }),
					item({ id: 'b', title: 'Bravo' }),
					item({ id: 'c', title: 'Charlie' }),
				],
			});

			await manager.groups(query({ limit: 1 }));

			// Three groups match, one page is asked for: the JSON columns of the other
			// two are never read.
			expect(reads.items.findByIds).toHaveBeenCalledWith(['a']);
		});
	});
	/**
	 * Filtering the wall by what the files actually are.
	 *
	 * The labels are read off the summary a scan wrote, which is the one place dimensions
	 * become a resolution — so the wall and the chip on a card cannot disagree about what
	 * a file is, and neither can be told otherwise by a filename.
	 */
	describe('the resolution and codec filters', () => {
		const scanned = (
			id: string,
			title: string,
			overrides: Partial<MediaFileInfo>,
			extra: Partial<MediaItem> = {},
		): MediaItem => {
			const own = file(overrides);

			return item({ id, title, file: own, quality: summarised(own), ...extra });
		};

		it('keeps only the media something under them is in that resolution', async () => {
			const { manager } = build({
				items: [
					scanned('hd', 'Alpha', { width: 1920, height: 1080 }),
					scanned('uhd', 'Bravo', { width: 3840, height: 2160 }),
				],
			});

			const page = await manager.groups(query({ resolutions: [MediaResolution.UHD] }));

			expect(page.items.map((one) => one.id)).toEqual(['uhd']);
			expect(page.pagination.total).toBe(1);
		});

		/**
		 * The case the owner's library already broke on.
		 *
		 * A scope master is 1920 × 804 and is a 1080p Blu-ray by every definition anybody
		 * uses, whatever the release called itself. The filter has to agree with the chip,
		 * and both read `QualityService`.
		 */
		it('reads the resolution the gateway measured, not the one the file is named after', async () => {
			const { manager } = build({
				items: [
					scanned('scope', 'Alpha', {
						path: '/library/Alpha - 720p.mkv',
						width: 1920,
						height: 804,
					}),
				],
			});

			expect((await manager.groups(query({ resolutions: [MediaResolution.FULL_HD] }))).items)
				.toHaveLength(1);
			expect((await manager.groups(query({ resolutions: [MediaResolution.HD] }))).items)
				.toHaveLength(0);
		});

		it('folds the codec spellings, so hevc, h265 and x265 are one filter', async () => {
			const { manager } = build({
				items: [scanned('five', 'Alpha', { videoCodec: 'hevc' })],
			});

			for (const spelling of ['hevc', 'h265', 'h.265', 'x265', 'HEVC']) {
				expect(
					(await manager.groups(query({ videoCodecs: [spelling] }))).items.map((one) => one.id),
				).toEqual(['five']);
			}

			expect((await manager.groups(query({ videoCodecs: ['x264'] }))).items).toHaveLength(0);
		});

		it('answers nothing to a codec no spelling folds to', async () => {
			const { manager } = build({ items: [scanned('five', 'Alpha', { videoCodec: 'hevc' })] });

			// An empty filter is not the absence of one, here for the same reason it is not
			// for a service nobody has registered.
			expect((await manager.groups(query({ videoCodecs: ['  '] }))).items).toHaveLength(0);
		});

		it('leaves out a media nobody has summarised yet', async () => {
			const { manager } = build({ items: [item({ id: 'unscanned', quality: null })] });

			// Honest rather than convenient: the one thing known about its encoding is that
			// nobody has looked at it.
			expect((await manager.groups(query({ resolutions: [MediaResolution.FULL_HD] }))).items)
				.toHaveLength(0);
		});

		/**
		 * **A group whose copies disagree matches every resolution any of them is.**
		 *
		 * The decision, and it is not the tidy one. A media held here in 1080p while a
		 * friend has the 2160p is *the* case somebody filtering on `2160p` is looking for:
		 * that is where the better copy is, and where a sync would fetch it from. A rule
		 * demanding every copy agree would hide exactly the row worth acting on, and one
		 * reading only the local copy would answer "you have no 4K" to somebody who is
		 * asking where the 4K is.
		 *
		 * It is also the only reading consistent with the card: the group's own chip
		 * already says `mixed`, which is the honest summary of two copies that differ, and
		 * a wall whose filter meant something narrower than its chip would be two answers
		 * to one question.
		 */
		it('shows a group whose copies disagree under both of their resolutions', async () => {
			const world = {
				items: [
					scanned('ours', 'Alpha', { width: 1920, height: 1080 }),
					scanned('theirs', 'Alpha', { width: 3840, height: 2160 }, {
						serviceId: 'remote',
						libraryId: 'library-remote',
					}),
				],
				matches: [correlation({ localItemId: 'ours', remoteItemId: 'theirs', confidence: 0.95 })],
			};

			const grouped = await build(world).manager.groups(query());

			expect(grouped.items).toHaveLength(1);
			expect(grouped.items[0].quality?.mixed).toBe(true);

			for (const resolution of [MediaResolution.FULL_HD, MediaResolution.UHD]) {
				const page = await build(world).manager.groups(query({ resolutions: [resolution] }));

				expect(page.items.map((one) => one.sources.length)).toEqual([2]);
				expect(page.pagination.total).toBe(1);
			}
		});
	});

	/**
	 * The library, pre-filtered to what is followed and worth acting on.
	 *
	 * Following is a sync plan covering a media and never a second flag beside it, so
	 * everything here is read off `SyncScope.rootItemIds` — the same reading the media's
	 * own page uses when it says a plan already speaks for it.
	 */
	it('never offers the request source as somewhere to fetch from', async () => {
		/*
		 * Its rows are the statement that nobody holds the file. Listed as a copy it was
		 * offered on "fetch from" with an unknown quality and a `direct` badge, as though
		 * Seerr could serve bytes. It still counts as a member — it is what makes the media
		 * exist at all when nothing else reports it.
		 */
		const { manager } = build({
			items: [item({ id: 'asked', title: 'Alpha', serviceId: 'requests', file: null, quality: null })],
			services: [
				service(),
				service({ id: 'requests', name: 'Requests', type: MediaServiceType.REQUESTS }),
			],
		});

		const page = await manager.groups(query({}));

		expect(page.items).toHaveLength(1);
		expect(page.items[0].sources).toEqual([]);
	});

	it('names the show on an episode, for a list read outside that show', async () => {
		/*
		 * The new releases screen draws episodes from across the library, and a row reading
		 * "Le Bandit  S8E18" says nothing about which series that is — the one fact needed
		 * to decide anything about it.
		 */
		const { manager } = build({
			items: [
				item({ id: 'series', title: 'Les Schtroumpfs', kind: MediaKind.SERIES, file: null }),
				item({ id: 'season', title: 'Saison 8', kind: MediaKind.SEASON, parentId: 'series', file: null }),
				item({
					id: 'episode',
					title: 'Le Bandit',
					kind: MediaKind.EPISODE,
					parentId: 'season',
					seasonNumber: 8,
					episodeNumber: 18,
				}),
			],
		});

		const page = await manager.groups(query({ kind: MediaKind.EPISODE }));

		expect(page.items.map((one) => one.seriesTitle)).toEqual(['Les Schtroumpfs']);
	});

	describe('the followed filter', () => {
		const show = (id: string, title: string, overrides: Partial<MediaItem> = {}): MediaItem =>
			item({ id, title, kind: MediaKind.SERIES, file: null, quality: null, ...overrides });

		/**
		 * The other way a household says it cares about a show.
		 *
		 * Nobody writes a sync plan for a series they have just asked Seerr for, so a
		 * screen reading plans alone was almost empty while the request list was full.
		 * Asking for something *is* watching it.
		 */
		it('counts what the household follows, and not what it merely asked for', async () => {
			/*
			 * The source keeps two lists and they are not the same statement. "Fetch me
			 * this" is answered once and done with; "tell me when there is more of this"
			 * never is. Counting requests here filled the new releases screen with shows
			 * somebody asked for a year ago and has not thought about since.
			 */
			const { manager } = build({
				items: [
					show('followed-there', 'Alpha', { serviceId: 'requests', libraryId: 'films', watchStates: [MediaWatchState.FOLLOWED] }),
					show('asked-there', 'Bravo', { serviceId: 'requests', libraryId: 'films', watchStates: [MediaWatchState.REQUESTED] }),
					show('elsewhere', 'Charlie'),
				],
				services: [
					service(),
					service({ id: 'requests', name: 'Requests', type: MediaServiceType.REQUESTS }),
				],
				libraries: [
					{ id: 'films', serviceId: 'requests', externalId: 'films' },
					{ id: 'series', serviceId: 'requests', externalId: 'series' },
				],
				plans: [],
			});

			const page = await manager.groups(query({ rootsOnly: true, watched: true }));

			expect(page.items.map((one) => one.id)).toEqual(['followed-there']);
		});

		it('tells what was asked for from what is merely followed', async () => {
			/*
			 * The requests screen is this filter. It used to be the *origin*, which is a
			 * property of a service rather than of a media — so a screen about what the
			 * household had asked for answered everything the request source had ever
			 * reported, a show merely followed included.
			 */
			const { manager } = build({
				items: [
					show('asked', 'Alpha', {
						serviceId: 'requests',
						libraryId: 'films',
						watchStates: [MediaWatchState.REQUESTED],
					}),
					show('followed', 'Bravo', {
						serviceId: 'requests',
						libraryId: 'films',
						watchStates: [MediaWatchState.FOLLOWED],
					}),
					show('both', 'Charlie', {
						serviceId: 'requests',
						libraryId: 'films',
						watchStates: [MediaWatchState.FOLLOWED, MediaWatchState.REQUESTED],
					}),
				],
				services: [
					service(),
					service({ id: 'requests', name: 'Requests', type: MediaServiceType.REQUESTS }),
				],
				libraries: [{ id: 'films', serviceId: 'requests', externalId: 'films' }],
				plans: [],
			});

			const page = await manager.groups(
				query({ rootsOnly: true, watchStates: [MediaWatchState.REQUESTED] }));

			// The one that is both counts: it *was* asked for, whatever else is true of it.
			expect(page.items.map(one => one.id).sort()).toEqual(['asked', 'both']);
		});

		it('names what is followed by its state rather than row by row', async () => {
			/*
			 * The screen answered `SQLITE_ERROR: too many SQL variables` the day the
			 * watchlist filled up, and it did not degrade first — it broke the moment the
			 * feature started working. A watchlist is a library of this gateway's own
			 * making, a row per series, per season and per aired episode, so listing its
			 * contents meant binding one parameter per row: four hundred followed shows ran
			 * the statement out of variables.
			 *
			 * One parameter says the same thing, because every row of that tree is written
			 * into that library. The test is on the shape of the query and not on a count,
			 * since the fake below has no such limit and would pass either way.
			 */
			const { manager, reads } = build({
				items: [
					show('one', 'Alpha', { serviceId: 'requests', libraryId: 'films', watchStates: [MediaWatchState.FOLLOWED] }),
					show('two', 'Bravo', { serviceId: 'requests', libraryId: 'films', watchStates: [MediaWatchState.FOLLOWED] }),
					show('three', 'Charlie', { serviceId: 'requests', libraryId: 'films', watchStates: [MediaWatchState.FOLLOWED] }),
				],
				services: [
					service(),
					service({ id: 'requests', name: 'Requests', type: MediaServiceType.REQUESTS }),
				],
				libraries: [{ id: 'films', serviceId: 'requests', externalId: 'films' }],
				plans: [],
			});

			await manager.groups(query({ rootsOnly: true, watched: true }));

			const asked = reads.items.findGroupSeeds.mock.calls[0][0] as GroupSeedQuery;

			expect(asked.coveredWatchStates).toEqual([MediaWatchState.FOLLOWED]);
			// And not one of the rows that carry it, however many there are.
			expect(asked.coveredIds).toEqual([]);
		});

		it('takes both ways of saying it, not one or the other', async () => {
			// A plan here, a watchlist entry over there: two ways of saying the household
			// cares, and nobody writes a plan for a series they have just followed on Seerr.
			const { manager } = build({
				items: [
					show('followed-there', 'Alpha', { serviceId: 'requests', libraryId: 'films', watchStates: [MediaWatchState.FOLLOWED] }),
					show('planned', 'Bravo'),
					show('neither', 'Charlie'),
				],
				services: [
					service(),
					service({ id: 'requests', name: 'Requests', type: MediaServiceType.REQUESTS }),
				],
				libraries: [{ id: 'films', serviceId: 'requests', externalId: 'films' }],
				plans: [plan({ scope: { rootItemIds: ['planned'] } })],
			});

			const page = await manager.groups(query({ rootsOnly: true, watched: true }));

			expect(page.items.map((one) => one.id).sort()).toEqual(['followed-there', 'planned']);
		});

		it('keeps only the media a sync plan covers', async () => {
			const { manager } = build({
				items: [show('followed', 'Alpha'), show('ignored', 'Bravo')],
				plans: [plan({ scope: { rootItemIds: ['followed'] } })],
			});

			const page = await manager.groups(query({ rootsOnly: true, followed: true }));

			expect(page.items.map((one) => one.id)).toEqual(['followed']);
		});

		/**
		 * A plan is usually made on a season, and the wall shows series.
		 *
		 * Without the climb the followed thing would be unreachable from the one screen
		 * built to show it, which is the same reason the state filter walks up.
		 */
		it('shows the series above a followed season', async () => {
			const { manager } = build({
				items: [
					show('series', 'Alpha'),
					item({ id: 'season', title: 'Season 1', kind: MediaKind.SEASON, parentId: 'series', file: null }),
					show('other', 'Bravo'),
				],
				plans: [plan({ scope: { rootItemIds: ['season'] } })],
			});

			const page = await manager.groups(query({ rootsOnly: true, followed: true }));

			expect(page.items.map((one) => one.id)).toEqual(['series']);
		});

		it('reaches the episodes of a followed series', async () => {
			const { manager } = build({
				items: [
					show('series', 'Alpha'),
					item({ id: 'ep1', title: 'One', parentId: 'series' }),
					item({ id: 'ep2', title: 'Two', parentId: 'series' }),
				],
				plans: [plan({ scope: { rootItemIds: ['series'] } })],
			});

			const page = await manager.groups(query({ parentId: 'series', followed: true }));

			expect(page.items.map((one) => one.id)).toEqual(['ep1', 'ep2']);
		});

		it('answers nothing while nothing is followed', async () => {
			const { manager } = build({ items: [show('a', 'Alpha')], plans: [] });

			// Not "no filter": a tab of followed media with no plans is empty, and
			// answering the whole library would be the one failure that looks like the
			// filter being ignored.
			expect((await manager.groups(query({ rootsOnly: true, followed: true }))).items)
				.toHaveLength(0);
		});
	});

	/**
	 * What there is something to do about, which is the other half of the tab.
	 *
	 * Two readings, either of which counts, and neither of them new: the gap count a
	 * season card already shows, and the states the chips already speak.
	 */
	describe('the actionable filter', () => {
		const show = (id: string, title: string): MediaItem =>
			item({ id, title, kind: MediaKind.SERIES, file: null, quality: null });

		it('keeps a media an episode is missing under, and drops one with nothing left to fetch', async () => {
			const { manager } = build({
				items: [
					show('short', 'Alpha'),
					item({ id: 'short-1', title: 'One', parentId: 'short' }),
					item({
						id: 'short-2',
						title: 'Two',
						parentId: 'short',
						serviceId: 'remote',
						libraryId: 'library-remote',
						syncState: SyncState.MISSING,
					}),
					show('complete', 'Bravo'),
					item({ id: 'complete-1', title: 'One', parentId: 'complete' }),
				],
			});

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(page.items.map((one) => one.id)).toEqual(['short']);
			expect(page.items[0].missingCount).toBe(1);
		});

		/**
		 * The half a gap count cannot see.
		 *
		 * Every episode is here, so nothing is missing — and a friend holds a better
		 * encoding of one of them, which is the whole reason "something new" is read off
		 * the state rather than off the count. A series is almost never itself outdated;
		 * its episodes are.
		 */
		it('keeps a media held in full whose episode is outdated beneath it', async () => {
			const { manager } = build({
				items: [
					show('dated', 'Alpha'),
					item({ id: 'dated-1', title: 'One', parentId: 'dated', syncState: SyncState.OUTDATED }),
					show('clean', 'Bravo'),
					item({ id: 'clean-1', title: 'One', parentId: 'clean' }),
				],
			});

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(page.items.map((one) => one.id)).toEqual(['dated']);
			expect(page.items[0].missingCount).toBe(0);
		});

		/**
		 * The episode nobody here reports, which is what the whole watch exists for.
		 *
		 * `discoverEpisodes` mints a row for an aired episode no server has, and hangs it
		 * under the series — so it carries the *series'* service, which is normally our own
		 * Jellyfin. Read through `_holds`, a row on one of our services is a row we hold,
		 * so the hole this feature exists to reveal is counted as filled.
		 */
		it('counts an episode the gateway minted for a show on our own server', async () => {
			const { manager } = build({
				items: [
					show('aired', 'Alpha'),
					item({ id: 'aired-1', title: 'One', parentId: 'aired' }),
					// What `_createEpisode` writes, field for field: our service, no file,
					// and no state yet because nothing has correlated it.
					item({
						id: 'aired-2',
						title: 'Two',
						parentId: 'aired',
						episodeNumber: 2,
						file: null,
						quality: null,
						syncState: SyncState.UNKNOWN,
					}),
				],
			});

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(page.items.map((one) => one.id)).toEqual(['aired']);
			expect(page.items[0].missingCount).toBe(1);
		});

		/**
		 * The same show as the tree really holds it: series, season, episode.
		 *
		 * A series' own gap count is over its *seasons*, so an episode-shaped hole has to
		 * reach the poster through its state and the walk up — which is why the row the
		 * gateway mints has to say `missing` and not `unknown`. One screen is at stake and
		 * it is the one this feature exists for: the show is followed, the episode aired,
		 * and the news screen asks only for what is actionable.
		 */
		it('shows a series an aired episode is missing under, two levels down', async () => {
			const { manager } = build({
				items: [
					show('aired', 'Alpha'),
					item({
						id: 'aired-s1',
						title: 'Season 1',
						kind: MediaKind.SEASON,
						parentId: 'aired',
						file: null,
						quality: null,
					}),
					item({ id: 'aired-s1e1', title: 'One', parentId: 'aired-s1' }),
					item({
						id: 'aired-s1e2',
						title: 'Two',
						parentId: 'aired-s1',
						episodeNumber: 2,
						file: null,
						quality: null,
						syncState: SyncState.MISSING,
					}),
				],
			});

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(page.items.map((one) => one.id)).toEqual(['aired']);
			// Over its seasons, and the season itself is not a hole — the hole is one
			// level further down, which is the whole reason the state has to carry it.
			expect(page.items[0].missingCount).toBe(0);
		});

		/*
		 * Asked for on the news screen: the two halves, told apart.
		 *
		 * A new episode is tonight and a better encoding of a film already on the disk
		 * is a weekend job — the same list answers both and somebody on a metered
		 * connection wants to read one of them at a time. The world below holds exactly
		 * one of each, so a filter that quietly did nothing would return both and fail.
		 */
		const oneOfEach = () => ({
			items: [
				show('gapped', 'Alpha'),
				item({ id: 'gapped-1', title: 'One', parentId: 'gapped' }),
				item({
					id: 'gapped-2',
					title: 'Two',
					parentId: 'gapped',
					serviceId: 'remote',
					libraryId: 'library-remote',
					syncState: SyncState.MISSING,
				}),
				show('dated', 'Bravo'),
				item({ id: 'dated-1', title: 'One', parentId: 'dated', syncState: SyncState.OUTDATED }),
			],
		});

		it('keeps only the gaps when that is the half asked for', async () => {
			const { manager } = build(oneOfEach());

			const page = await manager.groups(
				query({ rootsOnly: true, actionable: true, reasons: [ActionableReason.GAP] }),
			);

			expect(page.items.map((one) => one.id)).toEqual(['gapped']);
		});

		it('keeps only the better copies when that is the half asked for', async () => {
			const { manager } = build(oneOfEach());

			const page = await manager.groups(
				query({ rootsOnly: true, actionable: true, reasons: [ActionableReason.UPGRADE] }),
			);

			expect(page.items.map((one) => one.id)).toEqual(['dated']);
		});

		it('answers both when no half is named, exactly as it did before the filter', async () => {
			// The default has to be the old behaviour or every caller written before this
			// existed quietly loses rows.
			const { manager } = build(oneOfEach());

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(page.items.map((one) => one.id).sort()).toEqual(['dated', 'gapped']);
		});

		it('reads an empty choice as both rather than as nothing', async () => {
			// It arrives from a screen where somebody unticked every box. A blank page
			// there reads as "you have nothing", which is a different and alarming claim.
			const { manager } = build(oneOfEach());

			const page = await manager.groups(
				query({ rootsOnly: true, actionable: true, reasons: [] }),
			);

			expect(page.items.map((one) => one.id).sort()).toEqual(['dated', 'gapped']);
		});

		/** The tab itself: one listing, two filters, and they narrow together. */
		it('narrows to what is both followed and worth acting on', async () => {
			const { manager } = build({
				items: [
					show('followed-short', 'Alpha'),
					item({
						id: 'followed-short-1',
						title: 'One',
						parentId: 'followed-short',
						serviceId: 'remote',
						libraryId: 'library-remote',
						syncState: SyncState.MISSING,
					}),
					show('followed-complete', 'Bravo'),
					item({ id: 'followed-complete-1', title: 'One', parentId: 'followed-complete' }),
					show('unfollowed-short', 'Charlie'),
					item({
						id: 'unfollowed-short-1',
						title: 'One',
						parentId: 'unfollowed-short',
						serviceId: 'remote',
						libraryId: 'library-remote',
						syncState: SyncState.MISSING,
					}),
				],
				plans: [
					plan({ id: 'p1', scope: { rootItemIds: ['followed-short'] } }),
					plan({ id: 'p2', scope: { rootItemIds: ['followed-complete'] } }),
				],
			});

			const page = await manager.groups(
				query({ rootsOnly: true, followed: true, actionable: true }),
			);

			expect(page.items.map((one) => one.id)).toEqual(['followed-short']);
		});
	});

	/*
	 * The catalogue walk behind the filter, which is where the news wall's five seconds
	 * went.
	 *
	 * Answering "is anything beneath this root missing" means reading every row in scope
	 * and building a skeleton for each. Measured against the owner's live gateway, 31 631
	 * rows: 5.21 s with the filter, 0.62 s without it — and `limit=1` cost the same
	 * 5.38 s, for one item of 1 101 bytes, because none of that work depends on how many
	 * rows the caller asked for. Per page load, it starved the thirty artwork transfers
	 * behind it and the browser dropped them.
	 *
	 * These pin the four things that keep the walk from happening per request. The last
	 * two matter most: a projection served under the wrong key is a wall that says there
	 * is nothing to fetch when there is, which is indistinguishable from a right answer.
	 */
	describe('the catalogue walk behind it', () => {
		const show = (id: string, title: string): MediaItem =>
			item({ id, title, kind: MediaKind.SERIES, file: null, quality: null });

		/** How many times the whole scope was read, which is the expensive half. */
		const walks = (reads: { items: Record<string, jest.Mock> }): number =>
			reads.items.findGroupSeeds.mock.calls.filter(
				([asked]: [GroupSeedQuery]) => asked.rootsOnly === false,
			).length;

		const catalogue = {
			items: [
				show('short', 'Alpha'),
				item({ id: 'short-1', title: 'One', parentId: 'short' }),
				item({
					id: 'short-2',
					title: 'Two',
					parentId: 'short',
					serviceId: 'remote',
					libraryId: 'library-remote',
					syncState: SyncState.MISSING,
				}),
				show('dated', 'Bravo'),
				item({ id: 'dated-1', title: 'One', parentId: 'dated', syncState: SyncState.OUTDATED }),
			],
		};

		it('walks once for both halves rather than once for each', async () => {
			const { manager, reads } = build(catalogue);

			await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(walks(reads)).toBe(1);
		});

		it('does not walk again for the same read', async () => {
			const { manager, reads } = build(catalogue);

			await manager.groups(query({ rootsOnly: true, actionable: true }));
			await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(walks(reads)).toBe(1);
		});

		/*
		 * A search narrows which roots come back and not which rows are in scope, which
		 * is why it is one of the fields the signature leaves out. Walking again for it
		 * would put the five seconds back on every keystroke.
		 */
		it('does not walk again for a filter that does not change the scope', async () => {
			const { manager, reads } = build(catalogue);

			await manager.groups(query({ rootsOnly: true, actionable: true }));
			await manager.groups(query({ rootsOnly: true, actionable: true, search: 'alp' }));

			expect(walks(reads)).toBe(1);
		});

		it('walks again for a scope that is genuinely different', async () => {
			const { manager, reads } = build(catalogue);

			await manager.groups(query({ rootsOnly: true, actionable: true }));
			await manager.groups(
				query({ rootsOnly: true, actionable: true, libraryId: 'library-remote' }),
			);

			expect(walks(reads)).toBe(2);
		});

		/*
		 * Three tabs opening at once is the ordinary case after a restart, and the first
		 * read is the one that pays. Without this they would each start their own walk —
		 * on a Raspberry Pi, three times the work for one answer.
		 */
		it('shares one walk between reads that arrive together', async () => {
			const { manager, reads } = build(catalogue);

			await Promise.all([
				manager.groups(query({ rootsOnly: true, actionable: true })),
				manager.groups(query({ rootsOnly: true, actionable: true })),
				manager.groups(query({ rootsOnly: true, actionable: true })),
			]);

			expect(walks(reads)).toBe(1);
		});

		/*
		 * The one that keeps the answer honest. The key carries the version of the match
		 * table it was built from, so a catalogue that moved cannot be answered from a
		 * projection built before it did — and nobody has to remember to invalidate
		 * anything on the paths that write rows.
		 */
		it('walks again once the catalogue has moved', async () => {
			const { manager, reads, world } = build(catalogue);

			await manager.groups(query({ rootsOnly: true, actionable: true }));

			// A row the applied-pair read filters out, so the version moves and the graph
			// does not: what is under test is the key, not the grouping.
			world.matches.push(correlation({ localItemId: null }));

			await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(walks(reads)).toBe(2);
		});

		it('still answers the same groups from the stored projection', async () => {
			const { manager } = build(catalogue);

			const first = await manager.groups(query({ rootsOnly: true, actionable: true }));
			const second = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(first.items.map((one) => one.id)).toEqual(['short', 'dated']);
			expect(second.items.map((one) => one.id)).toEqual(first.items.map((one) => one.id));
		});

		/*
		 * The pass on a thread of its own, which is the half that makes the rest bearable.
		 *
		 * Reading the catalogue here is not slow, it is *blocking*: `better-sqlite3` is
		 * synchronous, so the five seconds this used to cost were five seconds in which
		 * the gateway read no socket at all and every artwork transfer and the event
		 * stream died together. The version in the answer is what ties it to the
		 * catalogue the key names.
		 */
		it('sends the pass to a worker and reads nothing on this thread', async () => {
			const run = jest.fn(() =>
				Promise.resolve({
					version: '0',
					roots: { 'conflict,missing': ['short'], outdated: ['dated'] },
				}),
			);
			const { manager, reads } = build(catalogue, { available: true, run });

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(run).toHaveBeenCalledWith(
				JobKind.PROJECT,
				expect.objectContaining({
					states: [[SyncState.MISSING, SyncState.CONFLICT], [SyncState.OUTDATED]],
					threshold: 0.8,
				}),
			);
			expect(walks(reads)).toBe(0);
			expect(page.items.map((one) => one.id)).toEqual(['short', 'dated']);
		});

		it('answers the page here when the thread could not, rather than failing it', async () => {
			// The behaviour this gateway had before the thread existed. A dead worker
			// turning every library page into a 500 would be strictly worse than a slow one.
			const run = jest.fn(() => Promise.reject(new Error('the worker did not answer')));
			const { manager, reads } = build(catalogue, { available: true, run });

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(walks(reads)).toBe(1);
			expect(page.items.map((one) => one.id)).toEqual(['short', 'dated']);
		});

		/*
		 * A projection runs while the gateway goes on serving, so a scan can write matches
		 * underneath it. Filing that answer under the version the caller believed in would
		 * leave the wall confidently wrong until something else happened to move the table.
		 */
		it('uses an answer from a catalogue that moved, and does not keep it', async () => {
			const run = jest.fn(() =>
				Promise.resolve({
					version: 'moved',
					roots: { 'conflict,missing': ['short'], outdated: ['dated'] },
				}),
			);
			const { manager } = build(catalogue, { available: true, run });

			await manager.groups(query({ rootsOnly: true, actionable: true }));
			await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(run).toHaveBeenCalledTimes(2);
		});

		/*
		 * The whole point of keeping the question as well as the answer. The cache
		 * announces the change on what `refresh` returns, and every open tab re-reads on
		 * that announcement — so a warm that happened afterwards would be a race the tab
		 * wins, which is exactly why the first page after every scan was the slow one.
		 */
		it('re-projects what somebody was browsing before it says the catalogue moved', async () => {
			const { manager, reads, world } = build(catalogue);

			await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(walks(reads)).toBe(1);

			world.matches.push(correlation({ localItemId: null }));

			await expect(manager.refresh()).resolves.toBe(true);

			// Already walked, off any request, by the time `refresh` answered.
			expect(walks(reads)).toBe(2);

			await manager.groups(query({ rootsOnly: true, actionable: true }));

			// And the request found it waiting: nothing left to walk.
			expect(walks(reads)).toBe(2);
		});

		/*
		 * An answer that came up short is not an empty answer, and the difference is the
		 * whole point: an empty set reads as "nothing beneath this root is missing", so a
		 * malformed answer would show a complete wall over an incomplete library.
		 */
		it('refuses an answer that is missing a state it asked about', async () => {
			const run = jest.fn(() =>
				Promise.resolve({ version: '0', roots: { 'conflict,missing': ['short'] } }),
			);
			const { manager, reads } = build(catalogue, { available: true, run });

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));

			expect(walks(reads)).toBe(1);
			expect(page.items.map((one) => one.id)).toEqual(['short', 'dated']);
		});

		it('warms nothing for a scope nobody has looked at', async () => {
			const { manager, reads } = build(catalogue);

			await expect(manager.refresh()).resolves.toBe(true);

			expect(walks(reads)).toBe(0);
		});
	});


	/**
	 * What can actually be had, which is the complaint `actionable` does not answer.
	 *
	 * `actionable` says there is a hole. It says nothing about whether anybody can fill
	 * it — so the news screen offered twelve cards of which perhaps two were obtainable,
	 * and the other ten were shows nobody is seeding and nobody here holds, told apart
	 * only by opening each one and searching the trackers by hand. That is the whole of
	 * "pas juste notifier sur overseer".
	 *
	 * The dates are written by the episode watch, which already ran those searches every
	 * six hours and dropped the answers.
	 */
	describe('the fetchable filter', () => {
		const show = (id: string, title: string, seen: Partial<MediaItem> = {}): MediaItem =>
			item({ id, title, kind: MediaKind.SERIES, file: null, quality: null, ...seen });

		/** A hole under the show, so every row below is actionable to begin with. */
		const gap = (id: string): MediaItem =>
			item({
				id: `${id}-1`,
				title: 'One',
				parentId: id,
				serviceId: 'remote',
				libraryId: 'library-remote',
				syncState: SyncState.MISSING,
			});

		const world = () => ({
			items: [
				show('tracker', 'Alpha', { releaseSeenAt: new Date() }),
				gap('tracker'),
				show('friend', 'Bravo', { copySeenAt: new Date() }),
				gap('friend'),
				show('nothing', 'Charlie'),
				gap('nothing'),
			],
		});

		it('answers what was seen on each group, so a card can say which it is', async () => {
			const { manager } = build(world());

			const page = await manager.groups(query({ rootsOnly: true, actionable: true }));
			const byId = new Map(page.items.map((one) => [one.id, one.fetchable]));

			expect(byId.get('tracker')).toEqual([NewsSignal.RELEASE]);
			expect(byId.get('friend')).toEqual([NewsSignal.COPY]);
			// Nothing known, which is not nothing available: the watch looks at a batch
			// of shows per pass and has not reached this one.
			expect(byId.get('nothing')).toEqual([]);
		});

		it('keeps only the shows a tracker was seen carrying something for', async () => {
			const { manager } = build(world());

			const page = await manager.groups(
				query({ rootsOnly: true, actionable: true, signals: [NewsSignal.RELEASE] }),
			);

			expect(page.items.map((one) => one.id)).toEqual(['tracker']);
		});

		it('keeps only the shows somebody reachable holds something for', async () => {
			const { manager } = build(world());

			const page = await manager.groups(
				query({ rootsOnly: true, actionable: true, signals: [NewsSignal.COPY] }),
			);

			expect(page.items.map((one) => one.id)).toEqual(['friend']);
		});

		it('takes either when either will do', async () => {
			// The common answer: somebody who wants whatever can be had tonight does not
			// care which of the two it comes from.
			const { manager } = build(world());

			const page = await manager.groups(
				query({
					rootsOnly: true,
					actionable: true,
					signals: [NewsSignal.RELEASE, NewsSignal.COPY],
				}),
			);

			expect(page.items.map((one) => one.id)).toEqual(['tracker', 'friend']);
		});

		it('reads no filter and an empty one as the whole list, not as nothing', async () => {
			// An empty list arrives from a screen where somebody has unticked every box,
			// and an empty page reads as a quiet week rather than as a filter.
			const { manager } = build(world());

			for (const signals of [undefined, []]) {
				const page = await manager.groups(
					query({ rootsOnly: true, actionable: true, signals }),
				);

				expect(page.items.map((one) => one.id)).toEqual(['tracker', 'friend', 'nothing']);
			}
		});

		it('forgets a sighting nobody has refreshed', async () => {
			// A swarm empties. The watch rewrites both columns on every pass, and a
			// sighting it has not managed to come back round to is not believed for ever.
			const { manager } = build({
				items: [
					show('stale', 'Alpha', {
						releaseSeenAt: new Date(Date.now() - SIGHTED_FRESH_FOR - 1000),
					}),
					gap('stale'),
				],
			});

			const page = await manager.groups(
				query({ rootsOnly: true, actionable: true, signals: [NewsSignal.RELEASE] }),
			);

			expect(page.items).toHaveLength(0);
			expect((await manager.groups(query({ rootsOnly: true, actionable: true })))
				.items[0].fetchable).toEqual([]);
		});

		it('counts the groups it kept, so the pager does not count the ones it dropped', async () => {
			/*
			 * Narrowed by the gateway and not by the screen. A wall that dropped rows
			 * after receiving them would page over the ones it dropped: twelve asked for,
			 * four drawn, and a pager still saying twelve.
			 */
			const { manager } = build(world());

			const page = await manager.groups(
				query({ rootsOnly: true, actionable: true, signals: [NewsSignal.RELEASE] }),
			);

			expect(page.pagination.total).toBe(1);
		});
	});
});
