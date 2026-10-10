import { namesMedia } from './release-match';

/**
 * The owner's own search, which is where this came from.
 *
 * Season four of **From** — one of the commonest words in English — answered with four
 * season-four packs of four other shows, under a heading promising "what fills the gaps
 * you have". Every one of them agreed with the coordinate; none of them was the show.
 */
const REPORTED = [
	['FROM.S04E06.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-ACKER', true],
	['From.S04.MULTi.1080p.WEB.EAC3.5.1.H265-TyHD', true],
	['From.S04E08.MULTi.1080p.WEB.H265-TyHD', true],
	['Bridgerton.2020.S04.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-TFA', false],
	['Snowpiercer.S04.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-CHiLL', false],
	['Dexter.S04.MULTI.VFF.1080p.WEB.DDP.5.1.H265-TyHD', false],
	['Yellowstone.2018.S04.MULTi.VFF.1080p.WEB.EAC3.2.0.H265-TFA', false],
	['Gomorra.2014.S04.MULTi.VFF.1080p.BluRay.HDLight.AC3.5.1.x265-NOTAG', false],
] as const;

describe('namesMedia', () => {
	it.each(REPORTED)('reads %s', (name, expected) => {
		expect(namesMedia(name, 'FROM')).toBe(expected);
	});

	it('tells a show from one whose name merely begins with it', () => {
		/*
		 * The case that decides the shape of the test. A prefix on its own is not enough
		 * — `From Dusk Till Dawn` begins with `From` — so what sits between the title and
		 * the coordinate has to be transparent: a year, or a country tag for a show that
		 * exists twice. More title means a different show.
		 */
		expect(namesMedia('From.Dusk.Till.Dawn.S04E01.MULTI.1080p.WEB.H265-TFA', 'FROM')).toBe(false);
		expect(namesMedia('From.US.S04E01.MULTI.VFF.1080p.WEB-DL.H265-TFA', 'FROM')).toBe(true);
		expect(namesMedia('From.2022.S04E01.MULTI.1080p.WEB.H265-TFA', 'FROM')).toBe(true);
	});

	it('tells a show from a spin-off whose name extends it', () => {
		/*
		 * Decided by the prefix path and never rescued by the similarity below it, which
		 * is what this case exists to pin. `Spartacus` is nine characters, it sits inside
		 * `Spartacus Gods of the Arena`, and `similarity` rewards containment — so
		 * consulting it after a prefix match would quietly undo the one distinction being
		 * drawn here.
		 */
		expect(namesMedia('Spartacus.Gods.of.the.Arena.S01E02.1080p-GRP', 'Spartacus')).toBe(false);
		expect(namesMedia('Spartacus.S01E02.1080p-GRP', 'Spartacus')).toBe(true);
		// And a name that says only the title, with no coordinate to be before.
		expect(namesMedia('Spartacus.Blood.and.Sand.1080p-GRP', 'Spartacus')).toBe(true);
	});

	it('takes a release that drops a qualifier the shelf carries', () => {
		// The direction the rescue exists for, and the safe one: a name *longer* than the
		// title is decided by the prefix path above it.
		expect(namesMedia('The.Office.S01E01.1080p-GRP', 'The Office (US)')).toBe(true);
	});

	it('takes the spellings a shelf and a tracker disagree about', () => {
		// The article, the bracket a media server files a remake under, and the accents.
		expect(namesMedia('The.Expanse.S01E02.1080p.WEB-DL.x265-GRP', 'The Expanse')).toBe(true);
		expect(namesMedia('Expanse.S01E02.1080p.WEB-DL.x265-GRP', 'The Expanse')).toBe(true);
		expect(namesMedia('Scrubs.2026.S01E01.1080p.WEB.H265-TFA', 'Scrubs (2026)')).toBe(true);
		expect(namesMedia('Pokemon.Soleil.et.Lune.S01E01.FRENCH.1080p', 'Pokémon: Soleil et Lune'))
			.toBe(true);
	});

	it('takes an anime release behind its group tag', () => {
		// `normalizeTitle` drops the bracketed block, which is what leaves the title first.
		expect(namesMedia('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv', 'Frieren')).toBe(true);
	});

	it('takes a name with no coordinate in it at all', () => {
		// A film, or a pack named nothing but the show. There is nothing to be between.
		expect(namesMedia('From.COMPLETE.FRENCH.1080p.WEB.x265-GRP', 'FROM')).toBe(true);
		expect(namesMedia('Blade.Runner.2049.2017.2160p.UHD.BluRay.x265-GRP', 'Blade Runner 2049'))
			.toBe(true);
	});

	it('answers yes about a media with no title at all', () => {
		// Somebody's odd library, or free text somebody cleared. There is nothing to
		// compare against, and answering no to every release would empty the screen —
		// this test is the only thing that says that is on purpose.
		expect(namesMedia('Bridgerton.2020.S04.1080p', '')).toBe(true);
		expect(namesMedia('Bridgerton.2020.S04.1080p', '   ')).toBe(true);
	});
});
