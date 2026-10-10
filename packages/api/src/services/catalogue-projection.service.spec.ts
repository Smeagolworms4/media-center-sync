import { MediaKind, SyncState } from '@mcs/shared';
import type {
	GroupSeedQuery,
	MediaItemDigest,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import { CatalogueProjectionService } from './catalogue-projection.service';

/**
 * The catalogue pass, over fake repositories.
 *
 * What is pinned here is what the *answer* has to carry, because this answer now
 * crosses a thread boundary: the version it was computed against, a set per state group
 * asked for, and nothing that could not be structured-cloned. The grouping rule itself
 * has its own suite, and so does the manager that reads this.
 */
const digest = (over: Partial<MediaItemDigest> & { id: string }): MediaItemDigest => ({
	serviceId: 'local',
	libraryId: 'library-local',
	parentId: null,
	kind: MediaKind.EPISODE,
	syncState: SyncState.IN_SYNC,
	episodeNumber: 1,
	episodeNumberEnd: null,
	ignored: false,
	hasFile: true,
	releaseSeenAt: null,
	copySeenAt: null,
	...over,
});

const build = (
	world: {
		rows?: MediaItemDigest[];
		outside?: MediaItemDigest[];
		pairs?: { localItemId: string; remoteItemId: string; state: SyncState }[];
		version?: string;
	} = {},
) => {
	const rows = world.rows ?? [];
	const outside = world.outside ?? [];

	const items = {
		findGroupSeeds: jest.fn((query: GroupSeedQuery) =>
			Promise.resolve(rows.slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? rows.length))),
		),
		findDigests: jest.fn((ids: string[]) =>
			Promise.resolve(outside.filter((row) => ids.includes(row.id))),
		),
	};

	const matches = {
		version: jest.fn(() => Promise.resolve(world.version ?? '7')),
		findAppliedPairs: jest.fn(() => Promise.resolve(world.pairs ?? [])),
	};

	const services = {
		// One service whose files this gateway reaches, which is what makes a state
		// readable at all: a group with no local copy is `missing` by rule.
		find: jest.fn(() =>
			Promise.resolve([
				{ id: 'local', filesMounted: true, peerId: null },
				{ id: 'remote', filesMounted: false, peerId: null },
			]),
		),
	};

	return {
		projection: new CatalogueProjectionService(
			items as unknown as MediaItemRepository,
			matches as unknown as MediaMatchRepository,
			services as unknown as MediaServiceRepository,
		),
		reads: { items, matches, services },
	};
};

/** A series with one episode beneath it, in whatever state the caller names. */
const show = (id: string, state: SyncState): MediaItemDigest[] => [
	digest({ id, kind: MediaKind.SERIES, parentId: null, hasFile: false }),
	digest({ id: `${id}-1`, parentId: id, syncState: state }),
];

describe('CatalogueProjectionService', () => {
	it('names the root above everything in the states it was asked about', async () => {
		const { projection } = build({
			rows: [...show('alpha', SyncState.MISSING), ...show('bravo', SyncState.IN_SYNC)],
		});

		const answer = await projection.project({
			seedQuery: { rootsOnly: true },
			states: [[SyncState.MISSING]],
			threshold: 0.8,
		});

		expect(answer.roots).toEqual({ missing: ['alpha'] });
	});

	it('answers the version it read, so the caller can tell the catalogue moved', async () => {
		/*
		 * The pass runs while the gateway goes on serving, so a scan can write matches
		 * underneath it. Without this the caller would file a correct answer under the
		 * version it happened to believe in, and the wall would stay wrong until
		 * something else moved the table.
		 */
		const { projection } = build({ version: '41', rows: show('alpha', SyncState.MISSING) });

		const answer = await projection.project({
			seedQuery: {},
			states: [[SyncState.MISSING]],
			threshold: 0.8,
		});

		expect(answer.version).toBe('41');
	});

	it('answers one set per group of states, under a name their order cannot change', async () => {
		const { projection } = build({
			rows: [
				...show('alpha', SyncState.MISSING),
				...show('bravo', SyncState.OUTDATED),
			],
		});

		const answer = await projection.project({
			seedQuery: {},
			states: [
				[SyncState.CONFLICT, SyncState.MISSING],
				[SyncState.OUTDATED],
			],
			threshold: 0.8,
		});

		expect(answer.roots).toEqual({ 'conflict,missing': ['alpha'], outdated: ['bravo'] });
	});

	it('walks the states once however often they are asked for', async () => {
		// Two callers' questions arrive merged, and the same question twice is a
		// coincidence rather than a mistake: it must not cost a second traversal.
		const { projection } = build({ rows: show('alpha', SyncState.MISSING) });

		const answer = await projection.project({
			seedQuery: {},
			states: [[SyncState.MISSING], [SyncState.MISSING]],
			threshold: 0.8,
		});

		expect(Object.keys(answer.roots)).toEqual(['missing']);
	});

	it('reads the scope in pages rather than in one statement', async () => {
		/*
		 * `better-sqlite3` is synchronous, so one statement over thirty-one thousand rows
		 * is one uninterruptible block — 177 ms on the owner's catalogue, measured. This
		 * pass runs on a thread of its own now, but it also runs in-process wherever
		 * there is no worker, and there the pages are the difference between a gateway
		 * that answers and one that is deaf.
		 */
		const { projection, reads } = build({
			rows: Array.from({ length: 9_000 }, (_unused, at) =>
				digest({ id: `row-${at}`, parentId: 'alpha' }),
			),
		});

		await projection.project({ seedQuery: {}, states: [[SyncState.MISSING]], threshold: 0.8 });

		const pages = reads.items.findGroupSeeds.mock.calls.map(([asked]: [GroupSeedQuery]) => asked.skip);

		expect(pages).toEqual([0, 4_000, 8_000]);
	});

	it('reads the whole scope whatever the caller filtered or paged', async () => {
		// The answer is about everything beneath a root: a search names the poster rather
		// than its episodes, and a kind filter would hide the very children being counted.
		const { projection, reads } = build({ rows: show('alpha', SyncState.MISSING) });

		await projection.project({
			seedQuery: { rootsOnly: true, search: 'alp', kind: MediaKind.SERIES, skip: 40, take: 12 },
			states: [[SyncState.MISSING]],
			threshold: 0.8,
		});

		expect(reads.items.findGroupSeeds).toHaveBeenCalledWith(
			expect.objectContaining({ rootsOnly: false, search: undefined, kind: undefined, skip: 0 }),
		);
	});

	it('counts the copies the filter left out when it decides a state', async () => {
		/*
		 * A media held on a friend's server and not here reads `missing` only because
		 * that copy was looked at — and the filter that produced the scope may well have
		 * excluded it. Reading only what came back would call the group `in_sync` on the
		 * strength of the one row the filter kept.
		 */
		const { projection } = build({
			rows: [
				digest({ id: 'alpha', kind: MediaKind.SERIES, hasFile: false }),
				digest({ id: 'ours', parentId: 'alpha', serviceId: 'remote', syncState: SyncState.IN_SYNC }),
			],
			outside: [
				digest({ id: 'theirs', parentId: 'alpha', serviceId: 'local', syncState: SyncState.MISSING }),
			],
			pairs: [{ localItemId: 'ours', remoteItemId: 'theirs', state: SyncState.IN_SYNC }],
		});

		const answer = await projection.project({
			seedQuery: {},
			states: [[SyncState.MISSING]],
			threshold: 0.8,
		});

		expect(answer.roots).toEqual({ missing: ['alpha'] });
	});

	it('builds the graph once for two projections of the same catalogue', async () => {
		/*
		 * A catalogue change triggers one projection per scope somebody has been looking
		 * at, and they arrive together. Reading the whole match table once per scope would
		 * be the cost this thread exists to remove, moved rather than removed.
		 */
		const { projection, reads } = build({ rows: show('alpha', SyncState.MISSING) });
		const ask = () =>
			projection.project({ seedQuery: {}, states: [[SyncState.MISSING]], threshold: 0.8 });

		await ask();
		await ask();

		expect(reads.matches.findAppliedPairs).toHaveBeenCalledTimes(1);
	});

	it('builds it again for a threshold that joins different rows', async () => {
		// What joins depends on the threshold in force, which is why a stored `groupId`
		// could never answer this. A graph kept across a change of it would be wrong.
		const { projection, reads } = build({ rows: show('alpha', SyncState.MISSING) });

		await projection.project({ seedQuery: {}, states: [[SyncState.MISSING]], threshold: 0.8 });
		await projection.project({ seedQuery: {}, states: [[SyncState.MISSING]], threshold: 0.5 });

		expect(reads.matches.findAppliedPairs).toHaveBeenCalledTimes(2);
	});

	it('climbs to the top of the parent chain, not to the row above', async () => {
		// Series, season, episode: a hole three levels down has to make the poster appear,
		// because the poster is what the library screen shows.
		const { projection } = build({
			rows: [
				digest({ id: 'series', kind: MediaKind.SERIES, hasFile: false }),
				digest({ id: 'season', kind: MediaKind.SEASON, parentId: 'series', hasFile: false }),
				digest({ id: 'episode', parentId: 'season', syncState: SyncState.MISSING }),
			],
		});

		const answer = await projection.project({
			seedQuery: {},
			states: [[SyncState.MISSING]],
			threshold: 0.8,
		});

		expect(answer.roots).toEqual({ missing: ['series'] });
	});
});
