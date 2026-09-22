import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	ServerStructureSupport,
	UserRole,
	type MediaItem,
	type MediaNode,
	type MediaService,
	type ResultList,
	type ServerStructure,
} from '@mcs/shared';
import { LibraryRepository, MediaServiceRepository } from '@/repositories';
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
 * A media server whose catalogue the test can rewrite between two scans.
 *
 * It stands in for a real one rather than reaching one, like `OrderedHandler` beside
 * it: the question here is what the gateway does with an enumeration, and a lab
 * Jellyfin would make the answer depend on a container being up.
 *
 * The mutable catalogue is the whole point of this file. A correction has to survive a
 * scan that still reports the old numbers, and an item nobody corrects has to follow
 * its server when that server changes its mind — two behaviours that need the same
 * fixture scanned twice with different answers.
 */
class CatalogueHandler implements MediaServiceHandler {
	public readonly type = MediaServiceType.JELLYFIN;

	public constructor(public catalogue: NormalisedMediaItem[]) {}

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
		for (const item of this.catalogue) {
			yield item;
		}
	}

	public refreshLibrary(): Promise<LibraryRefresh> {
		return Promise.resolve({ items: [], cursor: null });
	}

	/**
	 * Answered rather than thrown although no scan here asks for it: a landing settles
	 * at the end of every pass and may ask the service to re-read itself, and throwing
	 * would fail a test about filing with a message about a rescan.
	 */
	public requestRescan(): Promise<RescanOutcome> {
		return Promise.resolve(RescanOutcome.UNSUPPORTED);
	}

	public getItem(_connection: unknown, externalId: string): Promise<NormalisedMediaItem | null> {
		return Promise.resolve(this.catalogue.find((item) => item.externalId === externalId) ?? null);
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

const reported = (overrides: Partial<NormalisedMediaItem> = {}): NormalisedMediaItem => ({
	externalId: 'external-1',
	parentExternalId: null,
	kind: MediaKind.EPISODE,
	title: 'Episode',
	normalizedTitle: 'beyblade',
	year: 2001,
	seasonNumber: 1,
	episodeNumber: 1,
	externalIds: {},
	overview: null,
	artworkUrl: null,
	file: null,
	addedAt: null,
	...overrides,
});

/**
 * The show the owner actually hit it on, in miniature.
 *
 * Season one and nothing else, because that is the case: the service is certain the
 * episode belongs to season one, and there is no season two anywhere for it to move
 * to. The French title is not decoration — it is what proves the created season is
 * named beside its siblings rather than in our own words.
 */
const CATALOGUE: NormalisedMediaItem[] = [
	reported({
		externalId: 'series',
		kind: MediaKind.SERIES,
		title: 'Beyblade',
		seasonNumber: null,
		episodeNumber: null,
	}),
	reported({
		externalId: 'season-1',
		parentExternalId: 'series',
		kind: MediaKind.SEASON,
		title: 'Saison 1',
		episodeNumber: null,
	}),
	...[13, 14, 15].map((number) =>
		reported({
			externalId: `episode-${number}`,
			parentExternalId: 'season-1',
			title: number === 14 ? 'L’Apparition d’un rival' : `Episode ${number}`,
			episodeNumber: number,
		}),
	),
];

describe('Correcting a season number moves the episode', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let handler: CatalogueHandler;
	let serviceId: string;
	/** Filled once the first scan has written the tree; see `beforeAll`. */
	const id: Record<string, string> = {};

	const http = () => request(context.app.getHttpServer());
	const auth = (): [string, string] => ['Authorization', `Bearer ${admin.token}`];

	const lastScanAt = async (): Promise<string | null> => {
		const response = await http()
			.get(`/api/services/${serviceId}`)
			.set(...auth())
			.expect(200);

		return (response.body as MediaService).lastScanAt;
	};

	/**
	 * A scan answers before it has done anything, so something has to wait for it.
	 *
	 * `lastScanAt` is written once the whole service has been walked and reconciled,
	 * which makes it the one signal that does not race — polling the index instead
	 * would happily read a half-written tree and pass.
	 */
	const scan = async (): Promise<void> => {
		const before = await lastScanAt();

		await http()
			.post(`/api/services/${serviceId}/scan`)
			.set(...auth())
			.expect(202);

		for (let attempt = 0; attempt < 400; attempt += 1) {
			if ((await lastScanAt()) !== before) {
				return;
			}

			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		throw new Error('the scan never finished');
	};

	const node = async (id: string): Promise<MediaNode> =>
		(
			await http()
				.get(`/api/media/${id}`)
				.set(...auth())
				.expect(200)
		).body as MediaNode;

	const rows = async (query: string): Promise<MediaItem[]> =>
		(
			(
				await http()
					.get(`/api/media?${query}`)
					.set(...auth())
					.expect(200)
			).body as ResultList<MediaItem>
		).items;

	const children = async (id: string): Promise<MediaItem[]> =>
		(
			(
				await http()
					.get(`/api/media/${id}/children?limit=200`)
					.set(...auth())
					.expect(200)
			).body as ResultList<MediaItem>
		).items;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		handler = new CatalogueHandler([...CATALOGUE]);

		context.app.get(HandlerRegistry).register(handler);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const service = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				// Nothing listens here, and nothing needs to: the registered handler is
				// what a scan talks to.
				baseUrl: 'http://127.0.0.1:9/living-room',
				status: MediaServiceStatus.ONLINE,
			}),
		);

		serviceId = service.id;

		await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/media/shows'],
			}),
		);

		await scan();

		/*
		 * The identifiers are read once and held, because the assertions are about
		 * where a row *moved* to. The public item shape carries no external identifier,
		 * and matching on a title or a number would stop working in the very tests that
		 * change one of them.
		 */
		const [series] = await rows('kind=series&limit=10');

		id.series = series.id;
		id.seasonOne = (await children(series.id))[0].id;

		const episodes = await children(id.seasonOne);

		id.thirteen = episodes[0].id;
		id.fourteen = episodes[1].id;
		id.fifteen = episodes[2].id;
	});

	afterAll(async () => {
		await context.close();
	});

	it('files the episode under a season it had to invent, and says so in the tree', async () => {
		expect((await node(id.fourteen)).parentId).toBe(id.seasonOne);

		const corrected = (
			await http()
				.put(`/api/media/${id.fourteen}/override`)
				.set(...auth())
				.send({ seasonNumber: 2, episodeNumber: 1 })
				.expect(200)
		).body as MediaItem;

		expect(corrected.seasonNumber).toBe(2);
		// The number changed and so did the place. Without the second half the episode
		// reads `S2E1` from inside season one, which is both "it doesn't show up under
		// season 2" and — since children are ordered by season then episode — "it
		// disappeared", at the bottom of a list nobody scrolls.
		expect(corrected.parentId).not.toBe(id.seasonOne);

		const seasons = await children(id.series);
		const seasonTwo = seasons.find((row) => row.seasonNumber === 2);

		expect(seasonTwo).toBeDefined();
		// Named beside its sibling rather than in English: the household reads
		// `Saison 1`, and `Season 2` next to it announces that something other than
		// their server made this row.
		expect(seasonTwo?.title).toBe('Saison 2');
		expect(corrected.parentId).toBe(seasonTwo?.id);

		expect((await children(seasonTwo?.id as string)).map((row) => row.id)).toEqual([id.fourteen]);
		expect((await children(id.seasonOne)).map((row) => row.id)).toEqual([
			id.thirteen,
			id.fifteen,
		]);
	});

	it('keeps the invented season through a scan that has never heard of it', async () => {
		// The service still reports three episodes of season one and no season two, so
		// the pass that drops what a scan no longer saw would take the created row —
		// and the episode would be filed back under season one. That is the correction
		// undoing itself on a timer, with no error anywhere.
		const before = (await children(id.series)).find((row) => row.seasonNumber === 2);

		await scan();

		const seasons = await children(id.series);
		const seasonTwo = seasons.filter((row) => row.seasonNumber === 2);

		expect(seasonTwo).toHaveLength(1);
		// The same row, not a second one built beside it: a scan that re-created it
		// every pass would leave a season per scan on the series page.
		expect(seasonTwo[0].id).toBe(before?.id);

		const episode = await node(id.fourteen);

		expect(episode.seasonNumber).toBe(2);
		expect(episode.parentId).toBe(seasonTwo[0].id);
		expect((await children(seasonTwo[0].id)).map((row) => row.id)).toEqual([id.fourteen]);
	});

	it('puts the episode back where the service files it, and takes the invented season away', async () => {
		await http()
			.delete(`/api/media/${id.fourteen}/override`)
			.set(...auth())
			.expect(200);

		const restored = await node(id.fourteen);

		expect(restored.seasonNumber).toBe(1);
		expect(restored.episodeNumber).toBe(14);
		expect(restored.parentId).toBe(id.seasonOne);
		expect((await children(id.seasonOne)).map((row) => row.id)).toEqual([
			id.thirteen,
			id.fourteen,
			id.fifteen,
		]);

		// And the season nobody is under any more goes. Nothing else could ever remove
		// it: no service will stop reporting a row no service ever reported, so it
		// would sit on the series page for the rest of the gateway's life.
		expect((await children(id.series)).map((row) => row.seasonNumber)).toEqual([1]);
	});

	/**
	 * The point of telling a correction from a value that merely repeats the service.
	 *
	 * An item with no correction keeps following its server, so the day it fixes a
	 * title the next scan picks it up. An item whose correction happens to equal
	 * today's reported values is frozen on them for ever, and no scan changes it again
	 * — invisible the day it is made, impossible to explain six months later.
	 */
	describe('a correction that repeats what the service says', () => {
		it('is recorded as no correction at all', async () => {
			const episode = await node(id.thirteen);

			const saved = (
				await http()
					.put(`/api/media/${id.thirteen}/override`)
					.set(...auth())
					// Exactly what the interface sends after "reset to what the service
					// reports": every box holds the reported value.
					.send({ title: episode.title, year: episode.year, seasonNumber: 1, episodeNumber: 13 })
					.expect(200)
			).body as MediaItem;

			expect(saved.overrides).toBeNull();
			expect(saved.reported).toBeNull();
		});

		it('leaves the item free to follow its server the next time the server changes', async () => {
			handler.catalogue = handler.catalogue.map((entry) =>
				entry.externalId === 'episode-13'
					? { ...entry, title: 'Le Tournoi régional' }
					: entry,
			);

			await scan();

			expect((await node(id.thirteen)).title).toBe('Le Tournoi régional');
		});

		it('keeps a real correction through the same scan', async () => {
			await http()
				.put(`/api/media/${id.fifteen}/override`)
				.set(...auth())
				.send({ title: 'What the household calls it' })
				.expect(200);

			handler.catalogue = handler.catalogue.map((entry) =>
				entry.externalId === 'episode-15' ? { ...entry, title: 'Renamed by the server' } : entry,
			);

			await scan();

			const kept = await node(id.fifteen);

			expect(kept.title).toBe('What the household calls it');
			// And the service's own answer moved underneath it, so withdrawing the
			// correction gives back today's title rather than the one it replaced.
			expect(kept.reported?.title).toBe('Renamed by the server');
		});
	});
});
