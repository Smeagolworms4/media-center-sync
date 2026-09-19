import { Readable } from 'node:stream';
import {
	ErrorKey,
	MatchStrategy,
	SyncState,
	type MediaFileInfo,
	type MediaItem,
	type MediaMatch,
	type MediaNode,
	type MediaSearchQuery,
	type ResultList,
} from '@mcs/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MediaItem as MediaItemEntity, MediaMatch as MediaMatchEntity } from '@/entities';
import {
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import {
	CacheService,
	MatchingService,
	SettingsService,
	requestStream,
	type MatchCandidate,
	type MatchProposal,
} from '@/services';
import { pageBounds, paginate, toMediaItem, toMediaMatch, toMediaNode } from './mappers';

/** Artwork, once fetched: bytes rather than a stream, because it is cached. */
export interface Artwork {
	body: Buffer;
	contentType: string;
}

/** Artwork changes when a library is rescanned, not between two page loads. */
const ARTWORK_TTL_SECONDS = 3600;

/**
 * An image large enough to be a mistake.
 *
 * Artwork is a poster; anything past this is either a video somebody put in the
 * poster field or a service answering with the wrong thing entirely, and buffering it
 * would be the gateway spending its memory on somebody else's error.
 */
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;

/**
 * Browsing the index, and the correlations under it.
 *
 * The interface never queries a media service: it reads these rows. That is what
 * makes a library of forty thousand episodes browsable at all, and it is why the only
 * thing here that leaves the machine is artwork.
 *
 * Artwork is proxied rather than linked because an `<img>` tag carries no
 * `Authorization` header — the browser would fetch the remote URL itself, anonymously,
 * against a server that wants a token. The gateway fetches it once and caches it.
 */
@Injectable()
export class MediaManager {
	private readonly _logger = new Logger(MediaManager.name);

	public constructor(
		private readonly _items: MediaItemRepository,
		private readonly _matches: MediaMatchRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _matching: MatchingService,
		private readonly _settings: SettingsService,
		private readonly _cache: CacheService,
	) {}

	/**
	 * Correlate everything one service holds against every other service.
	 *
	 * Candidates come from two places, and both are needed. The normalised title plus
	 * the episode coordinates narrow tens of thousands of rows to a handful, which is
	 * the only thing that makes correlation finish at all — comparing everything with
	 * everything is quadratic. But that lookup is blind to exactly the case that
	 * matters most: two libraries holding the same bytes under names and numbers that
	 * do not agree. So the content identity is indexed too, and an item is compared
	 * with whatever shares its fingerprint whether or not the titles could ever have
	 * met.
	 */
	public async correlateService(serviceId: string): Promise<number> {
		const threshold = await this._settings.getValue('matchThreshold');
		const services = await this._services.find();
		const peers = new Map(services.map((service) => [service.id, service.peerId]));
		const everything = await this._items.find();
		const byContent = this._indexByContent(everything);
		const mine = everything.filter((item) => item.serviceId === serviceId);
		let written = 0;

		for (const item of mine) {
			const byTitle = await this._items.findCandidatesForMatch(
				item.normalizedTitle,
				item.seasonNumber,
				item.episodeNumber,
				serviceId,
			);

			const candidates = new Map<string, MediaItemEntity>();

			for (const candidate of [...byTitle, ...this._sameContentAs(item, byContent)]) {
				if (candidate.id !== item.id && candidate.serviceId !== serviceId) {
					candidates.set(candidate.id, candidate);
				}
			}

			const proposals = this._matching
				.correlate(
					this._candidate(item, peers),
					[...candidates.values()].map((candidate) => this._candidate(candidate, peers)),
					{ threshold },
				)
				.map((proposal) =>
					this._overruleMislabelled(item, candidates.get(proposal.remoteItemId), proposal),
				);

			for (const proposal of proposals) {
				await this._matches.upsertPair(proposal);
				written += 1;
			}

			const state = this._matching.deriveItemState(proposals);

			if (state !== item.syncState) {
				await this._items.setSyncState([item.id], state);
			}
		}

		return written;
	}

	/**
	 * Two files that are the same bytes under labels that disagree.
	 *
	 * This is neither a match to apply nor a pair to call unrelated. The content is
	 * proof they are the same file; the numbers are proof that one of the two libraries
	 * has it filed wrong, or that two files were swapped. Applying the match silently
	 * would renumber somebody's library on the strength of a guess about which side is
	 * right, and dropping the pair would have the gateway offer to fetch a file it
	 * already holds. So it becomes a conflict carrying the disagreement in words, and a
	 * person decides.
	 *
	 * The reverse — the same numbers over different content — is an ordinary
	 * comparison and goes through the quality comparator like anything else.
	 */
	public labelDisagreement(local: MediaItemEntity, remote: MediaItemEntity): string | null {
		if (!this._sameContent(local.file, remote.file)) {
			return null;
		}

		if (local.episodeNumber !== remote.episodeNumber) {
			return `content identical, episode numbers differ: ${this._label(local)} here, ${this._label(remote)} there`;
		}

		if (local.seasonNumber !== remote.seasonNumber) {
			return `content identical, season numbers differ: ${this._label(local)} here, ${this._label(remote)} there`;
		}

		return null;
	}

	public async search(query: MediaSearchQuery): Promise<ResultList<MediaItem>> {
		const { page, limit } = pageBounds(query.page, query.limit);
		const [items, total] = await this._items.search({ ...query, page, limit });

		return paginate(items.map(toMediaItem), total, page, limit);
	}

	/** One node with the children it has, which is what a series or a season page is. */
	public async node(id: string): Promise<MediaNode> {
		const item = await this._require(id);
		const children = await this._items.findChildren(item.id);

		return toMediaNode(item, children);
	}

	public async children(id: string, query: MediaSearchQuery): Promise<ResultList<MediaItem>> {
		await this._require(id);

		const { page, limit } = pageBounds(query.page, query.limit);
		// The parent is the route's, never the query string's: a caller who sent both
		// would otherwise be browsing a different subtree than the one they asked for.
		const [items, total] = await this._items.search({ ...query, parentId: id, page, limit });

		return paginate(items.map(toMediaItem), total, page, limit);
	}

	/**
	 * Every correlation this item takes part in, from both sides.
	 *
	 * An item is the local side of some matches and the remote side of others — the
	 * same episode on a friend's gateway is the remote half of ours and the local half
	 * of theirs. Listing only one side would make half the correlations invisible from
	 * the page they concern.
	 */
	public async matches(id: string): Promise<MediaMatch[]> {
		await this._require(id);

		const local = await this._matches.findForLocalItem(id);
		const remote = await this._matches.findForRemoteItem(id);
		const unique = new Map<string, MediaMatchEntity>();

		for (const match of [...local, ...remote]) {
			unique.set(match.id, match);
		}

		return [...unique.values()]
			.sort((left, right) => right.confidence - left.confidence)
			.map(toMediaMatch);
	}

	/**
	 * A human overruling the score.
	 *
	 * Recorded rather than applied silently: `confirmedAt` is what lets the review
	 * screen stop proposing it, and the strategy becomes `MANUAL` because that is what
	 * it now is — keeping the score that did not convince anybody would leave the row
	 * looking like the algorithm had made the call.
	 */
	public async confirmMatch(
		itemId: string,
		matchId: string,
		localItemId?: string | null,
	): Promise<MediaMatch> {
		await this._require(itemId);

		const match = await this._requireMatch(itemId, matchId);

		if (localItemId !== undefined) {
			match.localItemId = localItemId;
		}

		match.strategy = MatchStrategy.MANUAL;
		match.confidence = 1;
		match.confirmedAt = new Date();

		return toMediaMatch(await this._matches.save(match));
	}

	/** Undoing one. A correlation nobody can undo is one nobody will trust. */
	public async deleteMatch(itemId: string, matchId: string): Promise<void> {
		await this._require(itemId);

		const match = await this._requireMatch(itemId, matchId);

		await this._matches.delete({ id: match.id });
	}

	/**
	 * The poster, fetched once and kept.
	 *
	 * The cache is what makes this bearable: a grid of sixty posters is sixty requests
	 * from the browser, and without it every one of them would be a request to
	 * somebody's Raspberry Pi.
	 */
	public async artwork(id: string): Promise<Artwork> {
		const item = await this._require(id);

		if (item.artworkUrl === null || item.artworkUrl === '') {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		const key = `artwork:${item.id}:${item.updatedAt.getTime()}`;
		const cached = await this._cache.get<{ body: string; contentType: string }>(key);

		if (cached !== null) {
			return { body: Buffer.from(cached.body, 'base64'), contentType: cached.contentType };
		}

		const artwork = await this._fetchArtwork(item);

		await this._cache.set(
			key,
			{ body: artwork.body.toString('base64'), contentType: artwork.contentType },
			ARTWORK_TTL_SECONDS,
		);

		return artwork;
	}

	private async _fetchArtwork(item: MediaItemEntity): Promise<Artwork> {
		const service = await this._services.findOne({ where: { id: item.serviceId } });

		if (service === null) {
			throw new NotFoundException(ErrorKey.SERVICE_NOT_FOUND);
		}

		// The stored URL is absolute and already points at the service, so it is handed
		// over as the base with nothing appended. It goes out unauthenticated: the
		// handler contract has no artwork capability, so there is nowhere to ask for
		// the header or the query parameter a given service wants. Jellyfin serves
		// images without one; a service that does not will answer 401 here, and the
		// fix is a method on the handler rather than a branch on the type in this file.
		const response = await requestStream(item.artworkUrl as string, '');

		return {
			body: await this._collect(response.stream),
			contentType: response.contentType ?? 'application/octet-stream',
		};
	}

	private async _collect(stream: Readable): Promise<Buffer> {
		const chunks: Buffer[] = [];
		let size = 0;

		for await (const chunk of stream) {
			const buffer = Buffer.from(chunk as Buffer);

			size += buffer.length;

			if (size > MAX_ARTWORK_BYTES) {
				stream.destroy();
				this._logger.warn('Artwork response exceeded the ceiling and was dropped');

				throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
			}

			chunks.push(buffer);
		}

		return Buffer.concat(chunks);
	}

	/**
	 * Turn a scored proposal into a conflict when the labels contradict the bytes.
	 *
	 * The proposal is rewritten rather than dropped so the row still exists: the pair
	 * has to be visible somewhere for anybody to arbitrate it, and a correlation the
	 * gateway silently refused to record is one nobody can act on.
	 */
	private _overruleMislabelled(
		local: MediaItemEntity,
		remote: MediaItemEntity | undefined,
		proposal: MatchProposal,
	): MatchProposal {
		const disagreement = remote === undefined ? null : this.labelDisagreement(local, remote);

		if (disagreement === null) {
			return proposal;
		}

		this._logger.warn(`${local.title}: ${disagreement}`);

		return { ...proposal, state: SyncState.CONFLICT, reason: disagreement };
	}

	/** Files are the same when anything that identifies their content agrees. */
	private _sameContent(left: MediaFileInfo | null, right: MediaFileInfo | null): boolean {
		return this._contentKeys(left).some((key) => this._contentKeys(right).includes(key));
	}

	/**
	 * The identities a file can be recognised by, strongest first.
	 *
	 * A checksum is proof. `contentId` is a few sampled ranges plus the exact size,
	 * which two gateways compute identically without exchanging anything — the whole
	 * reason it exists. A size on its own is deliberately not in the list: two files of
	 * the same length are not the same file, and treating them as such would turn this
	 * rule into a machine for inventing conflicts.
	 */
	private _contentKeys(file: MediaFileInfo | null): string[] {
		if (file === null) {
			return [];
		}

		const keys: string[] = [];

		if (file.checksum !== null && file.checksum !== '') {
			keys.push(`checksum:${file.checksum}`);
		}

		if (file.contentId !== null && file.contentId !== '') {
			keys.push(`content:${file.contentId}`);
		}

		return keys;
	}

	private _indexByContent(items: MediaItemEntity[]): Map<string, MediaItemEntity[]> {
		const index = new Map<string, MediaItemEntity[]>();

		for (const item of items) {
			for (const key of this._contentKeys(item.file)) {
				index.set(key, [...(index.get(key) ?? []), item]);
			}
		}

		return index;
	}

	private _sameContentAs(
		item: MediaItemEntity,
		index: Map<string, MediaItemEntity[]>,
	): MediaItemEntity[] {
		return this._contentKeys(item.file).flatMap((key) => index.get(key) ?? []);
	}

	/** `S01E05`, with a question mark where a library told us nothing. */
	private _label(item: MediaItemEntity): string {
		const season = item.seasonNumber === null ? '??' : String(item.seasonNumber).padStart(2, '0');
		const episode = item.episodeNumber === null ? '??' : String(item.episodeNumber).padStart(2, '0');

		return `S${season}E${episode}`;
	}

	private _candidate(
		item: MediaItemEntity,
		peers: Map<string, string | null>,
	): MatchCandidate {
		return {
			id: item.id,
			serviceId: item.serviceId,
			peerId: peers.get(item.serviceId) ?? null,
			parentId: item.parentId,
			kind: item.kind,
			title: item.title,
			normalizedTitle: item.normalizedTitle,
			year: item.year,
			seasonNumber: item.seasonNumber,
			episodeNumber: item.episodeNumber,
			externalIds: item.externalIds,
			file: item.file,
		};
	}

	private async _require(id: string): Promise<MediaItemEntity> {
		const item = await this._items.findOne({ where: { id } });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return item;
	}

	/**
	 * The match, checked against the item the route named.
	 *
	 * Without that check any identifier would do for the first half of the path, and a
	 * confirmation would be recorded against a correlation somebody was not looking at.
	 */
	private async _requireMatch(itemId: string, matchId: string): Promise<MediaMatchEntity> {
		const match = await this._matches.findOne({ where: { id: matchId } });

		if (match === null || (match.localItemId !== itemId && match.remoteItemId !== itemId)) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		return match;
	}
}
