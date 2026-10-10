import { normalizeTitle, parseTitle, similarity } from '../title-normalizer';

/**
 * Whether a release name is about the media that was searched for.
 *
 * Reported from use, and the report is the clearest statement of the defect. Searching
 * season four of **From** — one of the commonest words in English — answered, under a
 * heading promising "what fills the gaps you have":
 *
 * ```
 * Bridgerton.2020.S04.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-TFA      384 sources
 * Snowpiercer.S04.MULTI.VFF.1080p.WEB.EAC3.5.1.H265-CHiLL        227 sources
 * Dexter.S04.MULTI.VFF.1080p.WEB.DDP.5.1.H265-TyHD               142 sources
 * Yellowstone.2018.S04.MULTi.VFF.1080p.WEB.EAC3.2.0.H265-TFA     133 sources
 * ```
 *
 * Every one of them a season-four pack, so every one of them agreed with the coordinate
 * that was asked for — and nothing anywhere compared the *title*. `offTarget` read the
 * season and the episode; `fillsOf` read the coverage. A fifteen-gigabyte pack of
 * Bridgerton was therefore offered as the thing that fills From's missing episodes, and
 * taking it would have filed Bridgerton under From and left the gap reading as filled.
 *
 * Indexers match on words. That is not a fault in them — it is what a text search is —
 * and it means the title test belongs here, on the way in, rather than being wished for
 * upstream.
 *
 * **Sunk, never dropped.** Tracker naming is not a standard and this is a reading of a
 * string: a show a tracker carries under another name must stay reachable, under the
 * heading that says what was set aside and why. The same rule, and the same reasoning,
 * as a release that names the wrong season.
 */

/**
 * Tokens allowed to sit between the title and the coordinate.
 *
 * A release of a show names the show and then says which part of it this is. Anything in
 * between is either metadata — a year, a country tag for a show that exists twice — or it
 * is more title, which means this is a *different* show whose name happens to start with
 * the one asked for. That distinction is the whole value of the test: `From.US.S04E01` is
 * From, and `From.Dusk.Till.Dawn.S04E01` is not, and nothing but what sits between the
 * two parts can tell them apart.
 *
 * Short because it has to be: every token added here is a word a different show is allowed
 * to begin with.
 */
const TRANSPARENT = new Set(['us', 'uk', 'au', 'ca', 'nz', 'fr', 'de', 'jp', 'kr', 'aka']);

/** A year, which a release is entitled to carry between the title and the coordinate. */
const YEAR = /^(?:19|20)\d{2}$/;

/**
 * What a release says about which part of the work it is: `s04`, `s04e06`, `4x06`.
 *
 * Read off the normalised tokens rather than the raw name because that is what this
 * function has in hand, and because `normalizeTitle` has already thrown away everything
 * that is neither title nor coordinate.
 */
const COORDINATE = /^(?:s\d{1,3}(?:e\d{1,4})?|\d{1,2}x\d{1,3}|season|saison|staffel|temporada)$/;

/**
 * How close a name has to be when it does not begin with the title.
 *
 * The prefix test is the one that decides, and this is only ever a rescue: a tracker that
 * files `Marvel's Agents of S.H.I.E.L.D.` as `Agents.of.SHIELD` names the show without
 * beginning with the shelf's spelling of it. High on purpose — it must not reach anything
 * the prefix test refused for being a different show, and at this floor nothing in the
 * report above comes close.
 */
const CLOSE_ENOUGH = 0.85;

const tokensOf = (value: string): string[] =>
	normalizeTitle(value)
		.split(' ')
		.filter((token) => token !== '');

export const namesMedia = (releaseName: string, mediaTitle: string): boolean => {
	const wanted = tokensOf(mediaTitle);

	// Nothing to compare against. A media whose title reduces to nothing is somebody's
	// odd library, and answering "no" to every release would empty the screen.
	if (wanted.length === 0) {
		return true;
	}

	const carried = tokensOf(releaseName);

	/*
	 * A name that begins with the title is **decided here**, either way, and never
	 * rescued below.
	 *
	 * That is the point this test turns on. `Spartacus: Gods of the Arena` begins with
	 * `Spartacus` and is a different show; so does `From Dusk Till Dawn` with `From`. The
	 * rescue reaches the first of those — a title of nine characters sits inside the
	 * longer name and `similarity` rewards containment — so consulting it after a prefix
	 * match would quietly undo the one distinction being drawn. What separates a show
	 * from a show whose name extends it is the words between the title and the
	 * coordinate, and nothing else can.
	 */
	if (wanted.every((token, at) => carried[at] === token)) {
		const after = carried.slice(wanted.length);
		const coordinate = after.findIndex((token) => COORDINATE.test(token));
		// No coordinate at all is a name that says only the title — a film, or a pack
		// named nothing else. Whatever follows is then the release's own noise, which
		// `normalizeTitle` has already reduced to a group tag.
		const between = coordinate === -1 ? [] : after.slice(0, coordinate);

		return between.every((token) => YEAR.test(token) || TRANSPARENT.has(token));
	}

	/*
	 * It does not begin with the title, so the shelf and the tracker disagree about the
	 * spelling rather than about the show — the only direction left to rescue, and the
	 * safe one: a name *longer* than the title was decided above.
	 *
	 * The release's title part, which is what `parseTitle` cuts the coordinate and the
	 * noise off: comparing the whole name would score every release of a long-named show
	 * against its own file name.
	 */
	return similarity(parseTitle(releaseName).normalizedTitle, normalizeTitle(mediaTitle))
		>= CLOSE_ENOUGH;
};
