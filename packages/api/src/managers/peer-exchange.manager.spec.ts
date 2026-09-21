import { Readable } from 'node:stream';
import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	PEER_INTRODUCE_METHOD,
	PeerStatus,
	PeerTrust,
	ShareVisibility,
	SyncState,
	type MediaFileInfo,
} from '@mcs/shared';
import { In } from 'typeorm';
import type { Library, MediaItem, Peer } from '@/entities';
import type {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	PeerRepository,
} from '@/repositories';
import { BandwidthService, PeerIntroductionService, PeerMethodKind } from '@/services';
import type {
	CataloguePolicy,
	HandlerRegistry,
	PeerCatalogueService,
	PeerLinkService,
	SettingsService,
} from '@/services';
import { PeerExchangeManager } from './peer-exchange.manager';
import type { ShareManager } from './share.manager';

const file = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
	path: '/library-a/S01E05.mkv',
	size: 1_048_576,
	container: 'mkv',
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
		id: 'item-1',
		serviceId: 'service-1',
		libraryId: 'library-shared',
		externalId: 'jellyfin-42',
		parentId: 'series-1',
		kind: MediaKind.EPISODE,
		title: 'The Flight',
		normalizedTitle: 'big buck bunny',
		year: 2008,
		seasonNumber: 1,
		episodeNumber: 5,
		externalIds: { tvdb: '12345', provider: 'jellyfin-42' },
		overview: null,
		artworkUrl: null,
		file: file(),
		quality: { label: 'x265 · 1080p', mixed: false, dominant: null, variants: [], fileCount: 1, totalBytes: 1 },
		syncState: SyncState.LOCAL_ONLY,
		addedAt: null,
		childCount: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-02T00:00:00.000Z'),
		...overrides,
	}) as MediaItem;

const policy = (overrides: Partial<CataloguePolicy> = {}): CataloguePolicy => ({
	libraryId: 'library-shared',
	visibility: ShareVisibility.FRIENDS,
	allowedPeerIds: [],
	deniedPeerIds: [],
	rateLimit: 0,
	...overrides,
});

const OUR_FINGERPRINT = 'f'.repeat(64);

interface Fakes {
	items: { find: jest.Mock; findOne: jest.Mock; count: jest.Mock };
	shares: { visiblePolicies: jest.Mock };
	peers: { findOne: jest.Mock; findLinked: jest.Mock; findByFingerprint: jest.Mock };
	catalogue: { findHolders: jest.Mock };
	libraries: { find: jest.Mock };
	services: { findWithSecrets: jest.Mock };
	openStream: jest.Mock;
	getItem: jest.Mock;
	introductions: PeerIntroductionService;
}

const build = (
	world: { items?: MediaItem[]; policies?: CataloguePolicy[]; peerMaxDepth?: number } = {},
): { manager: PeerExchangeManager; fakes: Fakes } => {
	const items = world.items ?? [item()];
	const fakes: Fakes = {
		items: {
			find: jest.fn().mockResolvedValue(items),
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(items.find((candidate) => candidate.id === options.where.id) ?? null),
			),
			count: jest.fn().mockResolvedValue(items.length),
		},
		shares: { visiblePolicies: jest.fn().mockResolvedValue(world.policies ?? [policy()]) },
		peers: {
			findOne: jest.fn().mockResolvedValue({
				id: 'peer-1',
				name: 'Alice',
				trust: PeerTrust.FRIEND,
				viaPeerId: null,
			} as Peer),
			findLinked: jest.fn().mockResolvedValue([]),
			findByFingerprint: jest.fn().mockResolvedValue(null),
		},
		catalogue: { findHolders: jest.fn().mockResolvedValue([]) },
		libraries: { find: jest.fn().mockResolvedValue([]) },
		services: {
			findWithSecrets: jest
				.fn()
				.mockResolvedValue({ id: 'service-1', type: 'jellyfin', baseUrl: 'http://x', token: 't' }),
		},
		// A fresh stream per call, because the serving path consumes it: a shared one
		// would hand the second caller nothing and read as a throttle that ate the bytes.
		openStream: jest.fn(() =>
			Promise.resolve({
				stream: Readable.from([Buffer.from('0123456789')]),
				contentLength: 10,
				totalLength: 10,
			}),
		),
		getItem: jest.fn().mockResolvedValue(null),
		introductions: undefined as unknown as PeerIntroductionService,
	};

	// The real token service over a fake key pair: a test that asserted a signature
	// against a stub would pin the stub, and the one thing worth knowing about an
	// introduction is that the token is the one this gateway really signs.
	const introductions = new PeerIntroductionService({
		fingerprint: OUR_FINGERPRINT,
		sign: (payload: string) => Buffer.from(`signed:${payload}`).toString('base64'),
	} as unknown as PeerLinkService);

	const manager = new PeerExchangeManager(
		fakes.peers as unknown as PeerRepository,
		fakes.items as unknown as MediaItemRepository,
		fakes.libraries as unknown as LibraryRepository,
		fakes.services as unknown as MediaServiceRepository,
		fakes.shares as unknown as ShareManager,
		fakes.catalogue as unknown as PeerCatalogueService,
		// The real token service over a fake key pair: a test that asserted a signature
		// against a stub would pin the stub, and the one thing worth knowing about an
		// introduction is that the token is really the one this gateway signs.
		introductions,
		{
			get: jest.fn(() => ({ openStream: fakes.openStream, getItem: fakes.getItem })),
		} as unknown as HandlerRegistry,
		{
			// One hop by default, so a test that says nothing about depth still describes
			// a gateway that relays nothing on somebody else's behalf.
			get: jest.fn().mockResolvedValue({ peerMaxDepth: world.peerMaxDepth ?? 1 }),
		} as unknown as SettingsService,
		// The real bucket, uncapped: the throttling belongs to its own test, and a fake
		// here would let the serving path stop paying for what it sends without
		// anything noticing.
		new BandwidthService(),
	);

	fakes.introductions = introductions;

	return { manager, fakes };
};

/** Everything a served stream carries, so a test can say what really left the gateway. */
const drain = async (stream: Readable): Promise<Buffer> => {
	const chunks: Buffer[] = [];

	for await (const chunk of stream) {
		chunks.push(Buffer.from(chunk as Buffer));
	}

	return Buffer.concat(chunks);
};

describe('PeerExchangeManager', () => {
	describe('a library with no policy', () => {
		it('shows nothing of it in the catalogue', async () => {
			const { manager } = build({ policies: [] });

			await expect(manager.catalogue('peer-1')).resolves.toEqual([]);
		});

		it('answers not found, never forbidden, for one of its items', async () => {
			const { manager } = build({ policies: [] });

			await expect(manager.describe('peer-1', 'item-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});

		it('refuses its bytes the same way', async () => {
			const { manager, fakes } = build({ policies: [] });

			await expect(manager.content('peer-1', 'item-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
			expect(fakes.openStream).not.toHaveBeenCalled();
		});
	});

	describe('what a catalogue entry carries', () => {
		it('publishes our own identifiers and never the shape of our disk', async () => {
			const { manager } = build();

			const [entry] = await manager.catalogue('peer-1');

			expect(entry).toEqual({
				externalId: 'item-1',
				// Our library row identifier, which is the same class of thing as the item
				// identifier beside it: ours, opaque to them, and meaningless anywhere
				// else. It is published because a peer is a media service to whoever links
				// to us, and a media service that cannot name its libraries collapses into
				// one bag of files with no categories and no per-library scope.
				libraryId: 'library-shared',
				kind: MediaKind.EPISODE,
				title: 'The Flight',
				year: 2008,
				seasonNumber: 1,
				episodeNumber: 5,
				parentExternalId: 'series-1',
				externalIds: { tvdb: '12345' },
				contentId: 'v1:abc:1048576',
				size: 1_048_576,
				quality: 'x265 · 1080p',
			});
			// Neither a path nor the identifier the media service keys its own rows by.
			expect(JSON.stringify(entry)).not.toContain('/library-a/');
			expect(JSON.stringify(entry)).not.toContain('jellyfin-42');
		});

		it('leaves out rows older than the stamp a peer asked from', async () => {
			const { manager } = build();

			await expect(
				manager.catalogue('peer-1', { since: '2026-06-01T00:00:00.000Z' }),
			).resolves.toEqual([]);
		});
	});

	describe('revalidating', () => {
		it('answers null when the service no longer holds it, which is an answer', async () => {
			const { manager } = build();

			await expect(manager.revalidate('peer-1', 'item-1')).resolves.toEqual({
				externalId: 'item-1',
				file: null,
			});
		});

		it('fails loudly when the service cannot be reached, rather than saying gone', async () => {
			const { manager, fakes } = build();

			fakes.getItem.mockRejectedValue(new Error('ECONNREFUSED'));

			await expect(manager.revalidate('peer-1', 'item-1')).rejects.toThrow(
				ErrorKey.SERVICE_UNREACHABLE,
			);
		});

		it('reports what the service holds now', async () => {
			const { manager, fakes } = build();

			fakes.getItem.mockResolvedValue({ file: file({ path: '/library-a/moved/S01E05.mkv' }) });

			const answer = await manager.revalidate('peer-1', 'item-1');

			expect(answer.file?.path).toBe('/library-a/moved/S01E05.mkv');
		});
	});

	describe('announcing', () => {
		it('says we hold it when a shared library really does', async () => {
			const { manager } = build();

			await expect(manager.announce('peer-1', 'v1:abc:1048576')).resolves.toMatchObject({
				held: true,
			});
		});

		it('keeps friends of friends out when our ceiling is one hop', async () => {
			// Asked for two hops and refused: our limit bounds what we relay, not only
			// what we accept, or a peer could spend our friends' connections walking a
			// network we decided not to walk.
			const { manager, fakes } = build();

			await manager.announce('peer-1', 'v1:abc:1048576', 2);

			expect(fakes.catalogue.findHolders).not.toHaveBeenCalled();
		});

		it('never names the peer who asked among the friends it asks', async () => {
			// Telling them about themselves would put one machine in their source list
			// twice, once under each name.
			const { manager, fakes } = build({ peerMaxDepth: 3 });

			fakes.peers.findLinked.mockResolvedValue([
				{ id: 'peer-1', name: 'Alice', trust: PeerTrust.FRIEND, viaPeerId: null, maxDepth: null },
				{ id: 'peer-2', name: 'Chris', trust: PeerTrust.FRIEND, viaPeerId: null, maxDepth: 2 },
			] as Peer[]);

			await manager.announce('peer-1', 'v1:abc:1048576', 2);

			expect(fakes.catalogue.findHolders).toHaveBeenCalledWith(
				'v1:abc:1048576',
				[{ id: 'peer-2', name: 'Chris', trust: PeerTrust.FRIEND, viaPeerId: null, maxDepth: 2 }],
				{ maxDepth: 2 },
			);
		});

		it('relays no further than the budget left after our own hop', async () => {
			const { manager, fakes } = build({ peerMaxDepth: 3 });

			await manager.announce('peer-1', 'v1:abc:1048576', 5);

			expect(fakes.catalogue.findHolders).toHaveBeenCalledWith(
				'v1:abc:1048576',
				expect.anything(),
				{ maxDepth: 2 },
			);
		});
	});

	describe('introducing two of our friends', () => {
		const CALLER = 'a'.repeat(64);
		const HOLDER = 'c'.repeat(64);

		const world = (
			{ peerMaxDepth = 3, caller = {}, holder = {} }: {
				peerMaxDepth?: number;
				caller?: Partial<Peer>;
				holder?: Partial<Peer>;
			} = {},
		): ReturnType<typeof build> => {
			const built = build({ peerMaxDepth });
			const rows: Record<string, Peer> = {
				'peer-1': {
					id: 'peer-1',
					name: 'Alice',
					fingerprint: CALLER,
					status: PeerStatus.LINKED,
					depth: 1,
					maxDepth: null,
					readingForbidden: false,
					trust: PeerTrust.FRIEND,
					viaPeerId: null,
					...caller,
				} as Peer,
				'peer-2': {
					id: 'peer-2',
					name: 'Chris',
					fingerprint: HOLDER,
					status: PeerStatus.LINKED,
					depth: 1,
					maxDepth: null,
					readingForbidden: false,
					trust: PeerTrust.FRIEND,
					viaPeerId: null,
					address: '203.0.113.4:4200',
					...holder,
				} as Peer,
			};

			built.fakes.peers.findOne.mockImplementation((options: { where: { id: string } }) =>
				Promise.resolve(rows[options.where.id] ?? null),
			);
			built.fakes.peers.findByFingerprint.mockImplementation((fingerprint: string) =>
				Promise.resolve(
					Object.values(rows).find((row) => row.fingerprint === fingerprint) ?? null,
				),
			);

			return built;
		};

		it('signs a token naming who may present it and which gateway it opens', async () => {
			// The two ends then talk to each other. Nothing in this answer is a byte of
			// anybody's film, and that is the whole of the feature.
			const { manager, fakes } = world();
			const answer = await manager.introduce('peer-1', { holderId: 'peer-2' });

			expect(answer).toMatchObject({ fingerprint: HOLDER, address: '203.0.113.4:4200', depth: 2 });
			expect(fakes.introductions.read(answer.token)).toMatchObject({
				introducer: OUR_FINGERPRINT,
				subject: CALLER,
				holder: HOLDER,
				depth: 2,
			});
		});

		it('never puts a media in the token, so this gateway cannot know what was wanted', async () => {
			const { manager, fakes } = world();
			const answer = await manager.introduce('peer-1', { holderId: 'peer-2' });

			expect(Object.keys(fakes.introductions.read(answer.token) ?? {})).not.toContain('media');
			expect(JSON.stringify(answer)).not.toContain('item');
		});

		it('refuses when the two ends would be further apart than the reach allows', async () => {
			// One hop is direct friends only, which is somebody saying that nobody
			// further away may reach them — and it is read here, not only on arrival.
			const { manager } = world({ peerMaxDepth: 1 });

			await expect(manager.introduce('peer-1', { holderId: 'peer-2' })).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
		});

		it("stops at the holder's own shorter reach, whatever the gateway ceiling says", async () => {
			const { manager } = world({ peerMaxDepth: 6, holder: { maxDepth: 1 } });

			await expect(manager.introduce('peer-1', { holderId: 'peer-2' })).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
		});

		it('counts a chain from both sides, so introducing in steps does not defeat the limit', async () => {
			// A caller who is themselves two hops away is three from a friend of ours.
			const { manager } = world({ peerMaxDepth: 2, caller: { depth: 2 } });

			await expect(manager.introduce('peer-1', { holderId: 'peer-2' })).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
		});

		it('refuses to introduce somebody to themselves, or to a gateway we are not linked to', async () => {
			const { manager } = world({ holder: { status: PeerStatus.PENDING } });

			await expect(manager.introduce('peer-1', { holderId: 'peer-2' })).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
			await expect(manager.introduce('peer-1', { holderId: 'peer-1' })).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
		});

		it('introduces to a friend we merely cannot reach ourselves', async () => {
			// Our own connectivity is not their consent: they may be perfectly reachable
			// from where the caller is sitting, which is half the reason this beats
			// relaying in the first place.
			const { manager } = world({ holder: { status: PeerStatus.UNREACHABLE } });

			await expect(manager.introduce('peer-1', { holderId: 'peer-2' })).resolves.toMatchObject({
				fingerprint: HOLDER,
			});
		});

		it('answers the same introduction when the holder is named by fingerprint', async () => {
			// The dial ladder has no other name for a gateway it already knows: a row
			// identifier is the introducer's, and a fingerprint is what a peer *is*.
			// Refusing this form would mean a second way to be introduced beside this one.
			const { manager, fakes } = world();
			const answer = await manager.introduce('peer-1', { fingerprint: HOLDER });

			expect(answer).toMatchObject({ fingerprint: HOLDER, depth: 2 });
			expect(fakes.introductions.read(answer.token)).toMatchObject({ holder: HOLDER });
		});

		it('refuses a holder named by neither name', async () => {
			const { manager } = world();

			await expect(manager.introduce('peer-1', {})).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
		});

		it('introduces nobody who is served nothing of ours', async () => {
			const { manager } = world({ caller: { readingForbidden: true } });

			await expect(manager.introduce('peer-1', { holderId: 'peer-2' })).rejects.toThrow(
				ErrorKey.PEER_INTRODUCTION_REFUSED,
			);
		});

		it('answers the same over the link as when asked directly', async () => {
			const { manager, fakes } = world();
			const answer = (await manager.call('peer-1', PEER_INTRODUCE_METHOD, {
				holderId: 'peer-2',
			})) as { token: string; depth: number };

			expect(answer.depth).toBe(2);
			expect(fakes.introductions.read(answer.token)).toMatchObject({
				subject: CALLER,
				holder: HOLDER,
			});
		});

		it('reads a holder named by something other than a string as naming nobody', async () => {
			// A number where an identifier belongs is not a row identifier of ours, and
			// coercing it into one would be the wire choosing who gets introduced.
			const { manager } = world();

			await expect(
				manager.call('peer-1', PEER_INTRODUCE_METHOD, { holderId: 2, fingerprint: '' }),
			).rejects.toThrow(ErrorKey.PEER_INTRODUCTION_REFUSED);
		});
	});

	/**
	 * Every path a peer can reach, against a gateway that shares nothing with them.
	 *
	 * `visiblePolicies` answering nothing is what forbidding somebody to read looks
	 * like from here, and the claim is that *no* path decides visibility a second way
	 * — so every one of them has to be exercised, not the catalogue alone.
	 */
	describe('a peer who may see no library at all', () => {
		const nothing = (): ReturnType<typeof build> => {
			const built = build();

			built.fakes.shares.visiblePolicies.mockResolvedValue([]);

			return built;
		};

		it('is served an empty catalogue', async () => {
			const { manager } = nothing();

			await expect(manager.catalogue('peer-1')).resolves.toEqual([]);
		});

		it('is served no libraries', async () => {
			const { manager } = nothing();

			await expect(manager.libraries('peer-1')).resolves.toEqual([]);
		});

		it('cannot describe an item, and is told it does not exist', async () => {
			// Not found rather than forbidden: a peer that can tell the two apart maps
			// out what somebody holds without being allowed to see any of it.
			const { manager } = nothing();

			await expect(manager.describe('peer-1', 'item-1')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});

		it('cannot pull the bytes either', async () => {
			const { manager } = nothing();

			await expect(manager.content('peer-1', 'item-1')).rejects.toThrow(ErrorKey.MEDIA_NOT_FOUND);
		});

		it('cannot have an item revalidated', async () => {
			const { manager } = nothing();

			await expect(manager.revalidate('peer-1', 'item-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});

		it('is told we hold nothing, and is asked nothing on their behalf', async () => {
			// Walking the swarm for somebody we serve no bytes to would spend our
			// friends' connections, and the set of gateways we are linked to is itself
			// something they would be learning about us.
			const { manager, fakes } = nothing();

			await expect(manager.announce('peer-1', 'v1:abc:1048576', 2)).resolves.toEqual({
				contentId: 'v1:abc:1048576',
				held: false,
				holders: [],
			});
			expect(fakes.catalogue.findHolders).not.toHaveBeenCalled();
		});

		it('is given no holders, not even ourselves', async () => {
			const { manager, fakes } = nothing();

			await expect(manager.holders('peer-1', 'v1:abc:1048576')).resolves.toEqual([]);
			// And no query went out over an empty set of libraries, which the two
			// drivers do not render alike.
			expect(fakes.items.find).not.toHaveBeenCalled();
		});
	});

	describe('answering a call over the link', () => {
		it('names value methods and byte methods apart, and knows nothing else', () => {
			const { manager } = build();

			expect(manager.kind('catalogue.list')).toBe(PeerMethodKind.VALUE);
			expect(manager.kind('media.range')).toBe(PeerMethodKind.STREAM);
			expect(manager.kind('catalogue.delete')).toBeNull();
		});

		it('answers a method it has never heard of as unsupported, rather than failing', async () => {
			// Unsupported, and the link stays up: it is what lets a gateway gain a method
			// without the other end being updated first.
			const { manager } = build();

			await expect(manager.call('peer-1', 'catalogue.delete', {})).rejects.toThrow(
				ErrorKey.PEER_METHOD_UNSUPPORTED,
			);
		});

		it('never serves bytes for a method that answers with a value', async () => {
			const { manager, fakes } = build();

			await expect(
				manager.stream('peer-1', 'catalogue.list', { externalId: 'item-1' }),
			).rejects.toThrow(ErrorKey.PEER_METHOD_UNSUPPORTED);
			expect(fakes.openStream).not.toHaveBeenCalled();
		});

		it('says it holds every piece of what it publishes', async () => {
			// Only whole files are ever in the catalogue, so null — "all of it" — is
			// the truth rather than a shortcut.
			const { manager } = build();

			await expect(manager.call('peer-1', 'swarm.bitfield', {})).resolves.toEqual({
				pieces: null,
			});
		});

		it('describes an item with the two fields a transport on an older image reads', async () => {
			// `size` and `resumable` stay at the top level beside the whole row: moving
			// them would break every transfer in flight against a peer not yet updated.
			const { manager } = build();

			const answer = (await manager.call('peer-1', 'media.describe', {
				externalId: 'item-1',
			})) as { entry: { externalId: string }; size: number; resumable: boolean };

			expect(answer).toMatchObject({ size: 1_048_576, resumable: true });
			expect(answer.entry.externalId).toBe('item-1');
			expect(JSON.stringify(answer)).not.toContain('/library-a/');
		});

		it('describes nothing when the call names no item', async () => {
			const { manager } = build();

			await expect(manager.call('peer-1', 'media.describe', {})).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});

		it('revalidates over the link with the identifier we published', async () => {
			const { manager, fakes } = build();

			fakes.getItem.mockResolvedValue({ file: file() });

			await expect(
				manager.call('peer-1', 'media.revalidate', { externalId: 'item-1' }),
			).resolves.toEqual({ externalId: 'item-1', file: file() });
		});

		it('reads a stamp it cannot parse as no stamp, and sends everything', async () => {
			// The other reading — nothing is newer than an invalid date — would leave a
			// peer's copy of our catalogue frozen with nothing anywhere saying why.
			const { manager } = build();

			const answer = (await manager.call('peer-1', 'catalogue.list', {
				since: 'last tuesday',
				page: 'two',
			})) as { entries: unknown[] };

			expect(answer.entries).toHaveLength(1);
		});

		it('publishes an item with no file under no swarm identifier', async () => {
			// A series row holds no bytes. Publishing a content identifier for it would
			// have peers asking us for a file that does not exist.
			const { manager } = build({ items: [item({ file: null })] });

			const [entry] = await manager.catalogue('peer-1');

			expect(entry).toMatchObject({ contentId: null, size: null });
		});
	});

	describe('narrowing the catalogue to one library', () => {
		const twoLibraries = (): ReturnType<typeof build> =>
			build({
				items: [item()],
				policies: [policy(), policy({ libraryId: 'library-other' })],
			});

		it('answers a library that was shared', async () => {
			const { manager } = twoLibraries();

			await expect(
				manager.catalogue('peer-1', { libraryId: 'library-shared' }),
			).resolves.toHaveLength(1);
		});

		it('answers nothing for a library that was never shared, and asks the index nothing', async () => {
			// The intersection with what they may see is taken rather than the handle
			// trusted: a guessed library identifier must not be a way in.
			const { manager, fakes } = twoLibraries();

			await expect(
				manager.catalogue('peer-1', { libraryId: 'library-private' }),
			).resolves.toEqual([]);
			expect(fakes.items.find).not.toHaveBeenCalled();
		});
	});

	describe('publishing our libraries', () => {
		it('names a library the way we chose to, and only the ones they may see', async () => {
			const { manager, fakes } = build({
				policies: [policy(), policy({ libraryId: 'library-home' })],
			});

			fakes.libraries.find.mockResolvedValue([
				{ id: 'library-shared', name: 'Video2', alias: 'Films', kind: LibraryKind.MOVIES, itemCount: 12 },
				{ id: 'library-home', name: 'Home videos', alias: null, kind: LibraryKind.OTHER, itemCount: 3 },
			] as Library[]);

			await expect(manager.call('peer-1', 'catalogue.libraries', {})).resolves.toEqual({
				libraries: [
					// "Video2" is our media server's idea of a name, not ours.
					{ externalId: 'library-shared', name: 'Films', kind: LibraryKind.MOVIES, itemCount: 12 },
					{ externalId: 'library-home', name: 'Home videos', kind: LibraryKind.OTHER, itemCount: 3 },
				],
			});
			// Asked for by the visible set, never read wholesale and filtered after.
			expect(fakes.libraries.find).toHaveBeenCalledWith({
				where: { id: In(['library-shared', 'library-home']) },
			});
		});
	});

	describe('who holds a content identifier', () => {
		const CONTENT = 'v1:abc:1048576';
		const shelf = [
			item(),
			item({ id: 'item-2', file: file({ contentId: 'v1:other:1' }) }),
			item({ id: 'item-3', file: null }),
		];

		it('reports our own copy at distance zero, under no name of ours', async () => {
			// Zero, because the caller adds their own hop; and no identifier for us,
			// because they know us by a row of their own.
			const { manager } = build({ items: shelf });

			await expect(
				manager.call('peer-1', 'catalogue.holders', { contentId: CONTENT }),
			).resolves.toEqual({
				holders: [
					{
						peerId: '',
						peerName: '',
						serviceId: 'service-1',
						externalId: 'item-1',
						size: 1_048_576,
						trust: PeerTrust.FRIEND,
						depth: 0,
						viaPeerId: null,
					},
				],
			});
		});

		it('asks our friends too, inside the budget, and lists them after ourselves', async () => {
			const { manager, fakes } = build({ items: shelf, peerMaxDepth: 3 });
			const friend = {
				peerId: 'peer-2',
				peerName: 'Chris',
				serviceId: null,
				externalId: 'theirs-1',
				size: 1_048_576,
				trust: PeerTrust.FRIEND,
				depth: 1,
				viaPeerId: null,
			};

			fakes.catalogue.findHolders.mockResolvedValue([friend]);

			const holders = await manager.holders('peer-1', CONTENT, 2);

			expect(holders.map((holder) => holder.externalId)).toEqual(['item-1', 'theirs-1']);
		});

		it('reads a budget that is not a number as no budget, and asks nobody', async () => {
			const { manager, fakes } = build({ items: shelf, peerMaxDepth: 3 });

			await manager.call('peer-1', 'catalogue.holders', { contentId: CONTENT, depth: '9' });

			expect(fakes.catalogue.findHolders).not.toHaveBeenCalled();
		});

		it('answers nobody for an empty identifier, and looks nothing up', async () => {
			// An empty identifier matches every item with no file, which is the
			// opposite of what anybody asking meant.
			const { manager, fakes } = build({ items: shelf });

			await expect(manager.call('peer-1', 'catalogue.holders', {})).resolves.toEqual({
				holders: [],
			});
			expect(fakes.shares.visiblePolicies).not.toHaveBeenCalled();
		});
	});

	describe('serving bytes', () => {
		it('serves the range asked for', async () => {
			const { manager, fakes } = build();

			const stream = await manager.stream('peer-1', 'media.range', {
				externalId: 'item-1',
				start: 2,
				end: 5,
			});

			await expect(drain(stream)).resolves.toEqual(Buffer.from('0123456789'));
			expect(fakes.openStream.mock.calls[0][2]).toEqual({ start: 2, end: 5 });
		});

		it('serves the whole file for a range that ends before it starts, or is not numbers', async () => {
			// The whole file rather than an error: a transfer that resumes from a bad
			// offset pays one re-read, where a refusal would stall it for good.
			const { manager, fakes } = build();

			await drain(
				await manager.stream('peer-1', 'swarm.piece', { externalId: 'item-1', start: 9, end: 2 }),
			);
			await drain(
				await manager.stream('peer-1', 'media.range', { externalId: 'item-1', start: '0', end: 5 }),
			);

			expect(fakes.openStream.mock.calls.map((call) => call[2])).toEqual([undefined, undefined]);
		});

		it('paces a library that caps its own upload', async () => {
			// Ten kilobytes a second and two to send: a fifth of a second at least. A cap
			// read once at the start instead of per chunk would let this through at once.
			const { manager, fakes } = build({ policies: [policy({ rateLimit: 10_000 })] });

			fakes.openStream.mockImplementation(() =>
				Promise.resolve({
					stream: Readable.from([Buffer.alloc(2_000, 1)]),
					contentLength: 2_000,
					totalLength: 2_000,
				}),
			);

			const started = Date.now();
			const media = await manager.content('peer-1', 'item-1');
			const bytes = await drain(media.stream);

			expect(bytes).toHaveLength(2_000);
			expect(Date.now() - started).toBeGreaterThanOrEqual(150);
		});

		it('refuses the bytes of an item whose service has gone, before opening anything', async () => {
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(null);

			await expect(manager.content('peer-1', 'item-1')).rejects.toThrow(
				ErrorKey.SERVICE_NOT_FOUND,
			);
			expect(fakes.openStream).not.toHaveBeenCalled();
		});

		it('refuses the bytes of an item that has no file', async () => {
			const { manager, fakes } = build({ items: [item({ file: null })] });

			await expect(manager.content('peer-1', 'item-1')).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
			expect(fakes.services.findWithSecrets).not.toHaveBeenCalled();
		});
	});

	it('cannot revalidate an item whose service has gone, and says so rather than "gone"', async () => {
		// "Gone" would have the far end abandon a source that may come back with the
		// service; not found names the service, which is the true answer.
		const { manager, fakes } = build();

		fakes.services.findWithSecrets.mockResolvedValue(null);

		await expect(manager.revalidate('peer-1', 'item-1')).rejects.toThrow(
			ErrorKey.SERVICE_NOT_FOUND,
		);
		expect(fakes.getItem).not.toHaveBeenCalled();
	});

	it('refuses a caller no peer row matches', async () => {
		const { manager, fakes } = build();

		fakes.peers.findOne.mockResolvedValue(null);

		await expect(manager.catalogue('ghost')).rejects.toThrow(ErrorKey.PEER_NOT_FOUND);
	});
});
