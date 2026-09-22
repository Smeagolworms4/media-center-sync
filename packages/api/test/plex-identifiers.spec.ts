import request from 'supertest';
import {
	LibraryKind,
	MatchStrategy,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	ServerStructureSupport,
	SyncState,
	UserRole,
	type MediaMatch,
	type MediaService,
	type ServerStructure,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import {
	HandlerRegistry,
	RescanOutcome,
	type LibraryRefresh,
	type MediaServiceHandler,
	type NormalisedLibrary,
	type NormalisedMediaItem,
} from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * A Plex that answers with whatever the test hands it, and never leaves the process.
 *
 * Standing in for the real server is the point rather than a convenience: the thing
 * being proved is what the gateway does once an item carries an IMDb number, and a lab
 * Plex would make that answer depend on somebody's container being up, on a token, and
 * on which metadata agent happened to match a film. `PlexHandler`'s own unit tests are
 * where the parsing of a real `Guid` payload is pinned down; nothing here talks to a
 * media server of any kind.
 */
class FakePlex implements MediaServiceHandler {
	public constructor(
		public readonly type: MediaServiceType,
		private readonly _items: NormalisedMediaItem[],
	) {}

	public probe(): never {
		throw new Error('not part of a scan');
	}

	public authenticate(): never {
		throw new Error('not part of a scan');
	}

	public listLibraries(): Promise<NormalisedLibrary[]> {
		return Promise.resolve([]);
	}

	public listServerDirectories(): Promise<ServerStructure> {
		return Promise.resolve({
			support: ServerStructureSupport.UNSUPPORTED,
			path: null,
			parent: null,
			entries: [],
		});
	}

	public async *scanLibrary(): AsyncIterable<NormalisedMediaItem> {
		for (const item of this._items) {
			yield item;
		}
	}

	public refreshLibrary(): Promise<LibraryRefresh> {
		return Promise.resolve({ items: [], cursor: null });
	}

	public requestRescan(): Promise<RescanOutcome> {
		return Promise.resolve(RescanOutcome.UNSUPPORTED);
	}

	public getItem(_connection: unknown, externalId: string): Promise<NormalisedMediaItem | null> {
		return Promise.resolve(this._items.find((item) => item.externalId === externalId) ?? null);
	}

	public openArtwork(): never {
		throw new Error('not part of a scan');
	}

	public openStream(): never {
		throw new Error('not part of a scan');
	}

	public getDownloadUrl(): Promise<string | null> {
		return Promise.resolve(null);
	}
}

const film = (overrides: Partial<NormalisedMediaItem> = {}): NormalisedMediaItem => ({
	externalId: 'plex-1',
	parentExternalId: null,
	kind: MediaKind.MOVIE,
	title: 'Amélie',
	normalizedTitle: 'amelie',
	year: 2001,
	seasonNumber: null,
	episodeNumber: null,
	externalIds: {},
	overview: null,
	artworkUrl: null,
	file: null,
	addedAt: null,
	...overrides,
});

const lastScanAt = async (
	context: TestApp,
	token: string,
	serviceId: string,
): Promise<string | null> => {
	const response = await request(context.app.getHttpServer())
		.get(`/api/services/${serviceId}`)
		.set('Authorization', `Bearer ${token}`)
		.expect(200);

	return (response.body as MediaService).lastScanAt;
};

/**
 * `lastScanAt` and not the index, because the scan answers before it has done anything.
 *
 * It is written once the whole service has been walked, reconciled and correlated, so
 * it is the one signal that cannot race; polling the match list instead would happily
 * read a half-written table and pass.
 */
const waitForScan = async (
	context: TestApp,
	token: string,
	serviceId: string,
	before: string | null,
): Promise<void> => {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if ((await lastScanAt(context, token, serviceId)) !== before) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	throw new Error('the scan never finished');
};

/**
 * The owner's case, end to end: a Plex film and a Jellyfin film that are one film.
 *
 * On his catalogue every Plex row carried nothing but `provider` — Plex's own row key,
 * which names a different film on the next server — because the gateway never asked
 * for the identifiers Plex publishes. So a film on his Plex could only ever be matched
 * to the same film on his Jellyfin by its title, and where the two libraries spell it
 * differently, not at all.
 *
 * Every journey below starts from the state his database is actually in and re-reads
 * the items, which is what a rescan does.
 */
describe('Correlating Plex with Jellyfin on the identifiers Plex publishes', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let jellyfinServiceId: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
	});

	afterAll(async () => {
		await context.close();
	});

	const register = async (
		name: string,
		type: MediaServiceType,
		handler?: MediaServiceHandler,
	): Promise<string> => {
		if (handler) {
			context.app.get(HandlerRegistry).register(handler);
		}

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const service = await services.save(
			services.create({
				name,
				type,
				filesMounted: true,
				// Nothing listens here and nothing needs to: the registered handler is
				// what a scan talks to, and no request ever leaves this process.
				baseUrl: `http://127.0.0.1:9/${name}`,
				status: MediaServiceStatus.ONLINE,
			}),
		);

		await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: `lib-${name}`,
				name: 'Films',
				kind: LibraryKind.MOVIES,
				paths: ['/media/films'],
			}),
		);

		return service.id;
	};

	/** One Jellyfin film, already indexed, exactly as a previous scan left it. */
	const seedJellyfinFilm = async (
		title: string,
		normalizedTitle: string,
		imdb: string | undefined,
	): Promise<string> => {
		const items = context.app.get(MediaItemRepository);
		const libraries = context.app.get(LibraryRepository);
		const library = await libraries.findOne({ where: { serviceId: jellyfinServiceId } });

		const saved = await items.save(
			items.create({
				serviceId: jellyfinServiceId,
				libraryId: library?.id,
				externalId: `jf-${normalizedTitle}-${imdb ?? 'none'}`,
				kind: MediaKind.MOVIE,
				title,
				normalizedTitle,
				year: 2001,
				externalIds: imdb === undefined ? { provider: 'jf-1' } : { imdb, provider: 'jf-1' },
				syncState: SyncState.LOCAL_ONLY,
			}),
		);

		return saved.id;
	};

	const scan = async (serviceId: string): Promise<void> => {
		const before = await lastScanAt(context, admin.token, serviceId);

		await request(context.app.getHttpServer())
			.post(`/api/services/${serviceId}/scan`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(202);

		await waitForScan(context, admin.token, serviceId, before);
	};

	/**
	 * What the item's page shows, which is both halves of every pair it takes part in.
	 *
	 * A correlation is written from each side — this item is the local half of one row
	 * and the remote half of the other — so one pair reads as two rows here. That is
	 * the route's contract and not an artefact: `MediaManager.matches` merges the two
	 * queries on purpose, because listing only one side would make half of an item's
	 * correlations invisible from the page they concern.
	 */
	const matchesOf = async (itemId: string): Promise<MediaMatch[]> => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${itemId}/matches`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return response.body as MediaMatch[];
	};

	/** The distinct pairs behind those rows, as a person reading the page sees them. */
	const pairsOf = async (itemId: string): Promise<MediaMatch[]> => {
		const rows = await matchesOf(itemId);
		const seen = new Set<string>();

		return rows.filter((row) => {
			const key = [row.localItemId, row.remoteItemId].sort().join('|');

			return seen.has(key) ? false : (seen.add(key), true);
		});
	};

	beforeAll(async () => {
		jellyfinServiceId = await register('jellyfin', MediaServiceType.JELLYFIN);
	});

	it('matches two films no title comparison could ever have reconciled', async () => {
		/*
		 * The headline, and the reason `provider` was never enough. The same film is
		 * `Amélie` on one server and `Le Fabuleux Destin d'Amélie Poulain` on the other
		 * — which is how the two libraries genuinely spell it — so the titles never
		 * meet, and before the identifiers arrived there was nothing else to try.
		 */
		const jellyfinId = await seedJellyfinFilm(
			"Le Fabuleux Destin d'Amélie Poulain",
			'fabuleux destin amelie poulain',
			'tt0211915',
		);

		const plexId = await register(
			'plex-amelie',
			MediaServiceType.PLEX,
			new FakePlex(
				MediaServiceType.PLEX,
				[film({ externalIds: { imdb: 'tt0211915', provider: '5' } })],
			),
		);

		await scan(plexId);

		const matches = await pairsOf(jellyfinId);

		expect(matches).toHaveLength(1);
		expect(matches[0].strategy).toBe(MatchStrategy.EXTERNAL_ID);
		// Above the default threshold, so the gateway may act on it — which is the
		// difference between two posters and one film held by two servers.
		expect(matches[0].confidence).toBeGreaterThanOrEqual(0.98);
	});

	it('promotes a title guess already on record into proof', async () => {
		// The state his database is in: a pair decided before any Plex item carried an
		// identifier, sitting below the threshold and therefore doing nothing.
		const jellyfinId = await seedJellyfinFilm('The Office', 'office', 'tt0386676');
		const plexId = await register(
			'plex-office',
			MediaServiceType.PLEX,
			new FakePlex(MediaServiceType.PLEX, [
				film({
					externalId: 'plex-office-1',
					title: 'The Office',
					normalizedTitle: 'office',
					externalIds: { imdb: 'tt0386676', provider: '7' },
				}),
			]),
		);

		const items = context.app.get(MediaItemRepository);
		const libraries = context.app.get(LibraryRepository);
		const library = await libraries.findOne({ where: { serviceId: plexId } });
		const plexRow = await items.save(
			items.create({
				serviceId: plexId,
				libraryId: library?.id,
				externalId: 'plex-office-1',
				kind: MediaKind.MOVIE,
				title: 'The Office',
				normalizedTitle: 'office',
				// What a Plex row looked like before: its own key and nothing else.
				externalIds: { provider: '7' },
				syncState: SyncState.MISSING,
			}),
		);

		await context.app.get(MediaMatchRepository).save(
			context.app.get(MediaMatchRepository).create({
				localItemId: jellyfinId,
				remoteItemId: plexRow.id,
				remoteServiceId: plexId,
				strategy: MatchStrategy.NORMALIZED_TITLE,
				confidence: 0.7,
				state: SyncState.MISSING,
			}),
		);

		expect((await pairsOf(jellyfinId))[0].strategy).toBe(MatchStrategy.NORMALIZED_TITLE);

		await scan(plexId);

		const matches = await pairsOf(jellyfinId);

		expect(matches).toHaveLength(1);
		expect(matches[0].strategy).toBe(MatchStrategy.EXTERNAL_ID);
		expect(matches[0].confidence).toBeGreaterThanOrEqual(0.98);
	});

	it('revokes a title match the identifiers turn out to contradict', async () => {
		/*
		 * Two different films that share a title exactly, which is what identifiers
		 * exist to separate. Leaving the pair applied would have the gateway offer one
		 * as a source for the other, and the title agrees perfectly — nothing weaker
		 * than a number can settle it.
		 */
		const jellyfinId = await seedJellyfinFilm('Solaris', 'solaris', 'tt0069293');
		const plexId = await register(
			'plex-solaris',
			MediaServiceType.PLEX,
			new FakePlex(MediaServiceType.PLEX, [
				film({
					externalId: 'plex-solaris-1',
					title: 'Solaris',
					normalizedTitle: 'solaris',
					externalIds: { imdb: 'tt0307479', provider: '9' },
				}),
			]),
		);

		const items = context.app.get(MediaItemRepository);
		const libraries = context.app.get(LibraryRepository);
		const library = await libraries.findOne({ where: { serviceId: plexId } });
		const plexRow = await items.save(
			items.create({
				serviceId: plexId,
				libraryId: library?.id,
				externalId: 'plex-solaris-1',
				kind: MediaKind.MOVIE,
				title: 'Solaris',
				normalizedTitle: 'solaris',
				externalIds: { provider: '9' },
				syncState: SyncState.MISSING,
			}),
		);

		const matches = context.app.get(MediaMatchRepository);

		await matches.save(
			matches.create({
				localItemId: jellyfinId,
				remoteItemId: plexRow.id,
				remoteServiceId: plexId,
				strategy: MatchStrategy.NORMALIZED_TITLE,
				confidence: 0.95,
				state: SyncState.MISSING,
			}),
		);

		expect(await pairsOf(jellyfinId)).toHaveLength(1);

		await scan(plexId);

		expect(await matchesOf(jellyfinId)).toEqual([]);
	});

	it('leaves a pair alone when only one of the two libraries scrapes', async () => {
		// The ordinary house, and the reason absence is not disagreement: revoking here
		// would unpick every correct match on a gateway with one unscraped library.
		const jellyfinId = await seedJellyfinFilm('Stalker', 'stalker', undefined);
		const plexId = await register(
			'plex-stalker',
			MediaServiceType.PLEX,
			new FakePlex(MediaServiceType.PLEX, [
				film({
					externalId: 'plex-stalker-1',
					title: 'Stalker',
					normalizedTitle: 'stalker',
					externalIds: { imdb: 'tt0079944', provider: '11' },
				}),
			]),
		);

		await scan(plexId);

		const matches = await pairsOf(jellyfinId);

		expect(matches).toHaveLength(1);
		expect(matches[0].strategy).toBe(MatchStrategy.NORMALIZED_TITLE);
	});

	it('never overrules a pair somebody confirmed by hand', async () => {
		// Confirming is precisely the act of overruling the score, so a later pass that
		// recomputed it would undo the confirmation the next time anybody scanned —
		// silently, with nothing on screen saying the machine had changed its mind back.
		const jellyfinId = await seedJellyfinFilm('Dune', 'dune', 'tt0087182');
		const plexId = await register(
			'plex-dune',
			MediaServiceType.PLEX,
			new FakePlex(MediaServiceType.PLEX, [
				film({
					externalId: 'plex-dune-1',
					title: 'Dune',
					normalizedTitle: 'dune',
					externalIds: { imdb: 'tt1160419', provider: '13' },
				}),
			]),
		);

		const items = context.app.get(MediaItemRepository);
		const libraries = context.app.get(LibraryRepository);
		const library = await libraries.findOne({ where: { serviceId: plexId } });
		const plexRow = await items.save(
			items.create({
				serviceId: plexId,
				libraryId: library?.id,
				externalId: 'plex-dune-1',
				kind: MediaKind.MOVIE,
				title: 'Dune',
				normalizedTitle: 'dune',
				externalIds: { provider: '13' },
				syncState: SyncState.MISSING,
			}),
		);

		const matches = context.app.get(MediaMatchRepository);

		await matches.save(
			matches.create({
				localItemId: jellyfinId,
				remoteItemId: plexRow.id,
				remoteServiceId: plexId,
				strategy: MatchStrategy.MANUAL,
				confidence: 1,
				state: SyncState.MISSING,
				confirmedAt: new Date('2026-02-01T00:00:00.000Z'),
			}),
		);

		await scan(plexId);

		const kept = await pairsOf(jellyfinId);

		expect(kept).toHaveLength(1);
		expect(kept[0].strategy).toBe(MatchStrategy.MANUAL);
		expect(kept[0].confirmedAt).not.toBeNull();
	});
});
