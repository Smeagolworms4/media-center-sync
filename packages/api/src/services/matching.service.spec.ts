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

		it('says local only when nothing was applied', () => {
			expect(service.deriveItemState([])).toBe(SyncState.LOCAL_ONLY);
			expect(
				service.deriveItemState([{ ...base, state: SyncState.IN_SYNC, applied: false }]),
			).toBe(SyncState.LOCAL_ONLY);
		});

		it('puts something to fetch ahead of something to arbitrate', () => {
			expect(
				service.deriveItemState([
					{ ...base, state: SyncState.CONFLICT },
					{ ...base, state: SyncState.MISSING },
				]),
			).toBe(SyncState.MISSING);
		});

		it('puts outdated ahead of conflict', () => {
			expect(
				service.deriveItemState([
					{ ...base, state: SyncState.CONFLICT },
					{ ...base, state: SyncState.OUTDATED },
				]),
			).toBe(SyncState.OUTDATED);
		});

		it('says in sync when everything agrees', () => {
			expect(service.deriveItemState([{ ...base, state: SyncState.IN_SYNC }])).toBe(
				SyncState.IN_SYNC,
			);
		});
	});
});
