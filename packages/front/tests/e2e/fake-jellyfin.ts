import type { AddressInfo } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect } from '@playwright/test';
import { API_URL, apiToken } from './helpers';

/**
 * A media server the journeys can hold in their hand.
 *
 * ## Why this exists
 *
 * `make e2e/ci` seeds an administrator and some settings, and nothing else: no
 * service, no library, no media. Yet every screen these journeys are about — the
 * poster wall, one media's page, the dashboard — is a screen about media. A journey
 * that asserts against whatever the gateway happens to hold passes on the workstation
 * where somebody's catalogue is loaded and fails on a runner, for a reason nobody can
 * reproduce; that is worse than no journey at all.
 *
 * And media cannot be created over the API. There is no route that writes a library
 * or a media item — they exist only because a scan of a media server found them, which
 * is the right design and is exactly what leaves a journey with nothing to stand on.
 *
 * So the journey *is* the media server. This is the smallest Jellyfin the gateway's
 * handler will talk to: the three endpoints a probe and a scan actually call, over the
 * network the containers already share, serving a catalogue the test wrote. The
 * gateway is not mocked anywhere — it registers a real service, runs a real scan,
 * writes real rows, and `DELETE /services/:id` takes all of it away again.
 *
 * ## What the gateway asks for, and therefore what is implemented here
 *
 * - `GET /System/Info` — the probe. Anything else answers before the handler decides
 *   the server is unreachable, so this one is not optional.
 * - `GET /Library/VirtualFolders` — the libraries, each with the paths it reports.
 * - `GET /Items` — everything under a library, and, with `Ids`, one item by
 *   identifier. Paging is honoured because the handler stops on a short page.
 * - `POST /Items/:id/Refresh` and `POST /Library/Refresh` — what the gateway asks a
 *   server to do once it has put a file in one of its folders.
 *
 * Nothing authenticates: the handler sends an `Authorization` header and this accepts
 * whatever it sends. A journey about credentials would be a journey about Jellyfin,
 * which is not what any of these check.
 */

/** One shelf, as Jellyfin's virtual folder listing describes it. */
export interface FakeLibrary {
	externalId: string;
	name: string;
	/** `tvshows` or `movies`; anything else lands in `LibraryKind.OTHER`. */
	collectionType: string;
	/** Where the server says its files are, which is what the library rows carry. */
	locations: string[];
}

/** One item, in Jellyfin's own casing, so the handler reads it as it reads a real one. */
export interface FakeItem {
	Id: string;
	Type: 'Series' | 'Season' | 'Episode' | 'Movie' | 'BoxSet';
	Name: string;
	/** The shelf it hangs under. Not a Jellyfin field: the fake uses it to filter. */
	library: string;
	ParentId?: string;
	SeriesId?: string;
	SeasonId?: string;
	SeriesName?: string;
	IndexNumber?: number;
	ParentIndexNumber?: number;
	ProductionYear?: number;
	Overview?: string;
	IsFolder?: boolean;
	Path?: string;
	DateCreated?: string;
	MediaSources?: unknown[];
}

export interface FakeCatalogue {
	serverName: string;
	libraries: FakeLibrary[];
	items: FakeItem[];
}

export interface FakeJellyfin {
	/** The address to register the service with, reachable from the API container. */
	baseUrl: string;
	/** Every path the gateway asked for, for a journey that needs to prove a call. */
	calls: string[];
	close: () => Promise<void>;
}

/**
 * The address the *gateway* can reach this process at.
 *
 * `localhost` would be the Playwright container talking to itself, and the API — which
 * is the only party that ever calls this server — lives in another container. The
 * first non-internal IPv4 is the address on the network the compose file puts both of
 * them on. Taking it from the interface rather than from a hostname is deliberate:
 * `docker compose run` does not give its container the service name as a network
 * alias, so `http://e2e:port` resolves from nowhere.
 */
function reachableHost (): string {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === 'IPv4' && !address.internal) {
				return address.address;
			}
		}
	}

	// A single-interface host has nothing but the loopback, which is still right when
	// the gateway happens to run beside the journeys rather than in a container.
	return '127.0.0.1';
}

/**
 * Where the handler asks for a file's bytes: `/Download` first, and the static stream
 * route when a server refuses downloads. Both answered, so neither branch of the
 * handler is what decides whether a journey's pull works.
 */
const DOWNLOAD_ROUTES = [/^\/Items\/([^/]+)\/Download$/, /^\/Videos\/([^/]+)\/stream$/];

function send (response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload),
	});
	response.end(payload);
}

/** What `/Items` answers, honouring the filters the handler actually sends. */
function itemsFor (catalogue: FakeCatalogue, url: URL): FakeItem[] {
	const ids = url.searchParams.get('Ids');

	if (ids) {
		const wanted = new Set(ids.split(','));
		return catalogue.items.filter(item => wanted.has(item.Id));
	}

	const parent = url.searchParams.get('ParentId');
	const types = new Set((url.searchParams.get('IncludeItemTypes') ?? '').split(',').filter(Boolean));

	return catalogue.items.filter(item => {
		if (parent && item.library !== parent) {
			return false;
		}
		return types.size === 0 || types.has(item.Type);
	});
}

/**
 * Raise the server and answer until `close`.
 *
 * Port zero, because two journeys running one after another on the same runner would
 * otherwise fight over a number, and the failure — `EADDRINUSE` — names the port and
 * not the journey that did not shut down.
 */
export async function startFakeJellyfin (catalogue: FakeCatalogue): Promise<FakeJellyfin> {
	const calls: string[] = [];

	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? '/', 'http://fake');
		calls.push(`${request.method} ${url.pathname}`);

		if (url.pathname === '/System/Info' || url.pathname === '/System/Info/Public') {
			send(response, 200, { Version: '10.9.11', ServerName: catalogue.serverName, Id: 'fake' });
			return;
		}

		if (url.pathname === '/Library/VirtualFolders') {
			send(response, 200, catalogue.libraries.map(library => ({
				ItemId: library.externalId,
				Name: library.name,
				CollectionType: library.collectionType,
				Locations: library.locations,
			})));
			return;
		}

		if (url.pathname === '/Items' && request.method === 'GET') {
			const matching = itemsFor(catalogue, url);
			const start = Number(url.searchParams.get('StartIndex') ?? 0);
			const limit = Number(url.searchParams.get('Limit') ?? matching.length);

			send(response, 200, {
				Items: matching.slice(start, start + limit),
				TotalRecordCount: matching.length,
				StartIndex: start,
			});
			return;
		}

		// A refresh is a request, not a result: a real server answers 204 and goes and
		// walks the folder. The journeys read `calls` to prove it was asked.
		if (request.method === 'POST' && /\/Refresh$/.test(url.pathname)) {
			response.writeHead(204).end();
			return;
		}

		/*
		 * The bytes themselves, for the journeys that pull one.
		 *
		 * Filler of exactly the size the catalogue announced, because the gateway
		 * compares what arrived with what it was promised and a short file is a failed
		 * transfer rather than a landed one. The sizes in `journeyCatalogue` are small
		 * for this reason and no other.
		 */
		let download: RegExpExecArray | null = null;
		for (const route of DOWNLOAD_ROUTES) {
			download ??= route.exec(url.pathname);
		}

		if (download) {
			const item = catalogue.items.find(one => one.Id === decodeURIComponent(download[1]));
			const source = item?.MediaSources?.[0] as { Size?: number } | undefined;

			if (!item || !source) {
				send(response, 404, { error: 'not found' });
				return;
			}

			const size = source.Size ?? 0;
			const body = Buffer.alloc(size, item.Id.codePointAt(0) ?? 0);
			const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');

			if (range) {
				const from = Number(range[1]);
				const to = range[2] ? Number(range[2]) : size - 1;
				const slice = body.subarray(from, to + 1);
				response.writeHead(206, {
					'Content-Type': 'video/x-matroska',
					'Content-Length': slice.length,
					'Content-Range': `bytes ${from}-${to}/${size}`,
					'Accept-Ranges': 'bytes',
				});
				response.end(slice);
				return;
			}

			response.writeHead(200, {
				'Content-Type': 'video/x-matroska',
				'Content-Length': size,
				'Accept-Ranges': 'bytes',
			});
			response.end(body);
			return;
		}

		// Artwork and anything else: a 404 is an answer the handler is written to
		// survive, and every poster on the wall then draws its placeholder.
		send(response, 404, { error: 'not found' });
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '0.0.0.0', resolve);
	});

	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://${reachableHost()}:${port}`,
		calls,
		close: () => new Promise<void>(resolve => {
			// `closeAllConnections` first: the gateway keeps a keep-alive socket open
			// between calls, and `close` alone waits for it — the journey then passes
			// and the worker hangs until Playwright's own timeout kills it.
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}

/**
 * How big the fixture files claim to be, and are.
 *
 * Small, because a journey that pulls one waits for every byte of it to cross a
 * loopback and be written to disk — and because the fake serves the file out of a
 * buffer it allocates. A gigabyte here would be a gigabyte of resident memory in the
 * test worker and a journey nobody can run on a laptop.
 */
const EPISODE_BYTES = 1_048_576;
const FILM_BYTES = 4_194_304;

/**
 * A show with a season and three episodes, and a film beside it.
 *
 * Exactly what the media pages need to be checked at all: a series and a season are
 * the two scopes "keep in sync" is offered on, and the film is the one it must not be
 * offered on. The titles carry a per-run suffix so that two runs against the same
 * gateway — or a run against somebody's real catalogue — cannot collide.
 */
export function journeyCatalogue (tag: string): FakeCatalogue {
	const shows = `shows-${tag}`;
	const films = `films-${tag}`;
	const seriesTitle = `Journey Series ${tag}`;
	const filmTitle = `Journey Film ${tag}`;

	const file = (path: string, size: number): unknown[] => [{
		Path: path,
		Size: size,
		Container: 'mkv',
		RunTimeTicks: 12_000_000_000,
		Bitrate: 4_000_000,
		MediaStreams: [
			{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
			{ Type: 'Audio', Codec: 'aac' },
		],
	}];

	const episodes: FakeItem[] = [1, 2, 3].map(number => ({
		Id: `${tag}-episode-${number}`,
		Type: 'Episode',
		Name: `Episode ${number}`,
		library: shows,
		ParentId: `${tag}-season`,
		SeasonId: `${tag}-season`,
		SeriesId: `${tag}-series`,
		SeriesName: seriesTitle,
		IndexNumber: number,
		ParentIndexNumber: 1,
		ProductionYear: 2021,
		DateCreated: '2024-01-0${number}T10:00:00.0000000Z'.replace('${number}', String(number)),
		Path: `/data/shows/${seriesTitle}/Season 01/S01E0${number}.mkv`,
		MediaSources: file(`/data/shows/${seriesTitle}/Season 01/S01E0${number}.mkv`, EPISODE_BYTES),
	}));

	return {
		serverName: `Journey Jellyfin ${tag}`,
		libraries: [
			{
				externalId: shows,
				name: `Journey Shows ${tag}`,
				collectionType: 'tvshows',
				locations: [`/data/shows`],
			},
			{
				externalId: films,
				name: `Journey Films ${tag}`,
				collectionType: 'movies',
				locations: [`/data/films`],
			},
		],
		items: [
			{
				Id: `${tag}-series`,
				Type: 'Series',
				Name: seriesTitle,
				library: shows,
				ProductionYear: 2021,
				Overview: 'A show that exists only for the length of one journey.',
				IsFolder: true,
				Path: `/data/shows/${seriesTitle}`,
				DateCreated: '2024-01-01T09:00:00.0000000Z',
			},
			{
				Id: `${tag}-season`,
				Type: 'Season',
				Name: 'Season 1',
				library: shows,
				ParentId: `${tag}-series`,
				SeriesId: `${tag}-series`,
				SeriesName: seriesTitle,
				IndexNumber: 1,
				ProductionYear: 2021,
				IsFolder: true,
				Path: `/data/shows/${seriesTitle}/Season 01`,
				DateCreated: '2024-01-01T09:00:00.0000000Z',
			},
			...episodes,
			{
				Id: `${tag}-film`,
				Type: 'Movie',
				Name: filmTitle,
				library: films,
				ProductionYear: 2019,
				Overview: 'A film that exists only for the length of one journey.',
				Path: `/data/films/${filmTitle}.mkv`,
				DateCreated: '2024-01-01T09:00:00.0000000Z',
				MediaSources: file(`/data/films/${filmTitle}.mkv`, FILM_BYTES),
			},
		],
	};
}

/** One group as the API answers it, in the shape the fixtures read. */
interface RawGroup {
	id: string;
	title: string;
	kind: string;
	sources?: { itemId: string }[];
}

/**
 * A group as the journeys use it: what to navigate to, and what to pull.
 *
 * The identifier of the group and the identifier of the row it was built from are the
 * same thing for a media only one server holds, and different the moment two do. They
 * are kept apart here so a journey never has to know which case it is in.
 */
export interface FixtureGroup {
	id: string;
	title: string;
	kind: string;
	sourceItemId: string;
}

export interface MediaFixture {
	tag: string;
	/** The registered service, which is also the whole teardown. */
	serviceId: string;
	series: FixtureGroup;
	season: FixtureGroup;
	episodes: FixtureGroup[];
	film: FixtureGroup;
	/** The catalogue's own category keys, for the screens built on categories. */
	showsCategoryKey: string;
	filmsCategoryKey: string;
	/**
	 * Take the whole fixture away.
	 *
	 * It is handed a request context rather than keeping the one it was built with,
	 * because Playwright disposes the `request` of a `beforeAll` before the matching
	 * `afterAll` runs — and the failure names a fixture rather than the teardown.
	 */
	remove: (request: APIRequestContext) => Promise<void>;
}

/** A short identifier no two runs share, so nothing a journey created is ambiguous. */
export function journeyTag (): string {
	return Math.random().toString(36).slice(2, 8);
}

/**
 * Wait for the gateway to have done something, by reading what it wrote.
 *
 * A scan answers `202` and walks the server afterwards, and a transfer answers before
 * a byte has moved. What proves either finished is the rows they produce — never a
 * delay, which is the same wait spelled as a flake.
 */
export async function until<T> (
	read: () => Promise<T>,
	ready: (value: T) => boolean,
	message: string,
	timeoutMs = 60_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T = await read();

	while (!ready(last)) {
		if (Date.now() > deadline) {
			throw new Error(`${message} (waited ${Math.round(timeoutMs / 1000)}s)`);
		}
		await new Promise(resolve => setTimeout(resolve, 500));
		last = await read();
	}

	return last;
}

function toGroup (raw: RawGroup): FixtureGroup {
	return {
		id: raw.id,
		title: raw.title,
		kind: raw.kind,
		sourceItemId: raw.sources?.[0]?.itemId ?? raw.id,
	};
}

/** Every bearer-token call these fixtures make wants the same header. */
export async function authorized (request: APIRequestContext): Promise<{ Authorization: string }> {
	return { Authorization: `Bearer ${await apiToken(request)}` };
}

/**
 * Register the fake server, scan it, and hand back what the gateway made of it.
 *
 * The service is registered without a root mapping, so the gateway reads it as a
 * server whose files it cannot reach — which is what makes every item `missing`, and
 * therefore something a sync, an estimate and a plan have anything to say about. A
 * mounted fixture would be in sync with itself and every one of those screens would be
 * checked against nothing.
 */
export async function createMediaFixture (
	request: APIRequestContext,
	tag = journeyTag(),
): Promise<MediaFixture> {
	const server = await startFakeJellyfin(journeyCatalogue(tag));
	const headers = await authorized(request);

	const created = await request.post(`${API_URL}/services`, {
		headers,
		data: {
			name: `Journey fixture ${tag}`,
			type: 'jellyfin',
			// Never offered to peers: a fixture that advertises itself to somebody
			// else's gateway is a fixture that outlives the run on their side.
			shared: false,
			baseUrl: server.baseUrl,
		},
	});
	expect(created.ok(), `fixture service failed: ${created.status()} ${await created.text()}`)
		.toBeTruthy();
	const service = await created.json() as { id: string };

	const remove = async (context: APIRequestContext): Promise<void> => {
		// The service takes its libraries, its items and its matches with it, which is
		// the whole teardown — there is no route that deletes a media item.
		await context.delete(`${API_URL}/services/${service.id}`, { headers: await authorized(context) });
		await server.close();
	};

	const groups = async (path: string): Promise<RawGroup[]> => {
		const listed = await request.get(`${API_URL}/media/groups${path}`, { headers });
		expect(listed.ok(), `groups failed: ${listed.status()}`).toBeTruthy();
		return (await listed.json() as { items: RawGroup[] }).items;
	};

	try {
		const scanned = await request.post(`${API_URL}/services/${service.id}/scan`, { headers });
		expect(scanned.ok(), `scan failed: ${scanned.status()}`).toBeTruthy();

		const roots = await until(
			() => groups(`?rootsOnly=true&limit=20&serviceIds=${service.id}`),
			items => items.some(one => one.kind === 'series') && items.some(one => one.kind === 'movie'),
			'the scan produced neither the series nor the film',
		);

		const series = toGroup(roots.find(one => one.kind === 'series')!);
		const film = toGroup(roots.find(one => one.kind === 'movie')!);
		const season = toGroup((await groups(`/${series.id}/children?limit=10`))[0]);
		const episodes = (await groups(`/${season.id}/children?limit=10`)).map(one => toGroup(one));

		expect(episodes.length, 'the season came back without its episodes').toBe(3);

		return {
			tag,
			serviceId: service.id,
			series,
			season,
			episodes,
			film,
			showsCategoryKey: `journey-shows-${tag}`,
			filmsCategoryKey: `journey-films-${tag}`,
			remove,
		};
	} catch (error) {
		// A fixture that half-built itself must not survive the failure: the next run
		// would find a service nobody can explain and a category on the wall.
		await remove(request);
		throw error;
	}
}

/**
 * A library of our own for a journey that actually pulls something.
 *
 * ## Why a journey may not simply press download
 *
 * A run with no destination lands wherever the placement rule ends up — on a gateway
 * with real libraries, that is somebody's shelf, and a journey that writes a file into
 * a stranger's catalogue is a journey nobody may run twice. So a journey that pulls
 * first gives the gateway a library it owns, and points the default destination at it
 * for the length of the run. What lands, lands in the fixture; what the journey created
 * is what it deletes.
 *
 * ## The two names of one directory
 *
 * The gateway and the journeys see the same disk under different paths: in CI both run
 * in containers with the repository mounted at `/app`, while a gateway started on a
 * workstation sees the repository where the workstation keeps it. There is no route
 * that creates a directory, so the journey makes it on its own side and tells the
 * gateway where to find it — `E2E_LANDING_PATH` when the two names differ.
 *
 * When the gateway cannot write there, this answers `null` rather than falling back to
 * a library somebody else owns, and the journey skips with a reason. Silently pulling
 * into the wrong shelf is the one outcome that must not happen.
 */
export interface OwnDestination {
	libraryId: string;
	libraryName: string;
	/**
	 * A second shelf of the same server, for the journeys that move a file.
	 *
	 * A move needs somewhere to go that is not where the file already is, and the only
	 * other libraries on a real gateway are somebody's own — moving a fixture into one
	 * of them is the thing this helper exists to prevent.
	 */
	otherLibraryId: string;
	otherLibraryName: string;
	/** Where the gateway writes, in the gateway's own words. */
	path: string;
	/** The same directory as this process reaches it, to prove a file is really there. */
	localPath: string;
	/** Put the destination setting back and delete everything this made. */
	release: (request: APIRequestContext) => Promise<void>;
}

/** Where the journeys make the directory, whichever side they run from. */
function landingPaths (tag: string): { ours: string; gateway: string } {
	return {
		// Relative to this file rather than to the working directory: the journeys are
		// started from `packages/front` by the compose service and from the repository
		// root by hand, and the directory has to be the same one either way.
		ours: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../var/e2e-landing', tag),
		gateway: `${process.env.E2E_LANDING_PATH ?? '/app/var/e2e-landing'}/${tag}`,
	};
}

export async function useOwnDestination (
	request: APIRequestContext,
	tag: string,
): Promise<OwnDestination | null> {
	const paths = landingPaths(tag);
	const name = `Journey landing ${tag}`;
	const otherName = `Journey elsewhere ${tag}`;
	/*
	 * Open to everybody, and deliberately so.
	 *
	 * The gateway and the journeys are two processes that may not run as the same
	 * user: on a runner the API container takes the runner's UID while the Playwright
	 * one defaults to 1000. A directory this side creates with the usual mode is then
	 * one the gateway can read and not write, the library check says so, and every
	 * journey that pulls skips for a reason that has nothing to do with it. The
	 * directories are throwaway and live under the ignored `var/`.
	 */
	for (const directory of [paths.ours, `${paths.ours}/landing`, `${paths.ours}/elsewhere`]) {
		await mkdir(directory, { recursive: true });
		await chmod(directory, 0o777);
	}

	const server = await startFakeJellyfin({
		serverName: name,
		libraries: [
			{
				externalId: `landing-${tag}`,
				name,
				collectionType: 'tvshows',
				locations: ['/data/landing'],
			},
			{
				externalId: `elsewhere-${tag}`,
				name: otherName,
				collectionType: 'tvshows',
				locations: ['/data/elsewhere'],
			},
		],
		items: [],
	});
	const headers = await authorized(request);

	const created = await request.post(`${API_URL}/services`, {
		headers,
		data: {
			name,
			type: 'jellyfin',
			shared: false,
			baseUrl: server.baseUrl,
			// The mapping is what makes this a *local* service: the gateway reaches
			// these files itself, which is the whole difference between a shelf it can
			// write into and one it can only read from.
			remoteRoot: '/data',
			localRoot: paths.gateway,
		},
	});
	expect(created.ok(), `landing service failed: ${created.status()} ${await created.text()}`)
		.toBeTruthy();
	const service = await created.json() as { id: string };

	const drop = async (context: APIRequestContext): Promise<void> => {
		await context.delete(`${API_URL}/services/${service.id}`, { headers: await authorized(context) });
		await server.close();
		// Tolerant, for the same reason the directories are open: what the gateway
		// wrote inside them belongs to its user, and a runner where that is not ours
		// cannot delete it. A leftover under the ignored `var/` of a throwaway
		// workspace is not worth failing a journey over; a thrown teardown is.
		await rm(paths.ours, { recursive: true, force: true }).catch((error: unknown) => {
			console.warn(`could not remove ${paths.ours}: ${String(error)}`);
		});
	};

	const checked = await request.get(`${API_URL}/libraries/check`, { headers });
	const checks = await checked.json() as {
		libraryId: string;
		name: string;
		writable: boolean;
	}[];
	const check = checks.find(one => one.name === name);
	const other = checks.find(one => one.name === otherName);

	if (!check || !check.writable || !other || !other.writable) {
		await drop(request);
		return null;
	}

	// Pointed here for the length of the journey, and put back whatever it was. The
	// setting is global: leaving it on a library that is about to be deleted would
	// send the next pull anybody makes to a path that no longer exists.
	const before = await request.get(`${API_URL}/settings`, { headers });
	const previous = (await before.json() as { defaultTargetLibraryId: string | null })
		.defaultTargetLibraryId;

	await request.patch(`${API_URL}/settings`, {
		headers,
		data: { defaultTargetLibraryId: check.libraryId },
	});

	return {
		libraryId: check.libraryId,
		libraryName: name,
		otherLibraryId: other.libraryId,
		otherLibraryName: otherName,
		path: `${paths.gateway}/landing`,
		localPath: paths.ours,
		release: async (context: APIRequestContext) => {
			const auth = await authorized(context);
			const now = await context.get(`${API_URL}/settings`, { headers: auth });
			const targets = (await now.json() as { categoryTargets: Record<string, string> })
				.categoryTargets ?? {};
			const ours = new Set([check.libraryId, other.libraryId]);

			/*
			 * Every category destination naming one of these shelves goes with them.
			 *
			 * Found by the library it names rather than by the key a journey saved it
			 * under, because the gateway moves the key: remembering a destination for a
			 * category renames that category after its destination, and the entry
			 * follows the rename. Left behind, it is a destination naming a library
			 * that no longer exists. Read afresh here and patched as the whole table the
			 * API expects, minus ours — never the table as it stood when the journey
			 * started, which would undo whatever anybody else saved since.
			 */
			const kept = Object.fromEntries(
				Object.entries(targets).filter(([, libraryId]) => !ours.has(libraryId)));

			await context.patch(`${API_URL}/settings`, {
				headers: auth,
				data: {
					defaultTargetLibraryId: previous,
					...(Object.keys(kept).length === Object.keys(targets).length
						? {}
						: { categoryTargets: kept }),
				},
			});
			await drop(context);
		},
	};
}
