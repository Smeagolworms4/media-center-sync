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
 * A media server that files episodes in folders its own numbers contradict.
 *
 * Stands in for a real one rather than reaching one, for the reason `CatalogueHandler`
 * beside it gives: the question is what the gateway does with an enumeration.
 */
class FolderHandler implements MediaServiceHandler {
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

	/** Nothing to ask a fixture for: what it reports is what the test put in it. */
	public refreshItem(): Promise<boolean> {
		return Promise.resolve(false);
	}

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
	normalizedTitle: 'death note',
	year: 2006,
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
 * The owner's Death Note, in miniature, as his Jellyfin publishes it.
 *
 * One series, correctly identified, with a real `Saison 1` — and beside it a folder
 * the server also calls a season and cannot number, holding two episodes it has itself
 * stamped as belonging to season one, plus one genuine extra it has stamped with
 * nothing at all. Every part of that shape is load-bearing: the numbered pair is what
 * has to move, the extra is what has to stay, and the folder is what has to stop being
 * drawn once it holds only the extra.
 */
const CATALOGUE: NormalisedMediaItem[] = [
	reported({
		externalId: 'series',
		kind: MediaKind.SERIES,
		title: 'Death Note',
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
	reported({
		externalId: 'unknown-season',
		parentExternalId: 'series',
		kind: MediaKind.SEASON,
		title: 'Saison inconnue',
		seasonNumber: null,
		episodeNumber: null,
	}),
	reported({
		externalId: 'episode-1',
		parentExternalId: 'season-1',
		title: 'Renaissance',
		episodeNumber: 1,
	}),
	reported({
		externalId: 'relight-1',
		parentExternalId: 'unknown-season',
		title: 'Relight : la vision d’un dieu',
		seasonNumber: 1,
		episodeNumber: 40,
	}),
	reported({
		externalId: 'relight-2',
		parentExternalId: 'unknown-season',
		title: 'Relight 2 : la relève de L',
		seasonNumber: 1,
		episodeNumber: 41,
	}),
	reported({
		externalId: 'making-of',
		parentExternalId: 'unknown-season',
		title: 'Making-of',
		seasonNumber: null,
		episodeNumber: null,
	}),
];

describe('A scan files episodes by their numbers, not by their folder', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let serviceId: string;

	const http = () => request(context.app.getHttpServer());
	const auth = (): [string, string] => ['Authorization', `Bearer ${admin.token}`];

	const lastScanAt = async (): Promise<string | null> => {
		const response = await http()
			.get(`/api/services/${serviceId}`)
			.set(...auth())
			.expect(200);

		return (response.body as MediaService).lastScanAt;
	};

	/** See the same helper in `media-reparent.spec.ts`: a scan answers before it acts. */
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

	const drawnUnder = async (id: string): Promise<string[]> =>
		((await node(id)).children ?? []).map((child) => child.title);

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

	const byTitle = (items: MediaItem[], title: string): MediaItem | undefined =>
		items.find((item) => item.title === title);

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		context.app.get(HandlerRegistry).register(new FolderHandler([...CATALOGUE]));

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const service = await services.save(
			services.create({
				name: 'MisaMisa',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:9/misamisa',
				status: MediaServiceStatus.ONLINE,
			}),
		);

		serviceId = service.id;

		await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-animes',
				name: 'Animes - Séries',
				kind: LibraryKind.SHOWS,
				paths: ['/media/animes'],
			}),
		);

		await scan();
	});

	afterAll(async () => {
		await context.close();
	});

	it('moves the numbered episodes out of the folder and under season one', async () => {
		const [series] = await rows('kind=series&limit=10');
		const seasons = await children(series.id);
		const seasonOne = byTitle(seasons, 'Saison 1');

		expect(seasonOne).toBeDefined();

		const titles = (await children(seasonOne!.id)).map((episode) => episode.title);

		expect(titles).toContain('Relight : la vision d’un dieu');
		expect(titles).toContain('Relight 2 : la relève de L');
		expect(titles).toContain('Renaissance');
	});

	it('leaves the extra its server numbered with nothing exactly where it was', async () => {
		// A making-of has nothing to file it by, and sweeping it into season one would
		// be inventing a fact rather than reading one.
		const [series] = await rows('kind=series&limit=10');
		const folder = byTitle(await children(series.id), 'Saison inconnue');

		expect(folder).toBeDefined();
		expect((await children(folder!.id)).map((item) => item.title)).toEqual(['Making-of']);
	});

	it('draws a folder that still holds something, and stops drawing an emptied one', async () => {
		/*
		 * The visible half of the rule, and the reason it is asserted on the tree rather
		 * than on the rows: a folder whose episodes have all been filed elsewhere has no
		 * business claiming a line on the show's page, but the row itself is kept — the
		 * service reports it, and deleting it would have every scan rebuild it and
		 * destroy its correlations on the way.
		 */
		const [series] = await rows('kind=series&limit=10');
		const drawn = await drawnUnder(series.id);

		expect(drawn).toContain('Saison 1');
		expect(drawn).toContain('Saison inconnue');

		// And with the extra gone, the folder goes from the tree without going from the
		// index: nothing is under it any more.
		const folder = byTitle(await children(series.id), 'Saison inconnue');
		const extra = (await children(folder!.id))[0];

		await http()
			.put(`/api/media/${extra.id}/override`)
			.set(...auth())
			.send({ seasonNumber: 1 })
			.expect(200);

		expect(await drawnUnder(series.id)).not.toContain('Saison inconnue');
		expect(byTitle(await children(series.id), 'Saison inconnue')).toBeDefined();
	});

	it('files them the same way again when the service reports the same shape', async () => {
		// A scan rewrites `parentId` from the parent the service names, which is the
		// folder. Without the pass at the end of it, every scan would undo the filing.
		await scan();

		const [series] = await rows('kind=series&limit=10');
		const seasonOne = byTitle(await children(series.id), 'Saison 1');
		const titles = (await children(seasonOne!.id)).map((episode) => episode.title);

		expect(titles).toContain('Relight : la vision d’un dieu');
		expect(titles).toContain('Relight 2 : la relève de L');
	});
});
