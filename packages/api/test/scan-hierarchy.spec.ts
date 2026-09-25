import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	ServerStructureSupport,
	UserRole,
	type MediaGroup,
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
 * A handler that reports its items in whatever order the test asks for.
 *
 * It stands in for a real media server rather than reaching one: the point being
 * tested is what the gateway does with an enumeration, and a lab Jellyfin would make
 * the answer depend on a container being up and on how it happens to sort.
 *
 * Everything not involved in a scan throws. A silent default would let a route that
 * started calling one of these pass this file and fail in production.
 */
class OrderedHandler implements MediaServiceHandler {
	public readonly type = MediaServiceType.JELLYFIN;

	/** Identifiers the gateway asked for by hand, which is the fetch path's evidence. */
	public readonly asked: string[] = [];

	public constructor(
		private readonly _enumerated: NormalisedMediaItem[],
		private readonly _held: NormalisedMediaItem[] = _enumerated,
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

	/** Not part of a scan, but answered rather than thrown, like `requestRescan`. */
	public listServerDirectories(): Promise<ServerStructure> {
		return Promise.resolve({
			support: ServerStructureSupport.UNSUPPORTED,
			path: null,
			parent: null,
			entries: [],
		});
	}

	public async *scanLibrary(): AsyncIterable<NormalisedMediaItem> {
		for (const item of this._enumerated) {
			yield item;
		}
	}

	public refreshLibrary(): Promise<LibraryRefresh> {
		return Promise.resolve({ items: [], cursor: null });
	}

	/**
	 * Answered rather than thrown, although no scan in this file asks for it.
	 *
	 * A landing settles at the end of every pass and may ask the service to re-read
	 * itself; throwing here would make a test about enumeration order fail with a
	 * message about a rescan.
	 */
	/** Nothing to ask a fixture for: what it reports is what the test put in it. */
	public refreshItem(): Promise<boolean> {
		return Promise.resolve(false);
	}

	public requestRescan(): Promise<RescanOutcome> {
		return Promise.resolve(RescanOutcome.UNSUPPORTED);
	}

	public getItem(
		_connection: unknown,
		externalId: string,
	): Promise<NormalisedMediaItem | null> {
		this.asked.push(externalId);

		return Promise.resolve(
			this._held.find((item) => item.externalId === externalId) ?? null,
		);
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

const item = (overrides: Partial<NormalisedMediaItem> = {}): NormalisedMediaItem => ({
	externalId: 'external-1',
	parentExternalId: null,
	kind: MediaKind.MOVIE,
	title: 'Arrival',
	normalizedTitle: 'arrival',
	year: 2016,
	seasonNumber: null,
	episodeNumber: null,
	externalIds: {},
	overview: null,
	artworkUrl: null,
	file: null,
	addedAt: null,
	...overrides,
});

/**
 * The scan is answered before it has done anything, so something has to wait for it.
 *
 * `lastScanAt` is the stamp written once the whole service has been walked and
 * reconciled, which makes it the one signal that does not race: polling the grouped
 * listing instead would happily read a half-written index and pass.
 */
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
 * What a library screen shows after a scan, and it is only ever the tops of the trees.
 *
 * The regression this file exists for was visible from exactly here: seasons sitting
 * at the root of the library beside the series they belong to, because the gateway
 * linked a child to its parent only when the parent happened to be enumerated first
 * — and Jellyfin sorts by name, where `Season 1` comes before `The Expanse`.
 */
describe('Scanning a service that lists children before their parents', () => {
	let context: TestApp;
	let admin: TestIdentity;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
	});

	afterAll(async () => {
		await context.close();
	});

	const register = async (name: string, handler: MediaServiceHandler): Promise<string> => {
		context.app.get(HandlerRegistry).register(handler);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const service = await services.save(
			services.create({
				name,
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				// Nothing listens here, and nothing needs to: the registered handler is
				// what a scan talks to.
				baseUrl: `http://127.0.0.1:9/${name}`,
				status: MediaServiceStatus.ONLINE,
			}),
		);

		await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/media/shows'],
			}),
		);

		return service.id;
	};

	const roots = async (): Promise<MediaGroup[]> => {
		const response = await request(context.app.getHttpServer())
			.get('/api/media/groups?rootsOnly=true&limit=100')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return (response.body as ResultList<MediaGroup>).items;
	};

	const scan = async (serviceId: string): Promise<void> => {
		const before = await lastScanAt(context, admin.token, serviceId);

		await request(context.app.getHttpServer())
			.post(`/api/services/${serviceId}/scan`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(202);

		await waitForScan(context, admin.token, serviceId, before);
	};

	it('shows the series at the root and not its seasons', async () => {
		const handler = new OrderedHandler([
			item({
				externalId: 'season-1',
				parentExternalId: 'series-1',
				kind: MediaKind.SEASON,
				title: 'Season 1',
				normalizedTitle: 'expanse',
				seasonNumber: 1,
			}),
			item({
				externalId: 'episode-1',
				parentExternalId: 'season-1',
				kind: MediaKind.EPISODE,
				title: 'Dulcinea',
				normalizedTitle: 'expanse',
				seasonNumber: 1,
				episodeNumber: 1,
			}),
			item({
				externalId: 'series-1',
				kind: MediaKind.SERIES,
				title: 'The Expanse',
				normalizedTitle: 'expanse',
			}),
		]);

		await scan(await register('out-of-order', handler));

		const titles = (await roots()).map((group) => group.title);

		expect(titles).toEqual(['The Expanse']);
		expect(titles).not.toContain('Season 1');
		// Nothing had to be asked for: every parent was in the enumeration, just late.
		expect(handler.asked).toEqual([]);
	});

	it('fetches a series the enumeration left out entirely', async () => {
		// A season whose series is simply absent cannot be linked to anything that
		// exists, so the gateway asks the service for it — once, however many children
		// name it — and files them under the row that comes back.
		const series = item({
			externalId: 'series-2',
			kind: MediaKind.SERIES,
			title: 'Cowboy Bebop',
			normalizedTitle: 'cowboy bebop',
		});
		const handler = new OrderedHandler(
			[
				item({
					externalId: 'season-2',
					parentExternalId: 'series-2',
					kind: MediaKind.SEASON,
					title: 'Season 1',
					normalizedTitle: 'cowboy bebop',
					seasonNumber: 1,
				}),
				item({
					externalId: 'season-3',
					parentExternalId: 'series-2',
					kind: MediaKind.SEASON,
					title: 'Season 2',
					normalizedTitle: 'cowboy bebop',
					seasonNumber: 2,
				}),
			],
			[series],
		);

		const serviceId = await register('missing-parent', handler);

		await scan(serviceId);

		expect((await roots()).map((group) => group.title).sort()).toEqual([
			'Cowboy Bebop',
			'The Expanse',
		]);
		expect(handler.asked).toEqual(['series-2']);

		// And it survives being scanned again. The fetched series is in no
		// enumeration, so the pass that drops what a scan no longer saw would take it
		// — leaving both seasons pointing at a row that no longer exists, which is
		// neither a root nor reachable under anything: the show vanishes from the
		// library screen with nothing logged anywhere.
		await scan(serviceId);

		expect((await roots()).map((group) => group.title).sort()).toEqual([
			'Cowboy Bebop',
			'The Expanse',
		]);
		expect(handler.asked).toEqual(['series-2']);
	});

	it('leaves an item at the root rather than losing it when nobody can produce its parent', async () => {
		// A service that has deleted the series it just listed episodes for, or that
		// times out being asked, must cost a misplaced row and never a missing one.
		const handler = new OrderedHandler(
			[
				item({
					externalId: 'episode-9',
					parentExternalId: 'gone',
					kind: MediaKind.EPISODE,
					title: 'A Tooth for an Eye',
					normalizedTitle: 'lost show',
					seasonNumber: 1,
					episodeNumber: 1,
				}),
			],
			[],
		);

		await scan(await register('vanished-parent', handler));

		expect((await roots()).map((group) => group.title)).toContain('A Tooth for an Eye');
	});
});
