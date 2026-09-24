import { MediaKind } from '@mcs/shared';

/**
 * The facts a media server reads out of an `.nfo`, whatever kind of media it is.
 *
 * Deliberately not a `MediaItem`: this renders from what a pull actually knows, and
 * taking the whole entity would tie the format to the persistence model and make it
 * untestable without one.
 */
export interface NfoFacts {
	kind: MediaKind;
	title: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	overview: string | null;
	/** The series title, for an episode. Without it an episode names only itself. */
	showTitle?: string | null;
	/** Provider identifiers, keyed as the gateway keys them: `tvdb`, `tmdb`, `imdb`. */
	externalIds: Record<string, string>;
}

/** The root element each kind of media is filed under. */
const ROOT: Partial<Record<MediaKind, string>> = {
	[MediaKind.MOVIE]: 'movie',
	[MediaKind.EPISODE]: 'episodedetails',
	[MediaKind.SERIES]: 'tvshow',
	[MediaKind.SEASON]: 'season',
};

/**
 * Providers a media server recognises, and the element it expects for each.
 *
 * A map rather than emitting whatever identifiers we hold: an unknown provider in a
 * `uniqueid` element is at best ignored and at worst makes a strict parser drop the
 * whole file, which would lose the identifiers that do work.
 */
const UNIQUE_IDS: Record<string, string> = {
	tvdb: 'tvdb',
	tmdb: 'tmdb',
	imdb: 'imdb',
	anidb: 'anidb',
};

/**
 * The provider a media server treats as authoritative when several are present.
 *
 * One `uniqueid` has to carry `default="true"` or the server picks for itself, and a
 * server that picks differently from the source we pulled from is how the same
 * episode ends up identified two ways on two machines.
 */
const PREFERRED_ID_ORDER = ['tvdb', 'tmdb', 'imdb', 'anidb'];

/**
 * XML text, with the five characters that would otherwise end the document early.
 *
 * Titles are the reason: `Fear & Loathing` and `Girls' Night` both occur in real
 * libraries, and an unescaped ampersand makes the whole file unparseable — which a
 * media server reports as "no metadata" rather than as a broken file.
 */
function escape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function element(name: string, value: string | number | null | undefined): string | null {
	if (value === null || value === undefined) {
		return null;
	}

	const text = String(value).trim();

	return text === '' ? null : `\t<${name}>${escape(text)}</${name}>`;
}

function uniqueIds(externalIds: Record<string, string>): string[] {
	const known = Object.entries(externalIds ?? {})
		.filter(([provider, value]) => UNIQUE_IDS[provider] !== undefined && String(value).trim() !== '');

	if (known.length === 0) {
		return [];
	}

	const preferred =
		PREFERRED_ID_ORDER.find((provider) => known.some(([name]) => name === provider)) ??
		known[0][0];

	return known.map(([provider, value]) => {
		const isDefault = provider === preferred ? ' default="true"' : '';

		return `\t<uniqueid type="${UNIQUE_IDS[provider]}"${isDefault}>${escape(String(value))}</uniqueid>`;
	});
}

/**
 * Render an `.nfo` for one media file: the identifiers, and what tells the server
 * which episode this is. Nothing else, and that is the whole design.
 *
 * Returns null for a kind that has no sensible document — there is nothing useful to
 * say about a collection in a file that sits next to a video — and null when there is
 * no identifier to carry, because then there is nothing here worth a file.
 *
 * What makes this worth writing at all is the identifiers. A source often holds rich
 * metadata in its own database and no `.nfo` on disk: copying the companions then
 * gives us the file and none of the facts, and the local media server re-identifies
 * the episode from its filename. That is how a correctly named episode ends up filed
 * under a different series with the same name.
 *
 * **The title, the year and the plot used to be written here, and writing them was a
 * bug.** A media server reads a local `.nfo` as authority: given a document that
 * already names the film and describes it, Jellyfin considers the record complete and
 * stops fetching from TMDB and TVDB — so artwork, cast, ratings and every later
 * correction upstream simply never arrive, and nothing reports a failure. It took a
 * full "replace all metadata" refresh to undo on a real library. An identifier has the
 * opposite effect: it is the one fact the server cannot work out for itself, and
 * handing it over is what sends the server to the provider rather than away from it.
 *
 * `season` and `episode` stay because they are not metadata: they say which file this
 * is, which is a question about the disk and not about the show, and a server that
 * gets it wrong files the episode under the wrong season whatever it fetches.
 *
 * `lockdata` is written false on purpose, rather than left out. Some tools write these
 * files locked, and a reader that assumes the default is locked would freeze exactly
 * what this change exists to keep thawed. Saying it costs one line.
 */
export function renderNfo(facts: NfoFacts): string | null {
	const root = ROOT[facts.kind];

	if (root === undefined) {
		return null;
	}

	const ids = uniqueIds(facts.externalIds ?? {});

	// No identifier, no document. What is left would be a title the server already has
	// from the filename, written in the one place that stops it looking any further.
	if (ids.length === 0) {
		return null;
	}

	const body = [
		element('season', facts.seasonNumber),
		element('episode', facts.episodeNumber),
		...ids,
		element('lockdata', 'false'),
	].filter((line): line is string => line !== null);

	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		`<${root}>`,
		...body,
		`</${root}>`,
		'',
	].join('\n');
}

/**
 * The name a media server looks for beside the file.
 *
 * An episode and a film are both named after their own file — `S01E02.mkv` pairs
 * with `S01E02.nfo`. A series is the exception: its document belongs to the folder
 * and is always `tvshow.nfo`, so naming it after a file would leave it unread.
 */
export function nfoNameFor(kind: MediaKind, fileName: string): string | null {
	if (kind === MediaKind.SERIES) {
		return 'tvshow.nfo';
	}

	if (ROOT[kind] === undefined) {
		return null;
	}

	const dot = fileName.lastIndexOf('.');

	return `${dot > 0 ? fileName.slice(0, dot) : fileName}.nfo`;
}
