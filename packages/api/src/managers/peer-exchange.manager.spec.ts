import {
	ErrorKey,
	MediaKind,
	PeerTrust,
	ShareVisibility,
	SyncState,
	type MediaFileInfo,
} from '@mcs/shared';
import type { MediaItem, Peer } from '@/entities';
import type {
	MediaItemRepository,
	MediaServiceRepository,
	PeerRepository,
} from '@/repositories';
import { BandwidthService } from '@/services';
import type {
	CataloguePolicy,
	HandlerRegistry,
	PeerCatalogueService,
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
	metadataOnly: false,
	...overrides,
});

interface Fakes {
	items: { find: jest.Mock; findOne: jest.Mock; count: jest.Mock };
	shares: { visiblePolicies: jest.Mock };
	peers: { findOne: jest.Mock; findLinked: jest.Mock };
	catalogue: { findHolders: jest.Mock };
	openStream: jest.Mock;
	getItem: jest.Mock;
}

const build = (
	world: { items?: MediaItem[]; policies?: CataloguePolicy[] } = {},
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
		},
		catalogue: { findHolders: jest.fn().mockResolvedValue([]) },
		openStream: jest.fn().mockResolvedValue({ stream: null, contentLength: 1, totalLength: 1 }),
		getItem: jest.fn().mockResolvedValue(null),
	};

	const manager = new PeerExchangeManager(
		fakes.peers as unknown as PeerRepository,
		fakes.items as unknown as MediaItemRepository,
		{
			findWithSecrets: jest
				.fn()
				.mockResolvedValue({ id: 'service-1', type: 'jellyfin', baseUrl: 'http://x', token: 't' }),
		} as unknown as MediaServiceRepository,
		fakes.shares as unknown as ShareManager,
		fakes.catalogue as unknown as PeerCatalogueService,
		{
			get: jest.fn(() => ({ openStream: fakes.openStream, getItem: fakes.getItem })),
		} as unknown as HandlerRegistry,
		{
			get: jest.fn().mockResolvedValue({ allowFriendsOfFriends: false }),
		} as unknown as SettingsService,
		// The real bucket, uncapped: the throttling belongs to its own test, and a fake
		// here would let the serving path stop paying for what it sends without
		// anything noticing.
		new BandwidthService(),
	);

	return { manager, fakes };
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

	describe('a library shared as catalogue only', () => {
		it('lists the item, so somebody knows it exists and can ask', async () => {
			const { manager } = build({ policies: [policy({ metadataOnly: true })] });

			const entries = await manager.catalogue('peer-1');

			expect(entries).toHaveLength(1);
			expect(entries[0].title).toBe('The Flight');
		});

		it('publishes no swarm identifier for it', async () => {
			const { manager } = build({ policies: [policy({ metadataOnly: true })] });

			const [entry] = await manager.catalogue('peer-1');

			expect(entry.contentId).toBeNull();
		});

		it('refuses the bytes', async () => {
			const { manager, fakes } = build({ policies: [policy({ metadataOnly: true })] });

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

		it('does not claim to hold something we only share the catalogue of', async () => {
			const { manager } = build({ policies: [policy({ metadataOnly: true })] });

			await expect(manager.announce('peer-1', 'v1:abc:1048576')).resolves.toMatchObject({
				held: false,
			});
		});

		it('keeps friends of friends out when the setting says so', async () => {
			const { manager, fakes } = build();

			await manager.announce('peer-1', 'v1:abc:1048576');

			expect(fakes.catalogue.findHolders).not.toHaveBeenCalled();
		});
	});

	it('refuses a caller no peer row matches', async () => {
		const { manager, fakes } = build();

		fakes.peers.findOne.mockResolvedValue(null);

		await expect(manager.catalogue('ghost')).rejects.toThrow(ErrorKey.PEER_NOT_FOUND);
	});
});
