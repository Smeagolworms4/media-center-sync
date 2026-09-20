import { PassThrough } from 'node:stream';
import {
	LibraryKind,
	MediaKind,
	MediaServiceType,
	PeerCapability,
	type CatalogueEntry,
	type PeerLibrary,
} from '@mcs/shared';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PeerCatalogueService } from '../peer-catalogue.service';
import type { PeerLinkService } from '../peer-link.service';
import { PEER_FALLBACK_LIBRARY, PeerHandler, peerBaseUrl } from './peer.handler';
import type { NormalisedLibrary, NormalisedMediaItem, ServiceConnection } from './media-handler.interface';

const PEER_ID = 'peer-1';

/**
 * A link that answers whatever a test hands it, and nothing else.
 *
 * The whole point of the handler is that it opens nothing: it speaks over a link
 * somebody else established. Faking that link is therefore faking the entire outside
 * world, which is why there is no HTTP anywhere in this file.
 */
interface FakeLink {
	request: jest.Mock;
	openStream: jest.Mock;
	isLinked: jest.Mock;
	supports: jest.Mock;
	protocolOf: jest.Mock;
}

const connection = (overrides: Partial<ServiceConnection> = {}): ServiceConnection => ({
	id: 'service-1',
	type: MediaServiceType.PEER,
	baseUrl: peerBaseUrl(PEER_ID),
	token: null,
	username: null,
	password: null,
	...overrides,
});

const library = (overrides: Partial<NormalisedLibrary> = {}): NormalisedLibrary => ({
	externalId: 'their-library-1',
	name: 'Films',
	kind: LibraryKind.MOVIES,
	paths: [],
	...overrides,
});

const entry = (overrides: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
	externalId: 'their-item-1',
	libraryId: 'their-library-1',
	kind: MediaKind.MOVIE,
	title: 'Tears of Steel',
	year: 2012,
	seasonNumber: null,
	episodeNumber: null,
	parentExternalId: null,
	externalIds: { tmdb: '133701' },
	contentId: 'v1:abc:1048576',
	size: 1_048_576,
	quality: 'x265 · 1080p',
	...overrides,
});

const shared = (overrides: Partial<PeerLibrary> = {}): PeerLibrary => ({
	externalId: 'their-library-1',
	name: 'Films',
	kind: LibraryKind.MOVIES,
	itemCount: 3,
	...overrides,
});

const build = (): { handler: PeerHandler; links: FakeLink } => {
	const links: FakeLink = {
		request: jest.fn(),
		openStream: jest.fn(),
		isLinked: jest.fn(() => true),
		supports: jest.fn(() => true),
		protocolOf: jest.fn(() => 1),
	};

	// The real catalogue service over a faked link rather than a faked catalogue
	// service: the paging and the capability check are part of what reaching a peer
	// means, and a double here would let both of them break unnoticed.
	const handler = new PeerHandler(
		links as unknown as PeerLinkService,
		new PeerCatalogueService(links as unknown as PeerLinkService),
	);

	return { handler, links };
};

/** One page of rows, then the empty page that ends the walk. */
const answersWith = (links: FakeLink, ...entries: CatalogueEntry[]): void => {
	links.request.mockImplementation(async (_peerId: string, method: string) => {
		if (method === 'catalogue.libraries') {
			return { libraries: [shared()] };
		}

		return { entries: links.request.mock.calls.filter((call) => call[1] === 'catalogue.list').length === 1 ? entries : [] };
	});
};

const collect = async (items: AsyncIterable<NormalisedMediaItem>): Promise<NormalisedMediaItem[]> => {
	const out: NormalisedMediaItem[] = [];

	for await (const item of items) {
		out.push(item);
	}

	return out;
};

describe('PeerHandler', () => {
	describe('probe', () => {
		it('reports a peer with no link as offline rather than as unauthorised', async () => {
			const { handler, links } = build();

			links.isLinked.mockReturnValue(false);

			await expect(handler.probe(connection())).resolves.toMatchObject({
				reachable: false,
				authenticated: false,
				error: 'error.peer.unreachable',
			});
		});

		it('reports what they share, and the version they really have', async () => {
			const { handler, links } = build();

			links.request.mockResolvedValue({ libraries: [shared(), shared({ externalId: 'l2' })] });

			await expect(handler.probe(connection())).resolves.toMatchObject({
				reachable: true,
				authenticated: true,
				version: 'protocol 1',
				libraries: [
					expect.objectContaining({ externalId: 'their-library-1', name: 'Films' }),
					expect.objectContaining({ externalId: 'l2' }),
				],
			});
		});

		it('answers rather than throws for a row whose address names no peer', async () => {
			const { handler } = build();

			await expect(
				handler.probe(connection({ baseUrl: 'http://jellyfin:8096' })),
			).resolves.toMatchObject({ reachable: false, error: 'error.service.not_found' });
		});
	});

	describe('listLibraries', () => {
		it('offers no path for any of them, so none can ever be written into', async () => {
			const { handler, links } = build();

			links.request.mockResolvedValue({ libraries: [shared({ kind: 'movies' })] });

			await expect(handler.listLibraries(connection())).resolves.toEqual([
				{ externalId: 'their-library-1', name: 'Films', kind: LibraryKind.MOVIES, paths: [] },
			]);
		});

		it('trusts a peer that says it shares nothing', async () => {
			const { handler, links } = build();

			links.request.mockResolvedValue({ libraries: [] });

			await expect(handler.listLibraries(connection())).resolves.toEqual([]);
		});

		it('gives one bag to a peer too old to enumerate its libraries', async () => {
			// Their rows carry no library handle, and everything downstream is expressed
			// per library. One named bag is an honest description of what they told us.
			const { handler, links } = build();

			links.supports.mockImplementation(
				(_peerId: string, capability: string) => capability !== PeerCapability.LIBRARIES,
			);

			await expect(handler.listLibraries(connection())).resolves.toEqual([
				expect.objectContaining({ externalId: PEER_FALLBACK_LIBRARY, paths: [] }),
			]);
			expect(links.request).not.toHaveBeenCalledWith(
				PEER_ID,
				'catalogue.libraries',
				expect.anything(),
			);
		});

		it('files an unknown kind of library as other rather than dropping it', async () => {
			const { handler, links } = build();

			links.request.mockResolvedValue({ libraries: [shared({ kind: 'photographs' })] });

			await expect(handler.listLibraries(connection())).resolves.toMatchObject([
				{ kind: LibraryKind.OTHER },
			]);
		});
	});

	describe('scanLibrary', () => {
		it('asks only for the library it was given', async () => {
			const { handler, links } = build();

			answersWith(links, entry());

			await collect(handler.scanLibrary(connection(), library()));

			expect(links.request).toHaveBeenCalledWith(
				PEER_ID,
				'catalogue.list',
				expect.objectContaining({ libraryId: 'their-library-1' }),
			);
		});

		it('asks for everything when the library is the bag an older peer gets', async () => {
			const { handler, links } = build();

			answersWith(links, entry());

			await collect(
				handler.scanLibrary(connection(), library({ externalId: PEER_FALLBACK_LIBRARY })),
			);

			expect(links.request).toHaveBeenCalledWith(
				PEER_ID,
				'catalogue.list',
				expect.objectContaining({ libraryId: null }),
			);
		});

		it('turns a row into an item the index can hold', async () => {
			const { handler, links } = build();

			answersWith(links, entry());

			const [item] = await collect(handler.scanLibrary(connection(), library()));

			expect(item).toMatchObject({
				externalId: 'their-item-1',
				kind: MediaKind.MOVIE,
				title: 'Tears of Steel',
				normalizedTitle: 'tears of steel',
				year: 2012,
				// The identifier they key the row by, which is what we hand back for bytes,
				// alongside the metadata identifiers both sides correlate on.
				externalIds: { provider: 'their-item-1', tmdb: '133701' },
				overview: null,
				artworkUrl: null,
			});
			expect(item.file).toMatchObject({
				size: 1_048_576,
				contentId: 'v1:abc:1048576',
				// Never guessed: a path is the shape of somebody else's disk, and the
				// naming layer already renders a name for a source that sent none.
				path: '',
				quickHash: null,
			});
		});

		it('gives an episode the show title, because that is what correlation joins on', async () => {
			// An episode carrying its own name matches nothing: `the flight` here against
			// `episode 5` there, for the same episode of the same show.
			const { handler, links } = build();

			answersWith(
				links,
				entry({ externalId: 'series-1', kind: MediaKind.SERIES, title: 'The Expanse', size: null, contentId: null }),
				entry({
					externalId: 'episode-1',
					kind: MediaKind.EPISODE,
					title: 'The Flight',
					parentExternalId: 'series-1',
					seasonNumber: 1,
					episodeNumber: 5,
				}),
			);

			const items = await collect(handler.scanLibrary(connection(), library()));
			const episode = items.find((item) => item.kind === MediaKind.EPISODE);

			expect(episode).toMatchObject({
				title: 'The Flight',
				normalizedTitle: 'expanse',
			});
		});

		it('gives a node with no file of its own a null file, not an empty one', async () => {
			const { handler, links } = build();

			answersWith(
				links,
				entry({ kind: MediaKind.SERIES, size: null, contentId: null, quality: null }),
			);

			const [item] = await collect(handler.scanLibrary(connection(), library()));

			expect(item.file).toBeNull();
		});

		it('reads the resolution back out of the label, so a friend is comparable at all', async () => {
			// Without a height the comparator ranks every copy a friend holds as unknown,
			// which loses to anything — a 2160p remux passed over for a 480p copy of ours.
			const { handler, links } = build();

			answersWith(links, entry({ quality: 'x265 · 2160p HDR' }));

			const [item] = await collect(handler.scanLibrary(connection(), library()));

			expect(item.file?.height).toBe(2160);
		});

		it('leaves a copy unranked rather than ranked wrongly when the label says nothing', async () => {
			const { handler, links } = build();

			answersWith(links, entry({ quality: 'mixed' }));

			const [item] = await collect(handler.scanLibrary(connection(), library()));

			expect(item.file?.height).toBeNull();
		});

		it('skips a kind this release has never heard of', async () => {
			// A newer peer sending something we do not model is the normal way this
			// happens, and filing it as something close puts it in a tree where it makes
			// no sense.
			const { handler, links } = build();

			answersWith(links, entry({ kind: 'podcast' }), entry({ externalId: 'ok' }));

			const items = await collect(handler.scanLibrary(connection(), library()));

			expect(items.map((item) => item.externalId)).toEqual(['ok']);
		});
	});

	describe('refreshLibrary', () => {
		it('asks only for what changed, and hands back a cursor to ask from next time', async () => {
			const { handler, links } = build();

			answersWith(links, entry());

			const refresh = await handler.refreshLibrary(
				connection(),
				library(),
				'2026-01-01T00:00:00.000Z',
			);

			expect(links.request).toHaveBeenCalledWith(
				PEER_ID,
				'catalogue.list',
				expect.objectContaining({ since: '2026-01-01T00:00:00.000Z' }),
			);
			expect(refresh.items).toHaveLength(1);
			expect(refresh.cursor).toEqual(expect.any(String));
		});
	});

	describe('the bytes', () => {
		it('asks for the range it was given, over the link', async () => {
			const { handler, links } = build();

			links.openStream.mockResolvedValue(new PassThrough());

			const opened = await handler.openStream(
				connection(),
				{ externalId: 'their-item-1', file: { size: 1_048_576 } as never },
				{ start: 0, end: 1023 },
			);

			expect(links.openStream).toHaveBeenCalledWith(
				PEER_ID,
				'media.range',
				expect.objectContaining({ externalId: 'their-item-1', start: 0, end: 1023 }),
			);
			expect(opened).toMatchObject({ contentLength: 1024, totalLength: 1_048_576, acceptsRanges: true });
		});

		it('sends no range at all when the whole file was asked for', async () => {
			// A malformed range reads as no range at the far end, and relying on that
			// rather than saying it is how a protocol grows a rule nobody wrote down.
			const { handler, links } = build();

			links.openStream.mockResolvedValue(new PassThrough());

			await handler.openStream(connection(), { externalId: 'their-item-1' });

			const [, , params] = links.openStream.mock.calls[0] as [string, string, Record<string, unknown>];

			expect(params).not.toHaveProperty('start');
			expect(params).not.toHaveProperty('end');
		});

		it('offers no URL a third party could fetch, because there is none', async () => {
			const { handler } = build();

			await expect(handler.getDownloadUrl()).resolves.toBeNull();
		});
	});

	describe('what it cannot do', () => {
		it('refuses to sign anybody in, with a key that says why', async () => {
			// An empty identity, or the generic refusal, would let somebody set a friend's
			// gateway as this gateway's authentication provider and find out at the
			// sign-in screen, where the only thing on offer is "wrong credentials".
			const { handler } = build();

			expect(() => handler.authenticate()).toThrow(BadRequestException);

			try {
				handler.authenticate();
			} catch (error) {
				expect((error as BadRequestException).getResponse()).toMatchObject({
					key: 'error.service.auth_unsupported',
				});
			}
		});

		it('says a poster is missing rather than serving a blank one', async () => {
			const { handler } = build();

			expect(() => handler.openArtwork()).toThrow(NotFoundException);
		});
	});

	describe('getItem', () => {
		it('reads the row out of the description a peer answers with', async () => {
			const { handler, links } = build();

			links.request.mockResolvedValue({ size: 1_048_576, resumable: true, entry: entry() });

			await expect(handler.getItem(connection(), 'their-item-1')).resolves.toMatchObject({
				externalId: 'their-item-1',
				title: 'Tears of Steel',
			});
		});

		it('answers null for something they no longer hold, which is an answer', async () => {
			const { handler, links } = build();

			links.request.mockRejectedValue(new NotFoundException('error.media.not_found'));

			await expect(handler.getItem(connection(), 'gone')).resolves.toBeNull();
		});

		it('keeps a link that failed a failure, so silence is not read as gone', async () => {
			const { handler, links } = build();

			links.request.mockRejectedValue(new Error('link closed'));

			await expect(handler.getItem(connection(), 'their-item-1')).rejects.toThrow('link closed');
		});
	});

	describe('requestRescan', () => {
		it('answers that it cannot, rather than ordering a friend to scan', async () => {
			// An answer and not an exception: a thrown error would be indistinguishable
			// from the link being down, and the caller treats those two differently.
			const { handler } = build();

			await expect(handler.requestRescan()).resolves.toBe('unsupported');
		});
	});
});
