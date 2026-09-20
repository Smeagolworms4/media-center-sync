import { Readable } from 'node:stream';
import {
	ErrorKey,
	LibraryKind,
	PeerTrust,
	type CatalogueEntry,
	type MediaFileInfo,
	type PeerLibrary,
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
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	PeerRepository,
} from '@/repositories';
import {
	BandwidthService,
	HandlerRegistry,
	PeerCatalogueService,
	PeerMethodKind,
	SettingsService,
	TokenBucket,
	type ByteRange,
	type CataloguePolicy,
	type ContentHolder,
	type MediaStream,
	type PeerMethodHandler,
	type PeerMethodKindValue,
} from '@/services';
import { ShareManager } from './share.manager';

/** How many rows one catalogue answer carries. A peer pages through the rest. */
export const CATALOGUE_PAGE = 500;

/**
 * What a peer may ask for over the link, and how each one is answered.
 *
 * The table is the contract. A method that is not in it is answered with
 * `error.peer.method_unsupported` and the link stays open — which is what lets a
 * gateway gain a method without the protocol version moving and without the other end
 * being updated first.
 *
 * The names are the ones the outgoing side already sends, so both halves of this
 * application speak the same wire whichever way the socket was opened.
 */
const PEER_METHODS: Readonly<Record<string, PeerMethodKindValue>> = Object.freeze({
	'catalogue.list': PeerMethodKind.VALUE,
	'catalogue.libraries': PeerMethodKind.VALUE,
	'catalogue.holders': PeerMethodKind.VALUE,
	'media.describe': PeerMethodKind.VALUE,
	'media.revalidate': PeerMethodKind.VALUE,
	'media.range': PeerMethodKind.STREAM,
	'swarm.bitfield': PeerMethodKind.VALUE,
	'swarm.piece': PeerMethodKind.STREAM,
});

export interface CatalogueQuery {
	/** Only what changed since this stamp, so a peer does not re-read everything. */
	since?: string | null;
	page?: number;
	/**
	 * One shared library of ours, named by the handle `catalogue.libraries` published.
	 *
	 * The far end sends it because it imports library by library, and a library it is
	 * no longer allowed to see simply answers nothing — the visibility check below
	 * runs first and a handle outside it is not an error to report, it is a library
	 * that does not exist as far as this caller is concerned.
	 */
	libraryId?: string | null;
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
 * The identifiers we publish are our own row identifiers and nothing else — an item's
 * and, since a peer is a media service to whoever links to us, its library's. A peer
 * never learns a path or the external identifier a media service uses: those are the
 * shape of somebody's disk, they are of no use to the far end, and publishing them
 * would tempt both sides into addressing a library by path.
 */
@Injectable()
export class PeerExchangeManager implements PeerMethodHandler {
	private readonly _logger = new Logger(PeerExchangeManager.name);

	public constructor(
		private readonly _peers: PeerRepository,
		private readonly _items: MediaItemRepository,
		private readonly _libraries: LibraryRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _shares: ShareManager,
		private readonly _catalogue: PeerCatalogueService,
		private readonly _handlers: HandlerRegistry,
		private readonly _settings: SettingsService,
		private readonly _bandwidth: BandwidthService,
	) {}

	public kind(method: string): PeerMethodKindValue | null {
		return PEER_METHODS[method] ?? null;
	}

	/**
	 * A method call from a peer, answered with a value.
	 *
	 * Every parameter is read defensively and nothing is required beyond what the
	 * method really needs: a payload carrying a field this version has never heard of
	 * is a newer gateway being newer, and dropping the link over it would make every
	 * addition to the protocol a breaking change.
	 */
	public async call(
		peerId: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		switch (method) {
			case 'catalogue.list':
				return {
					entries: await this.catalogue(peerId, {
						since: this._string(params.since),
						page: this._number(params.page) ?? 1,
						libraryId: this._string(params.libraryId),
					}),
				};

			case 'catalogue.libraries':
				return { libraries: await this.libraries(peerId) };

			case 'catalogue.holders':
				return {
					holders: await this.holders(
						peerId,
						this._string(params.contentId) ?? '',
						this._number(params.depth) ?? 0,
					),
				};

			case 'media.describe': {
				const entry = await this.describe(peerId, this._itemId(params));

				// Another gateway is our own code at the far end: it serves ranges. Piece
				// hashes are not sent because nothing stores them — they are a function of
				// the file, computed when a swarm transfer starts.
				//
				// The whole row rides alongside rather than replacing those two fields:
				// the transport reads `size` and `resumable` and a peer running an older
				// image sends only those, so moving them would break every transfer
				// already in flight against it. Nested under a key of its own so a field
				// the row gains can never collide with one the transport reads.
				return { entry, size: entry.size, resumable: true };
			}

			case 'media.revalidate':
				return this.revalidate(peerId, this._itemId(params));

			case 'swarm.bitfield':
				// Null means "all of it", which is the truth: this gateway only ever
				// publishes files it holds whole. A partial holding is a transfer in
				// progress, and those are not in the catalogue.
				return { pieces: null };

			default:
				throw new NotFoundException(ErrorKey.PEER_METHOD_UNSUPPORTED);
		}
	}

	/** A method call whose answer is bytes. */
	public async stream(
		peerId: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<Readable> {
		if (method !== 'media.range' && method !== 'swarm.piece') {
			throw new NotFoundException(ErrorKey.PEER_METHOD_UNSUPPORTED);
		}

		const media = await this.content(peerId, this._itemId(params), this._range(params));

		return media.stream;
	}

	/**
	 * Everybody we know of who holds a content identifier, ourselves included.
	 *
	 * Our own holdings are reported with an empty peer identifier, because we have no
	 * idea what the caller calls us — they know us by a row of their own, and naming
	 * ourselves with our own identifier would have them file it under a peer they do
	 * not have.
	 */
	public async holders(peerId: string, contentId: string, budget = 0): Promise<ContentHolder[]> {
		if (contentId === '') {
			return [];
		}

		const peer = await this._requirePeer(peerId);
		const policies = await this._shares.visiblePolicies(peer);
		const answer = await this.announce(peerId, contentId, budget);
		const mine = await this._items.find({
			where: { libraryId: In(policies.map((policy) => policy.libraryId)) },
		});

		// Distance zero, because these are measured from us and the caller adds their
		// own hop. Reporting one here is the mistake that makes every chain read one
		// circle longer than it is, and it compounds: a three-hop limit would stop
		// admitting the third hop, and nobody would be able to say why.
		const self: ContentHolder[] = mine
			.filter((item) => item.file?.contentId === contentId)
			.map((item) => ({
				peerId: '',
				peerName: '',
				serviceId: item.serviceId,
				externalId: item.id,
				size: item.file?.size ?? null,
				trust: PeerTrust.FRIEND,
				depth: 0,
				viaPeerId: null,
			}));

		return [...self, ...answer.holders];
	}

	/**
	 * Which of our libraries this peer may see, as libraries rather than as rows.
	 *
	 * The handle published is our library row identifier, which is the same class of
	 * thing as the item identifiers already on the wire: ours, opaque to them, and
	 * meaningless anywhere else. What still never crosses is a path or the identifier
	 * the media server underneath uses — those describe somebody's disk, and the far
	 * end has no business addressing a library by either.
	 *
	 * It exists because a peer is a media service on the other side of the link, and a
	 * media service that cannot say what its libraries are collapses into one bag of
	 * files: no categories, no per-library sync scope, and a missing count computed
	 * against everything somebody shares rather than against the one library they meant.
	 */
	public async libraries(peerId: string): Promise<PeerLibrary[]> {
		const peer = await this._requirePeer(peerId);
		const policies = await this._shares.visiblePolicies(peer);

		if (policies.length === 0) {
			return [];
		}

		const rows = await this._libraries.find({
			where: { id: In(policies.map((policy) => policy.libraryId)) },
		});

		return rows.map((library) => ({
			externalId: library.id,
			// What we chose to call it, when somebody chose. A friend reading "Video2"
			// on their own screen is reading our media server's idea of a name, not ours.
			name: library.alias ?? library.name,
			kind: library.kind ?? LibraryKind.OTHER,
			itemCount: library.itemCount,
		}));
	}

	/** What this peer is allowed to see of us. */
	public async catalogue(peerId: string, query: CatalogueQuery = {}): Promise<CatalogueEntry[]> {
		const peer = await this._requirePeer(peerId);
		const policies = await this._shares.visiblePolicies(peer);
		// Narrowed by the caller's handle, but only ever inside what they may see: the
		// intersection is taken rather than the requested library trusted, so asking for
		// a library that was never shared returns nothing instead of returning it.
		const wanted = policies.filter(
			(policy) => !query.libraryId || policy.libraryId === query.libraryId,
		);

		if (wanted.length === 0) {
			return [];
		}

		const page = Math.max(1, Math.floor(query.page ?? 1));
		const since = this._since(query.since);
		const items = await this._items.find({
			where: { libraryId: In(wanted.map((policy) => policy.libraryId)) },
			order: { updatedAt: 'ASC', id: 'ASC' },
			skip: (page - 1) * CATALOGUE_PAGE,
			take: CATALOGUE_PAGE,
		});

		const byLibrary = new Map(wanted.map((policy) => [policy.libraryId, policy]));

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

		if (item.file === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		const service = await this._services.findWithSecrets(item.serviceId);

		if (service === null) {
			throw new NotFoundException(ErrorKey.SERVICE_NOT_FOUND);
		}

		const opened = await this._handlers.get(service.type).openStream(
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

		return { ...opened, stream: this._throttled(opened.stream, policy.rateLimit) };
	}

	/**
	 * The same bytes, paced by what the gateway is allowed to send.
	 *
	 * Two caps apply and the smaller one wins: the global upload limit, which is the
	 * control people expect to find next to the queue, and the per-library one, which
	 * is how somebody shares a collection without giving away their whole line. A
	 * setting that exists and throttles nothing is worse than no setting, and until
	 * now the upload limit was exactly that.
	 *
	 * Paced per chunk rather than per response: charged once at the start, a peer
	 * pulling forty gigabytes would pay for the first buffer and then take the rest at
	 * line rate.
	 */
	private _throttled(stream: Readable, libraryLimit: number): Readable {
		const perLibrary = Number(libraryLimit) || 0;

		return Readable.from(
			(async function* (bandwidth: BandwidthService): AsyncGenerator<Buffer> {
				const library = perLibrary > 0 ? new TokenBucket(perLibrary) : null;

				for await (const chunk of stream) {
					const buffer = Buffer.from(chunk as Buffer);

					await bandwidth.send(buffer.length);
					await library?.take(buffer.length);

					yield buffer;
				}
			})(this._bandwidth),
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
	public async announce(
		peerId: string,
		contentId: string,
		budget = 0,
	): Promise<AnnouncementAnswer> {
		const peer = await this._requirePeer(peerId);
		const policies = await this._shares.visiblePolicies(peer);
		const settings = await this._settings.get();

		// Only the libraries whose files are shared count as holding it: announcing
		// something we will refuse to serve would have the far end queue a source that
		// can never deliver a byte.
		const held = await this._holdsContent(
			policies.map((policy) => policy.libraryId),
			contentId,
		);

		const friends = (await this._peers.findLinked())
			.filter((candidate) => candidate.id !== peer.id)
			.map((candidate) => ({
				id: candidate.id,
				name: candidate.name,
				trust: candidate.trust,
				viaPeerId: candidate.viaPeerId,
				maxDepth: candidate.maxDepth,
			}));

		// The caller's budget, never more than our own ceiling allows. A peer asking
		// for ten hops is asking us to spend our friends' connections walking a network
		// we decided not to walk — our limit is a limit on what we relay, not only on
		// what we accept, or it protects nothing.
		const reach = Math.min(Math.max(0, Math.trunc(budget)), settings.peerMaxDepth - 1);
		const holders =
			reach > 0
				? await this._catalogue.findHolders(contentId, friends, { maxDepth: reach })
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
		const pullable = policy !== undefined;

		return {
			externalId: item.id,
			libraryId: item.libraryId,
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

	/**
	 * The item a peer is asking about.
	 *
	 * `externalId` on the wire is the identifier *we* published for that item, which
	 * is our own row identifier and nothing else. A peer never learns a path, a
	 * library or the identifier the media service underneath uses.
	 */
	private _itemId(params: Record<string, unknown>): string {
		return this._string(params.externalId) ?? '';
	}

	private _range(params: Record<string, unknown>): ByteRange | undefined {
		const start = this._number(params.start);
		const end = this._number(params.end);

		if (start === null || end === null || end < start) {
			return undefined;
		}

		return { start, end };
	}

	private _string(value: unknown): string | null {
		return typeof value === 'string' && value !== '' ? value : null;
	}

	private _number(value: unknown): number | null {
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	}

	private async _requirePeer(id: string): Promise<PeerEntity> {
		const peer = await this._peers.findOne({ where: { id } });

		if (peer === null) {
			throw new NotFoundException(ErrorKey.PEER_NOT_FOUND);
		}

		return peer;
	}
}
