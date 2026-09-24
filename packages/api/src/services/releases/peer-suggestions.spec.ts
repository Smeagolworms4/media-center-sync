import {
	MediaOrigin,
	MediaServiceType,
	PEER_SUGGESTION_PREFIX,
	ReleaseKind,
	SuggestionSource,
	SyncState,
	type EpisodeRef,
	type MediaGroupSource,
	type PeerCopy,
	type QualitySummary,
	type ReleaseGroup,
} from '@mcs/shared';
import { QualityService } from '../quality.service';
import { orderSuggestions, PeerSuggestionService, type SuggestionHolding } from './peer-suggestions';

/**
 * A copy somebody already holds is a different kind of answer from a name on a tracker.
 *
 * Two things are pinned here. That the folding is per holder and per season — because a
 * service holding four of the episodes somebody is short of is one thing to press, and
 * four rows saying the same would make the friend's copy look worse than the season pack
 * beneath it. And that the order puts what exists above what is claimed, with what brings
 * nothing last, whichever of the two vocabularies says so.
 */

const source = (overrides: Partial<MediaGroupSource> = {}): MediaGroupSource =>
	({
		itemId: 'their-1',
		serviceId: 'svc-alice',
		serviceName: 'Alice Jellyfin',
		serviceType: MediaServiceType.JELLYFIN,
		peerId: 'peer-alice',
		peerName: 'Alice',
		quality: null,
		companions: null,
		bytes: 1_000,
		versionId: null,
		edition: null,
		local: false,
		path: '/media/Shows/Spartacus/S01E01.mkv',
		localPath: null,
		sync: SyncState.IN_SYNC,
		...overrides,
	}) as MediaGroupSource;

const ref = (episodeNumber: number, seasonNumber: number | null = 1): EpisodeRef => ({
	itemId: `our-ep-${seasonNumber ?? 'x'}-${episodeNumber}`,
	seasonNumber,
	episodeNumber,
	title: `Episode ${episodeNumber}`,
});

const summary = (resolution: string, bytes: number, codec = 'x265'): QualitySummary => {
	const variant = {
		label: `${codec} · ${resolution}`,
		videoCodec: codec,
		resolution,
		hdr: null,
		audioCodec: null,
		audioChannels: null,
		container: 'mkv',
		count: 1,
		bytes,
	};

	return {
		label: variant.label,
		mixed: false,
		dominant: variant,
		variants: [variant],
		fileCount: 1,
		totalBytes: bytes,
	};
};

const group = (overrides: Partial<ReleaseGroup> = {}): ReleaseGroup => ({
	key: 'grp-1',
	title: 'Spartacus.S01E01.1080p.WEB-DL-GRP',
	kind: ReleaseKind.EPISODE,
	seasonNumber: 1,
	episodeNumber: 1,
	quality: '1080p',
	source: 'WEB-DL',
	languages: [],
	size: 3_000,
	seeders: 40,
	releases: [],
	coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false },
	fills: [ref(1)],
	brings: [],
	heldAlready: false,
	...overrides,
});

const copy = (overrides: Partial<PeerCopy> = {}): PeerCopy => ({
	id: `${PEER_SUGGESTION_PREFIX}svc-alice:1`,
	itemIds: ['their-1'],
	title: 'Episode 1',
	serviceId: 'svc-alice',
	serviceName: 'Alice Jellyfin',
	serviceType: MediaServiceType.JELLYFIN,
	peerId: 'peer-alice',
	peerName: 'Alice',
	origin: MediaOrigin.FRIEND,
	seasonNumber: 1,
	episodeNumber: 1,
	size: 1_000,
	quality: null,
	path: null,
	fills: [ref(1)],
	...overrides,
});

const build = (): PeerSuggestionService => new PeerSuggestionService(new QualityService());

const holding = (episodeNumber: number, sources: MediaGroupSource[]): SuggestionHolding => ({
	ref: ref(episodeNumber),
	sources,
});

describe('PeerSuggestionService', () => {
	describe('what it folds into one offer', () => {
		it('offers one holder and one season as a single thing to press', () => {
			const copies = build().copiesFor({
				holdings: [
					holding(1, [source({ itemId: 'their-1' })]),
					holding(2, [source({ itemId: 'their-2' })]),
					holding(3, [source({ itemId: 'their-3' })]),
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies).toHaveLength(1);
			expect(copies[0].itemIds).toEqual(['their-1', 'their-2', 'their-3']);
			expect(copies[0].fills.map((one) => one.episodeNumber)).toEqual([1, 2, 3]);
			// The media's own title, because no one episode's title describes three of them.
			expect(copies[0].title).toBe('Spartacus');
			// And no coordinate below the season, because the row covers several.
			expect(copies[0].episodeNumber).toBeNull();
		});

		it('keeps two holders as two offers, because they are two decisions', () => {
			const copies = build().copiesFor({
				holdings: [
					holding(1, [
						source({ itemId: 'alice-1', serviceId: 'svc-alice' }),
						source({ itemId: 'bob-1', serviceId: 'svc-bob', serviceName: 'Bob Plex', peerId: 'peer-bob' }),
					]),
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies.map((one) => one.serviceId).sort()).toEqual(['svc-alice', 'svc-bob']);
		});

		it('separates two seasons of one holder, because a season is the unit somebody acts on', () => {
			const copies = build().copiesFor({
				holdings: [
					{ ref: ref(1, 1), sources: [source({ itemId: 'their-s1e1' })] },
					{ ref: ref(1, 2), sources: [source({ itemId: 'their-s2e1' })] },
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies.map((one) => one.seasonNumber).sort()).toEqual([1, 2]);
		});

		/**
		 * A copy on a disk this gateway writes into is not a suggestion: it is what we
		 * hold, and a row offering to fetch it would plan a transfer from the machine the
		 * file is already on.
		 */
		it('never offers a copy we hold ourselves', () => {
			const copies = build().copiesFor({
				holdings: [holding(1, [source({ serviceId: 'svc-ours', local: true })])],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies).toEqual([]);
		});

		it('takes one row per gap even where a holder lists the episode twice', () => {
			const copies = build().copiesFor({
				holdings: [
					holding(1, [
						source({ itemId: 'their-1a' }),
						source({ itemId: 'their-1b' }),
					]),
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			// The second copy of one gap would be a second file written for it.
			expect(copies[0].itemIds).toEqual(['their-1a']);
		});
	});

	describe('what an offer says about itself', () => {
		it('carries the prefix that keeps it out of the download client', () => {
			const copies = build().copiesFor({
				holdings: [holding(1, [source()])],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies[0].id.startsWith(PEER_SUGGESTION_PREFIX)).toBe(true);
		});

		it('keeps its identifier across two searches, so a row keeps its place', () => {
			const request = {
				holdings: [holding(1, [source()])],
				title: 'Spartacus',
				friendsOfFriends: new Set<string>(),
			};

			expect(build().copiesFor(request)[0].id).toBe(build().copiesFor(request)[0].id);
		});

		it('says what four episodes cost rather than what one of them does', () => {
			const copies = build().copiesFor({
				holdings: [
					holding(1, [source({ itemId: 'a', quality: summary('1080p', 1_500) })]),
					holding(2, [source({ itemId: 'b', quality: summary('1080p', 2_500) })]),
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies[0].size).toBe(4_000);
		});

		/**
		 * A media server that reports no file size is ordinary, and the summary it did
		 * report knows the bytes anyway. Falling back to it is the difference between an
		 * offer somebody can weigh and one that looks free.
		 */
		it('falls back to what the summary weighed when no size was reported', () => {
			const copies = build().copiesFor({
				holdings: [holding(1, [source({ bytes: null, quality: summary('1080p', 3_300) })])],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies[0].size).toBe(3_300);
		});

		it('says nothing about the size when nothing anywhere reported one', () => {
			const copies = build().copiesFor({
				holdings: [
					holding(1, [source({ itemId: 'a', bytes: null, quality: null })]),
					holding(2, [source({ itemId: 'b', bytes: null, quality: null })]),
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			// Zero would read as an offer that costs nothing.
			expect(copies[0].size).toBeNull();
		});

		it('says mixed when the episodes of one offer disagree', () => {
			const copies = build().copiesFor({
				holdings: [
					holding(1, [source({ itemId: 'a', quality: summary('1080p', 1_000) })]),
					holding(2, [source({ itemId: 'b', quality: summary('720p', 500) })]),
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies[0].quality?.mixed).toBe(true);
			expect(copies[0].quality?.variants).toHaveLength(2);
		});

		/**
		 * An empty summary on a chip reads as a measurement of nothing rather than as an
		 * absence, and a copy nobody has fingerprinted has genuinely not been measured.
		 */
		it('answers no quality at all rather than a summary of nothing', () => {
			const copies = build().copiesFor({
				holdings: [holding(1, [source({ quality: null })])],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies[0].quality).toBeNull();
		});

		it('shows the holder path for one file and none for a folded season', () => {
			const service = build();
			const single = service.copiesFor({
				holdings: [holding(1, [source({ path: '/media/S01E01.mkv' })])],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});
			const folded = service.copiesFor({
				holdings: [
					holding(1, [source({ itemId: 'a', path: '/media/S01E01.mkv' })]),
					holding(2, [source({ itemId: 'b', path: '/media/S01E02.mkv' })]),
				],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(single[0].path).toBe('/media/S01E01.mkv');
			// One of two paths on a row that fetches both would describe neither.
			expect(folded[0].path).toBeNull();
		});

		it('tells a peer a friend introduced from one this household invited', () => {
			const service = build();
			const holdings = [holding(1, [source({ peerId: 'peer-carol' })])];

			expect(
				service.copiesFor({ holdings, title: 'Spartacus', friendsOfFriends: new Set() })[0].origin,
			).toBe(MediaOrigin.FRIEND);
			expect(
				service.copiesFor({
					holdings,
					title: 'Spartacus',
					friendsOfFriends: new Set(['peer-carol']),
				})[0].origin,
			).toBe(MediaOrigin.FRIEND_OF_FRIEND);
		});

		it('calls a remote service of our own direct rather than a friend', () => {
			const copies = build().copiesFor({
				holdings: [holding(1, [source({ peerId: null, peerName: null })])],
				title: 'Spartacus',
				friendsOfFriends: new Set(),
			});

			expect(copies[0].origin).toBe(MediaOrigin.DIRECT);
		});
	});

	describe('the order the two kinds come back in', () => {
		it('puts a copy that exists above a name on a tracker', () => {
			const ordered = orderSuggestions([copy()], [group(), group({ key: 'grp-2' })]);

			expect(ordered.map((one) => one.source)).toEqual([
				SuggestionSource.PEER,
				SuggestionSource.INDEXER,
				SuggestionSource.INDEXER,
			]);
		});

		/**
		 * The rule `orderGroupsByPreference` already applies to a release we hold, said in
		 * the other vocabulary too: an offer with nothing to bring is still listed, because
		 * "you already have this one" is an answer and a shorter list is not.
		 */
		it('sinks anything that brings nothing, whichever kind says so', () => {
			const ordered = orderSuggestions(
				[copy({ id: 'peer:nothing', fills: [] }), copy()],
				[group({ key: 'held', heldAlready: true }), group({ key: 'fresh' })],
			);

			expect(ordered.map((one) => one.key)).toEqual([
				`${PEER_SUGGESTION_PREFIX}svc-alice:1`,
				'fresh',
				'peer:nothing',
				'held',
			]);
		});

		it('leaves the tracker rows in the order the preference already put them', () => {
			const ordered = orderSuggestions(
				[],
				[group({ key: 'first' }), group({ key: 'second' }), group({ key: 'third' })],
			);

			expect(ordered.map((one) => one.key)).toEqual(['first', 'second', 'third']);
		});

		it('offers the nearer holder first, because a direct link spends nobody else', () => {
			const ordered = orderSuggestions(
				[
					copy({ id: 'peer:far', origin: MediaOrigin.FRIEND_OF_FRIEND }),
					copy({ id: 'peer:near', origin: MediaOrigin.DIRECT }),
					copy({ id: 'peer:friend', origin: MediaOrigin.FRIEND }),
				],
				[],
			);

			expect(ordered.map((one) => one.key)).toEqual(['peer:near', 'peer:friend', 'peer:far']);
		});

		it('offers the holder that closes more of the gap first', () => {
			const ordered = orderSuggestions(
				[
					copy({ id: 'peer:one', fills: [ref(1)] }),
					copy({ id: 'peer:three', fills: [ref(1), ref(2), ref(3)] }),
				],
				[],
			);

			expect(ordered.map((one) => one.key)).toEqual(['peer:three', 'peer:one']);
		});

		it('prefers the resolution the gateway measured, and only then the size', () => {
			const ordered = orderSuggestions(
				[
					copy({ id: 'peer:720', quality: summary('720p', 9_000), size: 9_000 }),
					copy({ id: 'peer:1080', quality: summary('1080p', 4_000), size: 4_000 }),
				],
				[],
			);

			// The bloated 720p rip is bigger and is still the wrong answer.
			expect(ordered.map((one) => one.key)).toEqual(['peer:1080', 'peer:720']);
		});

		it('puts a copy whose resolution nothing could read last rather than first', () => {
			const ordered = orderSuggestions(
				[
					copy({ id: 'peer:unknown', quality: null }),
					copy({ id: 'peer:sd', quality: summary('480p', 700) }),
				],
				[],
			);

			expect(ordered.map((one) => one.key)).toEqual(['peer:sd', 'peer:unknown']);
		});
	});
});
