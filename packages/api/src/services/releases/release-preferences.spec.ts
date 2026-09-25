import {
	ReleaseKind,
	ReleasePreferenceDimension as Dimension,
	ReleasePreferenceScope,
	type Release,
	type ReleaseGroup,
	type ReleasePreference,
} from '@mcs/shared';
import {
	compareByReleasePreference,
	orderGroupsByPreference,
	releaseCodecOf,
	releaseTeamOf,
	resolveReleasePreference,
	sortByReleasePreference,
} from './release-preferences';

/**
 * An ordering that is wrong still looks like an ordering.
 *
 * That is the reason this suite is long. Nothing here can throw and nothing can report
 * itself: a preference that silently matches nothing — because somebody typed `HEVC` and
 * the name says `x265` — answers a list in exactly the same shape as one that works, and
 * the only symptom is that the setting appears to do nothing. So every fold, every
 * fallback and every level is pinned down by a case that would pass if the rule were
 * simply absent.
 */

const GIGABYTE = 1_000_000_000;

interface Sketch {
	title?: string;
	quality?: string | null;
	source?: string | null;
	languages?: string[];
	seeders?: number | null;
	heldAlready?: boolean;
	flags?: string[];
}

/**
 * A release spelled out rather than parsed from its name.
 *
 * The name parser has its own suite, and going through it here would make every failure
 * in this file ambiguous between a misread name and a misapplied preference — which are
 * repaired in different files. The two facts this module genuinely reads off the name,
 * the codec and the team, are tested against names directly.
 */
function release(sketch: Sketch = {}): Release {
	return {
		id: `id:${sketch.title ?? 'Show.S01E01'}:${String(sketch.seeders ?? 0)}`,
		title: sketch.title ?? 'Show.S01E01.1080p.WEB-DL-GRP',
		indexer: 'tracker',
		size: 2 * GIGABYTE,
		seeders: sketch.seeders === undefined ? 10 : sketch.seeders,
		leechers: 0,
		publishedAt: null,
		magnetUrl: 'magnet:?xt=urn:btih:abc',
		downloadUrl: null,
		kind: ReleaseKind.EPISODE,
		seasonNumber: 1,
		episodeNumber: 1,
		quality: sketch.quality === undefined ? null : sketch.quality,
		source: sketch.source === undefined ? null : sketch.source,
		languages: sketch.languages ?? [],
		coverage: { seasonNumber: 1, episodeNumbers: [1], wholeSeason: false, wholeSeries: false },
		heldAlready: sketch.heldAlready ?? false,
		flags: sketch.flags ?? [],
	};
}

function group(sketch: Sketch = {}): ReleaseGroup {
	const one = release(sketch);

	return {
		key: one.id,
		title: one.title,
		kind: one.kind,
		seasonNumber: one.seasonNumber,
		episodeNumber: one.episodeNumber,
		quality: one.quality,
		source: one.source,
		languages: one.languages,
		size: one.size,
		seeders: one.seeders,
		releases: [one],
		flags: one.flags,
		indexers: [one.indexer],
		coverage: one.coverage,
		fills: [],
		brings: [],
		heldAlready: one.heldAlready,
	};
}

/** A preference written the way the settings screen produces one: ranks, in order. */
function preference(...ranks: [Dimension, string[]][]): ReleasePreference {
	return { ranks: ranks.map(([dimension, values]) => ({ dimension, values })) };
}

const titles = (releases: { title: string }[]): string[] => releases.map((one) => one.title);

describe('releaseTeamOf', () => {
	it('reads the group off the tail of a scene name', () => {
		expect(releaseTeamOf('Show.S01E01.1080p.WEB-DL.x264-NTb')).toBe('NTb');
	});

	it('looks past a tracker signature the name was republished with', () => {
		// The trap `-GROUP[tracker]`: read outright, the tail is `KILLERS[rartv]` and no
		// group is readable, so every release from that tracker would tie in last place.
		expect(releaseTeamOf('Show.S01E01.720p.HDTV.x264-KILLERS[rartv]')).toBe('KILLERS');
	});

	it('looks past two of them', () => {
		expect(releaseTeamOf('Show.S01E01.1080p.WEB-DL-FLUX[eztv][ABCD1234]')).toBe('FLUX');
	});

	it('is not fooled by a dash inside the title', () => {
		expect(releaseTeamOf('Spider-Man.2002.1080p.BluRay.x264-AMIABLE')).toBe('AMIABLE');
	});

	it('answers nothing rather than the tail of a source tag', () => {
		// `DL` is the expensive wrong answer: it is not a group, it is carried by every
		// WEB-DL ever released, and once listed it would outrank real groups everywhere.
		expect(releaseTeamOf('Spider-Man.No.Way.Home.2021.1080p.WEB-DL')).toBeNull();
	});

	it('answers nothing when the tail is several words', () => {
		expect(releaseTeamOf('Le.Nom-Du.Film.2019.1080p')).toBeNull();
	});

	it('answers nothing for a name with no dash at all', () => {
		expect(releaseTeamOf('Show S01E01 1080p WEB H264')).toBeNull();
	});

	it('reads the bracket when the name ends on its dash', () => {
		expect(releaseTeamOf('Movie.2019.1080p.BluRay.x264-[YTS.AM]')).toBe('YTS');
	});

	it('ignores a file extension', () => {
		expect(releaseTeamOf('Show.S01E01.1080p.WEB-DL-FLUX.mkv')).toBe('FLUX');
	});
});

describe('releaseCodecOf', () => {
	it('folds every spelling of one codec family to one value', () => {
		for (const title of ['Show.x265-A', 'Show.HEVC-A', 'Show.H.265-A', 'Show.h265-A']) {
			expect(releaseCodecOf(title)).toBe('x265');
		}
	});

	it('does not read a codec out of an audio tag', () => {
		// `DDP5.1` and `AAC2.0` carry numbers a looser pattern reads as 264 or 265.
		expect(releaseCodecOf('Show.S01E01.1080p.WEB-DL.DDP5.1-NTb')).toBeNull();
	});

	it('reads H.264 as x264', () => {
		expect(releaseCodecOf('Show.S01E01.1080p.WEB.H.264-FW')).toBe('x264');
	});
});

describe('compareByReleasePreference', () => {
	it('puts a preferred resolution above a better-seeded release', () => {
		// The whole feature in one case: the list arrives seeder-ordered, and the copy the
		// household actually wants is the second line.
		const seeded = release({ title: 'Show.2160p', quality: '2160p', seeders: 500 });
		const wanted = release({ title: 'Show.1080p', quality: '1080p', seeders: 10 });

		const sorted = sortByReleasePreference(
			[seeded, wanted],
			preference([Dimension.RESOLUTION, ['1080p', '2160p', '720p', 'SD']]),
		);

		expect(titles(sorted)).toEqual(['Show.1080p', 'Show.2160p']);
	});

	it('lets the dimension order decide between 1080p x264 and 720p x265', () => {
		const big = release({ title: 'Show.1080p.x264-A', quality: '1080p' });
		const small = release({ title: 'Show.720p.x265-B', quality: '720p' });
		const ranks: [Dimension, string[]][] = [
			[Dimension.RESOLUTION, ['1080p', '720p']],
			[Dimension.CODEC, ['x265', 'x264']],
		];

		expect(titles(sortByReleasePreference([small, big], preference(...ranks))))
			.toEqual(['Show.1080p.x264-A', 'Show.720p.x265-B']);

		// The same two opinions, the other way round. Nothing about either list changed:
		// the order *between* the dimensions is the answer, and it is the part that could
		// not be expressed by two lists on their own.
		expect(titles(sortByReleasePreference([big, small], preference(...ranks.reverse()))))
			.toEqual(['Show.720p.x265-B', 'Show.1080p.x264-A']);
	});

	it('ranks a value nobody listed last', () => {
		const listed = release({ title: 'Show.720p', quality: '720p', seeders: 1 });
		const unlisted = release({ title: 'Show.480p', quality: '480p', seeders: 900 });

		const sorted = sortByReleasePreference(
			[unlisted, listed],
			preference([Dimension.RESOLUTION, ['1080p', '720p']]),
		);

		expect(titles(sorted)).toEqual(['Show.720p', 'Show.480p']);
	});

	it('ties two values nobody listed, leaving the order they arrived in', () => {
		// Unlisted values share one place rather than being spread behind the listed ones:
		// a preference says what is wanted and says nothing about the rest, so the seeder
		// order the list arrived with has to survive.
		const first = release({ title: 'Show.720p.first', quality: '720p', seeders: 80 });
		const second = release({ title: 'Show.480p.second', quality: '480p', seeders: 20 });

		const sorted = sortByReleasePreference(
			[first, second],
			preference([Dimension.RESOLUTION, ['1080p']]),
		);

		expect(titles(sorted)).toEqual(['Show.720p.first', 'Show.480p.second']);
	});

	it('leaves the list exactly as it arrived when nothing is preferred', () => {
		const arrived = [
			release({ title: 'Show.2160p', quality: '2160p', seeders: 500 }),
			release({ title: 'Show.1080p', quality: '1080p', seeders: 10 }),
			release({ title: 'Show.720p', quality: '720p', seeders: 3 }),
		];

		expect(titles(sortByReleasePreference(arrived, { ranks: [] }))).toEqual(titles(arrived));
	});

	it('separates nothing on a rank somebody emptied, and falls to the next', () => {
		// An empty rank is a dimension deliberately silenced — a category with no opinion
		// about resolution — and must not put every release in last place together.
		const sorted = sortByReleasePreference(
			[
				release({ title: 'Show.1080p.x264', quality: '1080p' }),
				release({ title: 'Show.2160p.x265', quality: '2160p' }),
			],
			preference([Dimension.RESOLUTION, []], [Dimension.CODEC, ['x265', 'x264']]),
		);

		expect(titles(sorted)).toEqual(['Show.2160p.x265', 'Show.1080p.x264']);
	});

	it('orders on the team, read out of the names', () => {
		const sorted = sortByReleasePreference(
			[
				release({ title: 'Show.S01E01.1080p.WEB-DL.x264-RANDOM', seeders: 400 }),
				release({ title: 'Show.S01E01.1080p.WEB-DL.x264-FLUX[eztv]', seeders: 5 }),
				release({ title: 'Show.S01E01.1080p.WEB-DL.x264-NTb', seeders: 50 }),
			],
			preference([Dimension.TEAM, ['NTb', 'FLUX']]),
		);

		expect(titles(sorted)).toEqual([
			'Show.S01E01.1080p.WEB-DL.x264-NTb',
			'Show.S01E01.1080p.WEB-DL.x264-FLUX[eztv]',
			'Show.S01E01.1080p.WEB-DL.x264-RANDOM',
		]);
	});

	it('matches a value typed the way a tracker prints it', () => {
		// `HEVC` typed against `x265` parsed, and `web dl` typed against `WEB-DL`. Without
		// the folding both settings match nothing and the screen still answers a list, in
		// the order it would have had anyway — a setting that appears to do nothing.
		const hevc = release({ title: 'Show.1080p.HEVC-B' });
		const avc = release({ title: 'Show.1080p.x264-A' });
		const byCodec = compareByReleasePreference(preference([Dimension.CODEC, ['hevc']]));

		expect(byCodec(hevc, avc)).toBeLessThan(0);

		const webdl = release({ title: 'Show.1080p.WEB-DL-B', source: 'WEB-DL' });
		const webrip = release({ title: 'Show.1080p.WEBRip-A', source: 'WEBRip' });
		const bySource = compareByReleasePreference(preference([Dimension.SOURCE, ['web dl']]));

		expect(bySource(webdl, webrip)).toBeLessThan(0);
	});

	it('ranks a multi-language release on its best tag', () => {
		const sorted = sortByReleasePreference(
			[
				release({ title: 'Show.VOSTFR', languages: ['VOSTFR'] }),
				release({ title: 'Show.MULTI.VOSTFR', languages: ['MULTI', 'VOSTFR'] }),
			],
			preference([Dimension.LANGUAGE, ['MULTI', 'VOSTFR']]),
		);

		expect(titles(sorted)).toEqual(['Show.MULTI.VOSTFR', 'Show.VOSTFR']);
	});

	it('reads the resolution off the name when the release carries none', () => {
		const sorted = sortByReleasePreference(
			[release({ title: 'Show.720p.WEB' }), release({ title: 'Show.1080p.WEB' })],
			preference([Dimension.RESOLUTION, ['1080p', '720p']]),
		);

		expect(titles(sorted)).toEqual(['Show.1080p.WEB', 'Show.720p.WEB']);
	});

	it('folds three numbers into the one answer somebody gave', () => {
		// Nobody writes `576p, 480p, 360p`; they write `SD` and mean all of it.
		const order = compareByReleasePreference(preference([Dimension.RESOLUTION, ['720p', 'SD']]));

		expect(order(release({ quality: '480p' }), release({ quality: '720p' }))).toBeGreaterThan(0);
		expect(order(release({ quality: '576p' }), release({ quality: '480p' }))).toBe(0);
	});
});

describe('resolveReleasePreference', () => {
	const global = preference([Dimension.RESOLUTION, ['2160p']]);
	const category = preference([Dimension.RESOLUTION, ['1080p']]);
	const media = preference([Dimension.RESOLUTION, ['720p']]);

	it('takes the media preference over both the others', () => {
		const resolved = resolveReleasePreference({ global, category, media });

		expect(resolved.scope).toBe(ReleasePreferenceScope.MEDIA);
		expect(resolved.preference).toBe(media);
	});

	it('takes the category preference when the media has none', () => {
		const resolved = resolveReleasePreference({ global, category, media: null });

		expect(resolved.scope).toBe(ReleasePreferenceScope.CATEGORY);
		expect(resolved.preference).toBe(category);
	});

	it('falls back to the household preference', () => {
		const resolved = resolveReleasePreference({ global });

		expect(resolved.scope).toBe(ReleasePreferenceScope.GLOBAL);
		expect(resolved.preference).toBe(global);
	});

	it('answers an order that separates nothing when no level said anything', () => {
		const resolved = resolveReleasePreference({});

		expect(resolved.scope).toBe(ReleasePreferenceScope.NONE);
		expect(resolved.preference.ranks).toEqual([]);
	});

	it('lets one media opt out of an order that is wrong for it', () => {
		// Presence and not emptiness decides the level, which is what makes this sayable:
		// an override with no values is "order this one by nothing", and it is a different
		// sentence from `null`. Resolving on emptiness would make the two the same and the
		// only way to opt out would be to retype every value in the order it arrives in.
		const resolved = resolveReleasePreference({ global, media: { ranks: [] } });

		expect(resolved.scope).toBe(ReleasePreferenceScope.MEDIA);
		expect(titles(sortByReleasePreference(
			[release({ title: 'Show.1080p', quality: '1080p' }), release({ title: 'Show.2160p', quality: '2160p' })],
			resolved.preference,
		))).toEqual(['Show.1080p', 'Show.2160p']);
	});

	it('does not merge the levels', () => {
		// A media order that inherited the dimensions it did not mention would answer
		// differently depending on a setting on another screen, and "cancel the specific
		// preference on this series" would stop being describable.
		const resolved = resolveReleasePreference({
			global: preference([Dimension.CODEC, ['x265']]),
			media: preference([Dimension.RESOLUTION, ['720p']]),
		});

		expect(resolved.preference.ranks).toHaveLength(1);
		expect(resolved.preference.ranks[0].dimension).toBe(Dimension.RESOLUTION);
	});
});

describe('orderGroupsByPreference', () => {
	it('reorders the folded groups', () => {
		const sorted = orderGroupsByPreference(
			[
				group({ title: 'Show.2160p', quality: '2160p', seeders: 500 }),
				group({ title: 'Show.1080p', quality: '1080p', seeders: 10 }),
			],
			preference([Dimension.RESOLUTION, ['1080p', '2160p']]),
		);

		expect(titles(sorted)).toEqual(['Show.1080p', 'Show.2160p']);
	});

	it('keeps a copy already on the disk last, however preferred it is', () => {
		// A file this gateway already holds is not a better copy for being 1080p, and
		// lifting it over something that would bring a missing episode is the one way an
		// ordering could make the list worse than the one it replaced.
		const sorted = orderGroupsByPreference(
			[
				group({ title: 'Show.1080p.held', quality: '1080p', heldAlready: true }),
				group({ title: 'Show.2160p', quality: '2160p' }),
			],
			preference([Dimension.RESOLUTION, ['1080p', '2160p']]),
		);

		expect(titles(sorted)).toEqual(['Show.2160p', 'Show.1080p.held']);
	});
});
