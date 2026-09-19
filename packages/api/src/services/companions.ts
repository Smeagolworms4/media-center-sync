import type { MediaCompanions } from '@mcs/shared';

/** Subtitle extensions both media servers read without being told. */
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.sub', '.vtt', '.sup', '.idx'];

/** Images a server picks up from the folder, whatever the media file is called. */
const POSTER_NAMES = ['poster', 'folder', 'cover', 'default', 'movie', 'show'];
const FANART_NAMES = ['fanart', 'backdrop', 'background', 'art'];

/** Descriptors that belong to the folder rather than to one file. */
const FOLDER_NFO = ['movie.nfo', 'tvshow.nfo', 'season.nfo'];

const extensionOf = (name: string): string => {
	const dot = name.lastIndexOf('.');

	return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

const stripExtension = (name: string): string => {
	const dot = name.lastIndexOf('.');

	return dot < 0 ? name : name.slice(0, dot);
};

/**
 * What sits beside one media file, from a plain directory listing.
 *
 * A pure function over names rather than a walk of the filesystem, because the rules
 * are the interesting part and they are all naming conventions: both servers find a
 * poster called `poster.jpg`, a description called `<name>.nfo` or `movie.nfo`, and a
 * subtitle called `<name>.en.forced.srt`. Testing that against a real directory would
 * mean creating twenty files to assert one rule.
 *
 * Matching is deliberately generous on subtitles and strict on the rest. A subtitle
 * carries a language and often a flag — `.en.forced.srt` — so anything starting with
 * the media's name counts; a poster named after something else is somebody else's
 * poster, and claiming it would report a complete item that is not.
 */
export const detectCompanions = (names: string[], mediaFileName: string): MediaCompanions => {
	const base = stripExtension(mediaFileName).toLowerCase();
	const others = names.filter((name) => name !== mediaFileName);
	const lower = others.map((name) => name.toLowerCase());

	const nfo = lower.some(
		(name) => name === `${base}.nfo` || FOLDER_NFO.includes(name),
	);

	const named = (roots: string[], name: string): boolean => {
		const stem = stripExtension(name);

		return (
			roots.includes(stem) ||
			roots.some((root) => stem === `${base}-${root}` || stem === `${base}.${root}`)
		);
	};

	const isImage = (name: string): boolean =>
		['.jpg', '.jpeg', '.png', '.webp', '.tbn'].includes(extensionOf(name));

	const poster = lower.some((name) => isImage(name) && named(POSTER_NAMES, name));
	const fanart = lower.some((name) => isImage(name) && named(FANART_NAMES, name));

	const subtitles = lower.filter(
		(name) => SUBTITLE_EXTENSIONS.includes(extensionOf(name)) && stripExtension(name).startsWith(base),
	).length;

	return {
		nfo,
		poster,
		fanart,
		subtitles,
		// Filled by whoever compares this against a source. On its own, a listing can
		// say what is here and never what is missing.
		missing: [],
		checkedAt: new Date().toISOString(),
	};
};

/**
 * What one side has that the other does not.
 *
 * Roles rather than filenames: the two libraries name their posters differently and
 * saying `folder.jpg` is missing when `poster.jpg` is right there would be worse than
 * saying nothing.
 */
export const missingCompanions = (
	here: MediaCompanions | null,
	there: MediaCompanions | null,
): string[] => {
	if (there === null) {
		return [];
	}

	const mine = here ?? { nfo: false, poster: false, fanart: false, subtitles: 0 };
	const missing: string[] = [];

	if (there.nfo && !mine.nfo) {
		missing.push('nfo');
	}

	if (there.poster && !mine.poster) {
		missing.push('poster');
	}

	if (there.fanart && !mine.fanart) {
		missing.push('fanart');
	}

	if (there.subtitles > mine.subtitles) {
		missing.push('subtitles');
	}

	return missing;
};
