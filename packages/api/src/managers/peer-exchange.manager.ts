import {
	ErrorKey,
	type CatalogueEntry,
	type MediaFileInfo,
} from '@mcs/shared';
import {
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
} from '@nestjs/common';
import { In } from 'typeorm';
import type { MediaItem, Peer as PeerEntity } from '@/entities';
import {
	MediaItemRepository,
	MediaServiceRepository,
	PeerRepository,
} from '@/repositories';
import {
	HandlerRegistry,
	PeerCatalogueService,
	SettingsService,
	type ByteRange,
	type CataloguePolicy,
	type ContentHolder,
	type MediaStream,
} from '@/services';
import { ShareManager } from './share.manager';

/** How many rows one catalogue answer carries. A peer pages through the rest. */
export const CATALOGUE_PAGE = 500;

export interface CatalogueQuery {
	/** Only what changed since this stamp, so a peer does not re-read everything. */
	since?: string | null;
	page?: number;
}

/** What we answer when a peer asks us to re-read one item. */
export interface RevalidationAnswer {
	externalId: string;
	/** Null is an answer: we no longer hold it. Not the same as failing to reply. */
	file: MediaFileInfo | null;
}

export interface AnnouncementAnswer {
	contentId: string;
	held: boolean;
	holders: ContentHolder[];
}

/**
 * The side of the gateway another gateway talks to.
 *
 * Everything here is written from one premise: the caller is not us, and what they may
 * see is decided by the share policies and their trust level, every time, on every
 * route. Nothing is allowed to answer from the index directly — an item is looked up,
 * then its library's policy is checked, and a hidden item answers "not found" rather
 * than "forbidden", because telling a peer that something exists but is hidden is
 * itself a leak of what somebody holds.
 *
 * The identifiers we publish are our own row identifiers and nothing else. A peer
 * never learns a path, a library identifier or the external identifier a media service
 * uses: those are the shape of somebody's disk, they are of no use to the far end, and
 * publishing them would tempt both sides into addressing a library by path.
 */
@Injectable()
export class PeerExchangeManager {
	private readonly _logger = new Logger(PeerExchangeManager.name);

	public constructor(
		private readonly _peers: PeerRepository,
		private readonly _items: MediaItemRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _shares: ShareManager,
		private readonly _catalogue: PeerCatalogueService,
		private readonly _handlers: HandlerRegistry,
		private readonly _settings: SettingsService,
	) {}

	/** What this peer is allowed to see of us. */
	public async catalogue(peerId: string, query: CatalogueQuery = {}): Promise<CatalogueEntry[]> {
		const peer = await this._requirePeer(peerId);
		const policies = await this._shares.visiblePolicies(peer);

		if (policies.length === 0) {
			return [];
		}

		const page = Math.max(1, Math.floor(query.page ?? 1));
		const since = this._since(query.since);
		const items = await this._items.find({
			where: { libraryId: In(policies.map((policy) => policy.libraryId)) },
			order: { updatedAt: 'ASC', id: 'ASC' },
			skip: (page - 1) * CATALOGUE_PAGE,
			take: CATALOGUE_PAGE,
		});

		const byLibrary = new Map(policies.map((policy) => [policy.libraryId, policy]));

		return items
			.filter((item) => since === null || item.updatedAt.getTime() >= since.getTime())
			.map((item) => this._entry(item, byLibrary.get(item.libraryId)));
	}

	/** One item's descriptor, when the caller may see it. */
	public async describe(peerId: string, itemId: string): Promise<CatalogueEntry> {
		const { item, policy } = await this._visible(peerId, itemId);

		return this._entry(item, policy);
	}

	/**
	 * The bytes, ranged.
	 *
	 * A library shared as catalogue only answers the same "not found" as a library that
	 * is not shared at all. The distinction is real on our side — one of them is worth
	 * showing in the peer's list and the other is not — but from the far end, asking for
	 * bytes we will not serve has exactly one honest answer.
	 */
	public async content(peerId: string, itemId: string, range?: ByteRange): Promise<MediaStream> {
		const { item, policy } = await this._visible(peerId, itemId);

		if (policy.metadataOnly || item.file === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		const service = await this._services.findWithSecrets(item.serviceId);

		if (service === null) {
			throw new NotFoundException(ErrorKey.SERVICE_NOT_FOUND);
		}

		return this._handlers.get(service.type).openStream(
			{
				id: service.id,
				type: service.type,
				baseUrl: service.baseUrl,
				token: service.token,
				username: service.username,
				password: service.password,
			},
			{ externalId: item.externalId, file: item.file },
			range,
		);
	}

	/**
	 * Re-read one item and say what we actually hold now.
	 *
	 * This is the far end of the ask-before-guessing protocol. A failed range is
	 * ambiguous — moved, re-encoded, deleted, or a flaky disk — and the only thing that
	 * distinguishes them is this answer. Answering honestly, "gone" included, is what
	 * keeps the other gateway from re-downloading something that has not changed; and
	 * failing loudly when we cannot read the service is just as important, because a
	 * silence read as "gone" would have them abandon a perfectly good source.
	 */
	public async revalidate(peerId: string, itemId: string): Promise<RevalidationAnswer> {
		const { item } = await this._visible(peerId, itemId);
		const service = await this._services.findWithSecrets(item.serviceId);

		if (service === null) {
			throw new NotFoundException(ErrorKey.SERVICE_NOT_FOUND);
		}

		try {
			const fresh = await this._handlers.get(service.type).getItem(
				{
					id: service.id,
					type: service.type,
					baseUrl: service.baseUrl,
					token: service.token,
					username: service.username,
					password: service.password,
				},
				item.externalId,
			);

			return { externalId: item.id, file: fresh?.file ?? null };
		} catch (error) {
			this._logger.warn(`Could not revalidate ${item.title}: ${String(error)}`);

			throw new ServiceUnavailableException(ErrorKey.SERVICE_UNREACHABLE);
		}
	}

	/**
	 * Do we hold this content, and do our friends.
	 *
	 * The second half is what makes a swarm worth having: a friend of the caller's
	 * friend may hold the same episode, and their bandwidth is as good as anybody's.
	 * The peer who asked is never among the answers — telling them about themselves
	 * would put one machine in the source list twice.
	 */
	public async announce(peerId: string, contentId: string): Promise<AnnouncementAnswer> {
		const peer = await this._requirePeer(peerId);
		const policies = await this._shares.visiblePolicies(peer);
		const settings = await this._settings.get();

		// Only the libraries whose files are shared count as holding it: announcing
		// something we will refuse to serve would have the far end queue a source that
		// can never deliver a byte.
		const held = await this._holdsContent(
			policies.filter((policy) => !policy.metadataOnly).map((policy) => policy.libraryId),
			contentId,
		);

		const friends = (await this._peers.findLinked())
			.filter((candidate) => candidate.id !== peer.id)
			.map((candidate) => ({
				id: candidate.id,
				name: candidate.name,
				trust: candidate.trust,
				viaPeerId: candidate.viaPeerId,
			}));

		const holders = settings.allowFriendsOfFriends
			? await this._catalogue.findHolders(contentId, friends, { allowFriendsOfFriends: true })
			: [];

		return { contentId, held, holders };
	}

	/**
	 * Does one of these libraries hold that content identifier?
	 *
	 * Filtered in memory over the libraries the caller may pull from: `contentId` lives
	 * inside the JSON blob of the file column, which neither engine can index, and a
	 * `LIKE` over serialised JSON matches things nobody meant.
	 */
	private async _holdsContent(libraryIds: string[], contentId: string): Promise<boolean> {
		if (libraryIds.length === 0) {
			return false;
		}

		const items = await this._items.find({ where: { libraryId: In(libraryIds) } });

		return items.some((item) => item.file?.contentId === contentId);
	}

	private _entry(item: MediaItem, policy: CataloguePolicy | undefined): CatalogueEntry {
		const externalIds: Record<string, string> = {};

		for (const [key, value] of Object.entries(item.externalIds ?? {})) {
			// `provider` is the identifier the reporting media service uses internally.
			// It is ours, it means nothing at the far end, and publishing it tells a peer
			// how our library is keyed for no gain at all. The metadata identifiers —
			// TVDB, TMDB, IMDb — are the point: both sides can correlate on them.
			if (key !== 'provider' && typeof value === 'string' && value !== '') {
				externalIds[key] = value;
			}
		}

		// The swarm identifier is only published when the files are shared. It is what
		// peers advertise holdings by, and handing it out for a catalogue-only library
		// would invite requests for bytes that will never be served.
		const pullable = policy !== undefined && !policy.metadataOnly;

		return {
			externalId: item.id,
			kind: item.kind,
			title: item.title,
			year: item.year,
			seasonNumber: item.seasonNumber,
			episodeNumber: item.episodeNumber,
			parentExternalId: item.parentId,
			externalIds,
			contentId: pullable ? (item.file?.contentId ?? null) : null,
			size: item.file?.size ?? null,
			quality: item.quality?.label ?? null,
		};
	}

	private async _visible(
		peerId: string,
		itemId: string,
	): Promise<{ item: MediaItem; policy: CataloguePolicy }> {
		const peer = await this._requirePeer(peerId);
		const item = await this._items.findOne({ where: { id: itemId } });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		const policy = (await this._shares.visiblePolicies(peer)).find(
			(candidate) => candidate.libraryId === item.libraryId,
		);

		if (policy === undefined) {
			// Not found, not forbidden. A peer that can tell the two apart can map out
			// what somebody holds without being allowed to see any of it.
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return { item, policy };
	}

	private _since(raw: string | null | undefined): Date | null {
		if (raw === null || raw === undefined || raw === '') {
			return null;
		}

		const parsed = new Date(raw);

		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	private async _requirePeer(id: string): Promise<PeerEntity> {
		const peer = await this._peers.findOne({ where: { id } });

		if (peer === null) {
			throw new NotFoundException(ErrorKey.PEER_NOT_FOUND);
		}

		return peer;
	}
}
