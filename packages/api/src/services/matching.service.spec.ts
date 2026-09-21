import { MatchStrategy, MediaKind, SyncState, type MediaFileInfo } from '@mcs/shared';
import { MatchingService, type MatchCandidate, type MatchOptions } from './matching.service';
import { QualityService } from './quality.service';

function file(overrides: Partial<MediaFileInfo> = {}): MediaFileInfo {
	return {
		path: '/media/Shows/The Expanse/The.Expanse.S01E02.1080p.x265.mkv',
		size: 2_000_000_000,
		container: 'mkv',
		videoCodec: 'x265',
		audioCodec: 'eac3',
		width: 1920,
		height: 1080,
		durationMs: 2_700_000,
		bitrate: 6_000_000,
		quickHash: null,
		contentId: null,
		checksum: null,
		...overrides,
	};
}

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
	return {
		id: 'local-1',
		serviceId: 'service-local',
		peerId: null,
		parentId: 'season-local',
		kind: MediaKind.EPISODE,
		title: 'Back to the Butcher',
		normalizedTitle: 'back to the butcher',
		year: 2015,
		seasonNumber: 1,
		episodeNumber: 2,
		externalIds: { tvdb: '5312341' },
		file: file(),
		...overrides,
	};
}

function options(overrides: Partial<MatchOptions> = {}): MatchOptions {
	return { threshold: 0.8, ...overrides };
}

describe('MatchingService', () => {
	const service = new MatchingService(new QualityService());

	describe('strategies', () => {
		it('never matches two different kinds', () => {
			const local = candidate({ kind: MediaKind.EPISODE });
			const remote = candidate({ id: 'r', serviceId: 's2', kind: MediaKind.SEASON });

			expect(service.score(local, remote, options())).toBeNull();
		});

		it('takes a matching checksum as proof', () => {
			const local = candidate({ file: file({ checksum: 'deadbeef' }) });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				normalizedTitle: 'something else entirely',
				externalIds: {},
				seasonNumber: 9,
				episodeNumber: 9,
				file: file({ checksum: 'deadbeef' }),
			});

			expect(service.score(local, remote, options())).toEqual({
				strategy: MatchStrategy.CHECKSUM,
				confidence: 1,
			});
		});

		it('accepts a matching content identifier as the cheap equivalent', () => {
			const local = candidate({ file: file({ contentId: 'q1-aaa' }) });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				externalIds: {},
				normalizedTitle: 'nothing alike',
				seasonNumber: 4,
				episodeNumber: 4,
				file: file({ contentId: 'q1-aaa' }),
			});

			expect(service.score(local, remote, options())?.strategy).toBe(MatchStrategy.CHECKSUM);
		});

		it('matches on a provider identifier', () => {
			const local = candidate({ kind: MediaKind.MOVIE, seasonNumber: null, episodeNumber: null });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				kind: MediaKind.MOVIE,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'completely different title',
				externalIds: { tvdb: '5312341' },
			});

			expect(service.score(local, remote, options())).toEqual({
				strategy: MatchStrategy.EXTERNAL_ID,
				confidence: 0.98,
			});
		});

		it('refuses a provider identifier shared by two different episodes', () => {
			// Episodes routinely inherit their series' identifier, which would otherwise
			// match every episode of a show with every other.
			const local = candidate();
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				episodeNumber: 7,
				normalizedTitle: 'another episode',
				file: null,
			});

			expect(service.score(local, remote, options())).toBeNull();
		});

		it('lowers its confidence when the episode numbers are unknown', () => {
			const local = candidate({ seasonNumber: null, episodeNumber: null });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'unrelated',
			});

			expect(service.score(local, remote, options())?.confidence).toBe(0.9);
		});

		it('matches season and episode under a parent that is already matched', () => {
			const local = candidate({ externalIds: {} });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				parentId: 'season-remote',
				externalIds: {},
				normalizedTitle: 'butcher, back to the',
				file: null,
			});

			const matched = service.score(
				local,
				remote,
				options({ parentMatches: new Map([['season-local', new Set(['season-remote'])]]) }),
			);

			expect(matched).toEqual({
				strategy: MatchStrategy.SEASON_EPISODE,
				confidence: 0.95,
			});
		});

		it('refuses season and episode when no parent has been matched', () => {
			// Every library on earth has an `S01E02`; without a matched series the
			// numbers mean nothing at all.
			const local = candidate({ externalIds: {}, normalizedTitle: 'a', file: null });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				parentId: 'season-remote',
				externalIds: {},
				normalizedTitle: 'b',
				file: null,
			});

			expect(service.score(local, remote, options())).toBeNull();
		});

		it('matches films on a normalised title and rewards an agreeing year', () => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				normalizedTitle: 'blade runner',
				year: 1982,
				externalIds: {},
				seasonNumber: null,
				episodeNumber: null,
				file: null,
			});
			const remote = { ...local, id: 'r', serviceId: 's2' };

			const scored = service.score(local, remote, options());

			expect(scored?.strategy).toBe(MatchStrategy.NORMALIZED_TITLE);
			expect(scored?.confidence).toBe(0.95);
		});

		it('punishes a title that matches a remake years apart', () => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				normalizedTitle: 'blade runner',
				year: 1982,
				externalIds: {},
				seasonNumber: null,
				episodeNumber: null,
				file: null,
			});
			const remote = { ...local, id: 'r', serviceId: 's2', year: 2017 };

			expect(service.score(local, remote, options())?.confidence).toBeLessThan(0.6);
		});

		it('forgives a one-year disagreement between two metadata agents', () => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				normalizedTitle: 'parasite',
				year: 2019,
				externalIds: {},
				seasonNumber: null,
				episodeNumber: null,
				file: null,
			});
			const remote = { ...local, id: 'r', serviceId: 's2', year: 2020 };

			const scored = service.score(local, remote, options());

			expect(scored?.confidence).toBeGreaterThan(0.8);
			expect(scored?.confidence).toBeLessThan(0.95);
		});

		it('refuses to match two different films that share a title', () => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				normalizedTitle: 'the office',
				externalIds: {},
				year: null,
				seasonNumber: null,
				episodeNumber: null,
				file: null,
			});
			const remote = { ...local, id: 'r', serviceId: 's2', normalizedTitle: 'the wire' };

			expect(service.score(local, remote, options())).toBeNull();
		});

		it('falls back to an identical path', () => {
			const local = candidate({ externalIds: {}, normalizedTitle: 'a', episodeNumber: 2 });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				externalIds: {},
				normalizedTitle: 'b',
				episodeNumber: 3,
				seasonNumber: 1,
			});

			expect(service.score(local, remote, options())).toEqual({
				strategy: MatchStrategy.PATH,
				confidence: 0.85,
			});
		});

		it('refuses a short, meaningless basename', () => {
			const local = candidate({
				externalIds: {},
				normalizedTitle: 'a',
				file: file({ path: '/a/movie.mkv' }),
			});
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				externalIds: {},
				normalizedTitle: 'b',
				episodeNumber: 5,
				file: file({ path: '/b/movie.mkv' }),
			});

			expect(service.score(local, remote, options())).toBeNull();
		});
	});

	/**
	 * The identifier decides the work; the running time decides the version.
	 *
	 * Everything in the first table shares an IMDb number, a title and a year, because
	 * that is the real case: a theatrical cut and an extended one are the same work to
	 * every scraper on earth. They are one group — the owner's rule, and the only way a
	 * `conflict` can ever be shown for a film — and the running time only decides which
	 * state that group is in. Getting that threshold wrong still costs something in both
	 * directions: too tight and every re-encode reads as a decision somebody has to
	 * make, too loose and a sync replaces the theatrical cut with the extended one as if
	 * it were a better copy of the same thing.
	 */
	describe('versions of one film', () => {
		const theatrical = 194 * 60 * 1000;

		// The remote copy is a 2160p encode against our 1080p one, on purpose: as a copy of
		// the same cut it is better and reads `outdated`; as another cut it is not better
		// or worse at all, and must read `conflict` however much sharper it is.
		const cases: { name: string; durationMs: number; state: SyncState }[] = [
			{ name: 'the same encode twice', durationMs: theatrical, state: SyncState.OUTDATED },
			{
				name: 'a re-encode a few seconds shorter',
				durationMs: theatrical - 8_000,
				state: SyncState.OUTDATED,
			},
			{
				name: 'a copy with a studio logo trimmed off the front',
				durationMs: theatrical - 25_000,
				state: SyncState.OUTDATED,
			},
			{
				name: 'a copy just inside two minutes',
				durationMs: theatrical - 119_000,
				state: SyncState.OUTDATED,
			},
			{
				name: 'a copy just outside two minutes',
				durationMs: theatrical - 121_000,
				state: SyncState.CONFLICT,
			},
			{
				name: 'an extended cut',
				durationMs: theatrical + 15 * 60 * 1000,
				state: SyncState.CONFLICT,
			},
		];

		it.each(cases)('$name: correlates and reads $state', ({ durationMs, state }) => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: 'Titanic',
				normalizedTitle: 'titanic',
				year: 1997,
				externalIds: { imdb: 'tt0120338' },
				file: file({ path: '/media/Films/Titanic (1997).mkv', durationMs: theatrical }),
			});
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				// A different encode of whichever cut this row is: another codec, another
				// resolution, another size. None of it is evidence about the content, and
				// none of it may decide the question.
				file: file({
					path: '/srv/movies/Titanic (1997) 2160p.mkv',
					durationMs,
					videoCodec: 'x264',
					width: 3840,
					height: 2160,
					size: 20_000_000_000,
				}),
			});

			expect(service.score(local, remote, options())?.strategy).toBe(MatchStrategy.EXTERNAL_ID);
			expect(service.correlate(local, [remote], options())).toEqual([
				expect.objectContaining({ remoteItemId: 'remote-1', applied: true, state }),
			]);
		});

		it('says which cut is which, in the reason a person arbitrates from', () => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				externalIds: { imdb: 'tt0120338' },
				file: file({ durationMs: theatrical }),
			});
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				file: file({ durationMs: theatrical + 15 * 60 * 1000 }),
			});

			expect(service.correlate(local, [remote], options())[0].reason).toBe(
				'different cut (209 min there against 194 min here)',
			);
		});

		it.each([
			['a TMDB number', { tmdb: '597' }],
			['a TVDB number', { tvdb: '232' }],
		])('treats %s as proof of the work too', (_name, externalIds) => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'titanic',
				externalIds,
				file: file({ durationMs: theatrical }),
			});
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				// A French library's title for it: the identifier needs no help from the
				// string, and the running time is not allowed to argue.
				normalizedTitle: 'titanic version longue',
				file: file({ durationMs: theatrical + 15 * 60 * 1000 }),
			});

			expect(service.score(local, remote, options())?.strategy).toBe(MatchStrategy.EXTERNAL_ID);
			expect(service.deriveState(local, remote)).toBe(SyncState.CONFLICT);
		});

		/**
		 * The trap the owner's own database set: a Plex copy carrying
		 * `externalIds: { provider: "5" }`.
		 *
		 * That is Plex's row key, and the fifth row of every other Plex server is some
		 * other film. If it counted as an identity, two unrelated films that happen to sit
		 * at the same row on two servers would merge whatever their lengths — the one
		 * thing a work identifier is now trusted to do.
		 */
		describe('a server-local key', () => {
			const rowFive = (overrides: Partial<MatchCandidate>): MatchCandidate =>
				candidate({
					kind: MediaKind.MOVIE,
					parentId: null,
					seasonNumber: null,
					episodeNumber: null,
					year: 2010,
					externalIds: { provider: '5' },
					...overrides,
				});

			it('never correlates two films on their own', () => {
				const plex = rowFive({
					normalizedTitle: 'inception',
					file: file({ path: '/media/Films/Inception (2010).mkv', durationMs: 8_880_000 }),
				});
				const otherPlex = rowFive({
					id: 'remote-1',
					serviceId: 'service-remote',
					normalizedTitle: 'the social network',
					file: file({
						path: '/media/Films/The Social Network (2010).mkv',
						durationMs: 8_880_000,
					}),
				});

				expect(service.score(plex, otherPlex, options())).toBeNull();
			});

			it('does not lift the running-time veto from two namesakes', () => {
				const plex = rowFive({ normalizedTitle: 'the thing', file: file({ durationMs: 6_540_000 }) });
				const otherPlex = rowFive({
					id: 'remote-1',
					serviceId: 'service-remote',
					file: file({ durationMs: 6_180_000 }),
				});

				expect(service.score(plex, otherPlex, options())).toBeNull();
			});
		});

		it('does not take a placeholder zero for an identity', () => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'first film',
				externalIds: { tmdb: '0', imdb: 'tt0000000' },
				file: file({ path: '/media/Films/First Film.mkv' }),
			});
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				normalizedTitle: 'second film',
				file: file({ path: '/media/Films/Second Film.mkv' }),
			});

			expect(service.score(local, remote, options())).toBeNull();
		});

		it('lets a MusicBrainz number correlate but not overrule the running time', () => {
			// The Jellyfin handler files an artist's identifier here when a video has no
			// track of its own, so two recordings by one artist can share it.
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'live at wembley',
				externalIds: { musicbrainz: 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d' },
				file: file({ durationMs: 5_400_000 }),
			});
			const sameLength = candidate({ ...local, id: 'remote-1', serviceId: 'service-remote' });
			const otherConcert = candidate({
				...sameLength,
				id: 'remote-2',
				file: file({ durationMs: 3_600_000 }),
			});

			expect(service.score(local, sameLength, options())?.strategy).toBe(
				MatchStrategy.EXTERNAL_ID,
			);
			expect(service.score(local, otherConcert, options())).toBeNull();
		});

		it('keeps two cuts apart when nothing but the title is left to go on', () => {
			// Where no identifier vouches for the pair, the running time is the only
			// evidence against a false merge: two films sharing a title and a year and
			// running forty minutes apart may be a remake, a namesake, or a documentary
			// about the other. A title match would put together what nothing proves is one.
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'titanic',
				year: 1997,
				externalIds: {},
				file: file({ durationMs: theatrical }),
			});
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				file: file({ durationMs: theatrical + 15 * 60 * 1000 }),
			});

			expect(service.score(local, remote, options())).toBeNull();
		});

		it('merges two cuts of an episode, because there the numbers are the identity', () => {
			// A recap, a double-length finale and a series whose specials run long are all
			// ordinary, and splitting on duration would ungroup shows that correlate
			// perfectly today. The season and episode numbers already say what this is.
			const local = candidate({ file: file({ durationMs: 2_700_000 }) });
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				file: file({ durationMs: 5_400_000 }),
			});

			expect(service.score(local, remote, options())?.strategy).toBe(MatchStrategy.EXTERNAL_ID);
		});

		it('merges two copies of one file whatever their clocks say', () => {
			// Proof beats inference: the fingerprint is the version, so a service that
			// reports a wrong duration — and they do — cannot split a file from itself.
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				file: file({ contentId: 'q1-same', durationMs: theatrical }),
			});
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				file: file({ contentId: 'q1-same', durationMs: theatrical + 20 * 60 * 1000 }),
			});

			expect(service.score(local, remote, options())?.strategy).toBe(MatchStrategy.CHECKSUM);
		});

		/**
		 * The owner's two copies of *Big Buck Bunny*, which showed as two cards.
		 *
		 * Both live on a friend's server — one Plex, one Jellyfin — and both are short
		 * stubs: 3.0 s against 4.0 s. Nothing about the pair had anything to do with
		 * correlation being anchored on a copy we hold, which was the first guess and is
		 * wrong; the gateway relates two foreign copies to each other and always has.
		 * What split them was this veto, reading a one-second difference as a different
		 * cut because on a four-second runtime that is twenty-four percent.
		 */
		it('correlates two short copies of one film on two foreign servers', () => {
			const plex = candidate({
				id: 'plex-copy',
				serviceId: 'service-plex-friend',
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: 'Big Buck Bunny',
				normalizedTitle: 'big buck bunny',
				year: 2008,
				// Plex reports its own row key under `provider`, which is not a scraper
				// identifier and agrees with nothing. The title is genuinely all there is.
				externalIds: {},
				file: file({
					path: '/media/movies/Big.Buck.Bunny.2008.2160p.BluRay.x265-LAB.mp4',
					durationMs: 3_023,
					videoCodec: 'hevc',
					width: 3840,
					height: 2160,
					size: 92_752,
				}),
			});
			const jellyfin = candidate({
				...plex,
				id: 'jellyfin-copy',
				serviceId: 'service-jellyfin-friend',
				file: file({
					path: '/media/movies/Big Buck Bunny (2008)/Big Buck Bunny (2008) - 1080p.mp4',
					durationMs: 4_000,
					videoCodec: 'h264',
					width: 1920,
					height: 1080,
					size: 162_173,
				}),
			});

			const scored = service.score(jellyfin, plex, options());

			expect(scored?.strategy).toBe(MatchStrategy.NORMALIZED_TITLE);
			expect(scored?.confidence).toBe(0.95);
			expect(service.correlate(jellyfin, [plex], options())).toEqual([
				expect.objectContaining({
					localItemId: 'jellyfin-copy',
					remoteItemId: 'plex-copy',
					remoteServiceId: 'service-plex-friend',
					applied: true,
				}),
			]);
		});

		it('still reads two short films a minute apart as two cuts', () => {
			// The floor is half a minute, not "anything brief is the same version". Four
			// minutes against five is a cut: grouped when an identifier vouches for the
			// work, kept apart when only the title does.
			const local = candidate({
				kind: MediaKind.MOVIE,
				parentId: null,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'windmills',
				year: 2015,
				externalIds: { imdb: 'tt3230854' },
				file: file({ durationMs: 300_000 }),
			});
			const remote = candidate({
				...local,
				id: 'remote-1',
				serviceId: 'service-remote',
				file: file({ durationMs: 240_000 }),
			});

			expect(service.correlate(local, [remote], options())[0].state).toBe(SyncState.CONFLICT);
			expect(
				service.score(
					{ ...local, externalIds: {} },
					{ ...remote, externalIds: {} },
					options(),
				),
			).toBeNull();
		});
	});

	describe('threshold', () => {
		it('applies a match above the threshold', () => {
			const local = candidate();
			const remote = candidate({ id: 'r', serviceId: 's2' });

			expect(service.correlate(local, [remote], options({ threshold: 0.9 }))[0].applied).toBe(true);
		});

		it('proposes rather than applies a match below the threshold', () => {
			const local = candidate({
				kind: MediaKind.MOVIE,
				externalIds: {},
				year: null,
				seasonNumber: null,
				episodeNumber: null,
				normalizedTitle: 'the expanse',
				file: null,
			});
			const remote = {
				...local,
				id: 'r',
				serviceId: 's2',
				normalizedTitle: 'the expanse chronicles',
			};

			const [proposal] = service.correlate(local, [remote], options({ threshold: 0.99 }));

			expect(proposal.applied).toBe(false);
			expect(proposal.confidence).toBeGreaterThan(0);
		});
	});

	describe('correlate', () => {
		it('keeps the best candidate per remote service', () => {
			const local = candidate();
			const good = candidate({ id: 'good', serviceId: 's2' });
			const weaker = candidate({
				id: 'weak',
				serviceId: 's2',
				externalIds: {},
				normalizedTitle: 'back to butcher',
			});

			const proposals = service.correlate(local, [weaker, good], options());

			expect(proposals).toHaveLength(1);
			expect(proposals[0].remoteItemId).toBe('good');
		});

		it('ignores candidates on our own service', () => {
			const local = candidate();
			const sibling = candidate({ id: 'other', serviceId: 'service-local' });

			expect(service.correlate(local, [sibling], options())).toHaveLength(0);
		});

		it('carries the peer through so the interface can say where it came from', () => {
			const local = candidate();
			const remote = candidate({ id: 'r', serviceId: 's2', peerId: 'peer-7' });

			expect(service.correlate(local, [remote], options())[0].remotePeerId).toBe('peer-7');
		});
	});

	describe('deriveState', () => {
		it('says missing when we hold nothing', () => {
			expect(service.deriveState(null, candidate())).toBe(SyncState.MISSING);
		});

		it('says outdated when the remote copy is better', () => {
			const local = candidate({ file: file({ height: 1080 }) });
			const remote = candidate({ id: 'r', serviceId: 's2', file: file({ height: 2160 }) });

			expect(service.deriveState(local, remote)).toBe(SyncState.OUTDATED);
		});

		it('says in sync when they are the same', () => {
			expect(service.deriveState(candidate(), candidate({ id: 'r', serviceId: 's2' }))).toBe(
				SyncState.IN_SYNC,
			);
		});

		it('says in sync when the remote copy is worse', () => {
			const local = candidate({ file: file({ height: 2160 }) });
			const remote = candidate({ id: 'r', serviceId: 's2', file: file({ height: 1080 }) });

			expect(service.deriveState(local, remote)).toBe(SyncState.IN_SYNC);
		});

		it('says conflict for two cuts even when the remote one is the better encode', () => {
			// Ranked on quality first, this pair read `outdated`, and a sync allowed to
			// replace outdated copies would have written the extended cut over ours.
			const local = candidate({ file: file({ durationMs: 7_200_000, height: 1080 }) });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				file: file({ durationMs: 9_000_000, height: 2160 }),
			});

			expect(service.deriveState(local, remote)).toBe(SyncState.CONFLICT);
		});

		it('says conflict for two cuts of different lengths at the same quality', () => {
			const local = candidate({ file: file({ durationMs: 7_200_000 }) });
			const remote = candidate({
				id: 'r',
				serviceId: 's2',
				file: file({ durationMs: 9_000_000 }),
			});

			expect(service.deriveState(local, remote)).toBe(SyncState.CONFLICT);
		});

		it('says missing when we have the node but not the file', () => {
			const local = candidate({ file: null });
			const remote = candidate({ id: 'r', serviceId: 's2' });

			expect(service.deriveState(local, remote)).toBe(SyncState.MISSING);
		});

		it('says in sync for two nodes that hold no file at all', () => {
			const local = candidate({ kind: MediaKind.SERIES, file: null });
			const remote = candidate({ id: 'r', serviceId: 's2', kind: MediaKind.SERIES, file: null });

			expect(service.deriveState(local, remote)).toBe(SyncState.IN_SYNC);
		});

		it('writes a reason only when the remote copy wins', () => {
			const local = candidate({ file: file({ height: 1080 }) });
			const remote = candidate({ id: 'r', serviceId: 's2', file: file({ height: 2160 }) });

			const [proposal] = service.correlate(local, [remote], options());

			expect(proposal.state).toBe(SyncState.OUTDATED);
			expect(proposal.reason).toContain('resolution');
			expect(service.correlate(remote, [local], options())[0].reason).toBeNull();
		});
	});

	describe('deriveItemState', () => {
		const base = {
			localItemId: 'local-1',
			remoteItemId: 'r',
			remoteServiceId: 's2',
			remotePeerId: null,
			strategy: MatchStrategy.EXTERNAL_ID,
			confidence: 1,
			reason: null,
			applied: true,
		};

		it('says local only when nothing was applied and we hold it', () => {
			expect(service.deriveItemState([], true)).toBe(SyncState.LOCAL_ONLY);
			expect(
				service.deriveItemState([{ ...base, state: SyncState.IN_SYNC, applied: false }], true),
			).toBe(SyncState.LOCAL_ONLY);
		});

		it('says missing for the same item on somebody else\'s server', () => {
			// The same empty list means opposite things on the two sides, and deriving
			// both from it made every remote item the gateway could fetch look like
			// something it already held.
			expect(service.deriveItemState([], false)).toBe(SyncState.MISSING);
		});

		it('puts something to fetch ahead of something to arbitrate', () => {
			expect(
				service.deriveItemState([
					{ ...base, state: SyncState.CONFLICT },
					{ ...base, state: SyncState.MISSING },
				], true),
			).toBe(SyncState.MISSING);
		});

		it('puts outdated ahead of conflict', () => {
			expect(
				service.deriveItemState([
					{ ...base, state: SyncState.CONFLICT },
					{ ...base, state: SyncState.OUTDATED },
				], true),
			).toBe(SyncState.OUTDATED);
		});

		it('says in sync when everything agrees', () => {
			expect(service.deriveItemState([{ ...base, state: SyncState.IN_SYNC }], true)).toBe(
				SyncState.IN_SYNC,
			);
		});
	});
});
