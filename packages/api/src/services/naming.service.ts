/* eslint-disable no-control-regex -- The control characters are the point: a filename
 * arriving from another gateway can contain anything, and a byte below 0x20 in a path
 * is how a crafted name escapes a directory or breaks a shell somewhere downstream.
 * Stripping them is exactly what this rule assumes is a mistake. */
import { MediaKind, NamingScheme } from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { basename, stripExtension } from './title-normalizer';

/** What a name can be built from. All of it optional, because all of it goes missing. */
export interface NameableItem {
	kind: MediaKind;
	title: string;
	year?: number | null;
	seasonNumber?: number | null;
	episodeNumber?: number | null;
	/** The series title, for an episode. Its own `title` is the episode's. */
	seriesTitle?: string | null;
	/** Path on the source, which carries the name the source library gave it. */
	sourcePath?: string | null;
}

/**
 * What tells two versions of one media apart, in the words a media server reads.
 *
 * Both fields are labels and neither is an identity — see `MediaVersion`. They exist
 * so that a second copy lands under a name that says what it is, rather than under
 * `Film (2) .mkv`, which is unique and tells a library nothing.
 */
export interface VersionMarks {
	/** `Extended`, `Director's Cut` — from the service, or from a `{edition-…}` tag. */
	edition?: string | null;
	/** `2160p`, `1080p`: the resolution band, which is what a quality suffix means. */
	quality?: string | null;
}

export interface NamingContext {
	/**
	 * File names our own library already uses for this show, most relevant first.
	 *
	 * The `LOCAL` scheme is nothing but "do what these do", and with none of them it
	 * has nothing to imitate.
	 */
	samples?: string[];

	/**
	 * A file our own library already holds for this show or collection.
	 *
	 * This is what makes the gateway file a pulled episode where the others live,
	 * rather than where a template says they should. A library that spells its folders
	 * `Saison 1` keeps spelling them `Saison 1`; one that puts everything flat stays
	 * flat. Imitating beats inferring, because inferring is how a season ends up split
	 * across two folders that differ by a space.
	 */
	siblingPath?: string | null;

	/** Root of the destination library, so a sibling path can be made relative to it. */
	libraryRoot?: string | null;
}

/**
 * Characters no filesystem the gateway might write to will accept.
 *
 * The list is the union of the restrictions rather than the intersection: a NAS
 * exported over SMB refuses colons even when the underlying filesystem does not,
 * and a file that cannot be copied off the machine later is a file somebody loses.
 */
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Windows keeps these reserved whatever the extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_COMPONENT_LENGTH = 200;

/**
 * Renders the name a pulled file lands under.
 *
 * `SOURCE` is the default and looks like the worst of the three, because the names
 * it produces are the ugly scene names nobody would choose. It is the safe one
 * precisely because it chooses nothing: the file arrives with the name the source's
 * own library already scrapes correctly, so whatever agent identified it there
 * identifies it here. Every renaming scheme encodes assumptions — that the episode
 * numbering matches the one the scraper uses, that the year is the one the metadata
 * agent picked, that a two-part episode is `S01E01-E02` — and each assumption is
 * wrong on some library, where it turns a correctly identified file into an
 * unrecognised one sitting in the wrong folder. Ugly and right beats tidy and
 * occasionally invisible.
 */
@Injectable()
export class NamingService {
	/**
	 * The path relative to the destination library root, directories included.
	 *
	 * A relative path rather than a bare name because `STANDARD` genuinely needs
	 * folders — a show whose episodes all land in the library root is not a library —
	 * and because the placement service is the only thing that should know the root.
	 */
	public render(
		scheme: NamingScheme,
		item: NameableItem,
		context: NamingContext = {},
	): string {
		const extension = this._extension(item.sourcePath);
		const name = this._fileName(scheme, item, context, extension);
		const directory = this._directory(item, context);

		return directory === '' ? name : `${directory}/${name}`;
	}

	/**
	 * The same file under a name the path it wanted is not already using.
	 *
	 * Called only when something occupies the rendered path, and the convention is not
	 * invented here: both servers read a version suffix after the last ` - ` of a file
	 * name — `Film (2009) - 2160p.mkv` beside `Film (2009) - 1080p.mkv` is how Jellyfin
	 * is told they are two versions of one film — and Plex additionally parses
	 * `{edition-Director's Cut}` anywhere in the name and strips it before matching the
	 * title. Writing the edition inside that tag therefore satisfies both at once: Plex
	 * reads the edition, Jellyfin reads a version name, and neither ends up with a
	 * second film whose title has grown a suffix.
	 *
	 * The edition wins over the resolution when both are known, because it is the
	 * statement somebody made about the content and the resolution is a fact about the
	 * encode — and two copies of one cut differ by the second while two cuts differ by
	 * the first.
	 *
	 * `attempt` counts from one and only ever grows: the caller retries until the path
	 * is free, so this has to keep producing new names — two 2160p encodes of one cut
	 * exist, and the label alone would collide with itself for ever.
	 */
	public disambiguate(relativeName: string, marks: VersionMarks, attempt: number): string {
		const cut = relativeName.replace(/\\/g, '/');
		const slash = cut.lastIndexOf('/');
		const directory = slash === -1 ? '' : cut.slice(0, slash + 1);
		const name = slash === -1 ? cut : cut.slice(slash + 1);
		const extension = this._extension(name);
		const stem = extension === '' ? name : name.slice(0, name.length - extension.length);
		const label = this._versionLabel(marks);

		// A source whose own name already carries the label is the case where repeating
		// it would produce `Film {edition-Extended} - {edition-Extended}.mkv` and still
		// collide. The counter is the only thing left that is guaranteed to differ.
		const usable =
			label !== null && !stem.toLowerCase().includes(label.toLowerCase()) ? label : null;

		const suffix =
			usable === null
				? String(attempt + 1)
				: attempt === 1
					? usable
					: `${usable} (${attempt})`;

		return `${directory}${this.sanitise(`${stem} - ${suffix}${extension}`)}`;
	}

	private _versionLabel(marks: VersionMarks): string | null {
		const edition = marks.edition?.trim();

		if (edition) {
			return `{edition-${this.sanitise(edition)}}`;
		}

		const quality = marks.quality?.trim();

		return quality ? this.sanitise(quality) : null;
	}

	/**
	 * Where the file goes, which is a separate question from what it is called.
	 *
	 * The scheme decides the name and nothing else. Folders are not negotiable: a
	 * library whose episodes land in its root is not a library, and both media servers
	 * identify a file partly by the folders above it — a season folder is how they know
	 * which season, when the filename is ambiguous. Dropping files flat was what the
	 * `SOURCE` scheme used to do, and it produced a directory of scene names that
	 * neither server grouped into anything.
	 *
	 * An existing local file for the same show wins over any template. If the library
	 * already spells its folders a certain way, that spelling is the right answer here
	 * by definition, whatever a standard would have produced.
	 */
	private _directory(item: NameableItem, context: NamingContext): string {
		const imitated = this._imitatedDirectory(item, context);

		if (imitated !== null) {
			return imitated;
		}

		if (item.kind === MediaKind.EPISODE) {
			const series = this.sanitise(item.seriesTitle?.trim() || item.title);
			const seriesFolder = this.sanitise(item.year ? `${series} (${item.year})` : series);

			return `${seriesFolder}/${this.sanitise(`Season ${this._pad(item.seasonNumber ?? 0)}`)}`;
		}

		if (item.kind === MediaKind.MOVIE) {
			// A film gets its own folder because that is where its artwork, subtitles
			// and `.nfo` go, and both servers expect to find them beside it.
			const title = this.sanitise(item.title);

			return this.sanitise(item.year ? `${title} (${item.year})` : title);
		}

		return '';
	}

	/**
	 * The folders our own library already uses for this show, adapted to this item.
	 *
	 * Only the season number is rewritten, and only when the sibling's last folder
	 * actually looks like a season — so `Saison 1` becomes `Saison 2` and `Season 01`
	 * becomes `Season 02`, each keeping its own spelling and padding. A library that
	 * files a whole show in one folder has no season segment, nothing is rewritten, and
	 * the new episode lands beside the others exactly as that library likes it.
	 */
	private _imitatedDirectory(item: NameableItem, context: NamingContext): string | null {
		const { siblingPath, libraryRoot } = context;

		if (!siblingPath || !libraryRoot) {
			return null;
		}

		const root = libraryRoot.replace(/\/+$/, '');
		const directory = siblingPath.slice(0, Math.max(0, siblingPath.lastIndexOf('/')));

		// A sibling outside the destination library says nothing about how that library
		// is organised, and following it would write outside the root.
		if (directory === '' || !(directory === root || directory.startsWith(`${root}/`))) {
			return null;
		}

		const relative = directory.slice(root.length).replace(/^\/+/, '');

		if (relative === '') {
			return null;
		}

		if (item.kind !== MediaKind.EPISODE || item.seasonNumber === null) {
			return relative;
		}

		const segments = relative.split('/');
		const last = segments[segments.length - 1] ?? '';
		const season = /^(season|saison|series|s)\s*\.?\s*(\d{1,3})$/i.exec(last);

		if (!season) {
			return relative;
		}

		// Keep the sibling's own padding: a library writing `Season 1` gets `Season 2`,
		// one writing `Season 01` gets `Season 02`.
		const padded = season[2].length > 1
			? String(item.seasonNumber ?? 0).padStart(season[2].length, '0')
			: String(item.seasonNumber ?? 0);

		segments[segments.length - 1] = last.replace(/\d{1,3}$/, padded);

		return segments.join('/');
	}

	private _fileName(
		scheme: NamingScheme,
		item: NameableItem,
		context: NamingContext,
		extension: string,
	): string {
		switch (scheme) {
			case NamingScheme.SOURCE:
				return this._fromSource(item, extension);

			case NamingScheme.LOCAL:
				return this._fromLocal(item, context, extension);

			case NamingScheme.STANDARD:
				return this._standard(item, extension);
		}
	}

	/**
	 * Make one path component safe, without making it unrecognisable.
	 *
	 * Illegal characters become a space rather than disappearing, so `Batman: Begins`
	 * stays two words. Trailing dots and spaces are cut because Windows silently
	 * drops them, which turns a file the gateway wrote into a file it cannot find
	 * again.
	 */
	public sanitise(component: string): string {
		const cleaned = component
			.replace(ILLEGAL_CHARACTERS, ' ')
			.replace(/\s+/g, ' ')
			.replace(/[. ]+$/, '')
			.trim();

		if (cleaned === '') {
			return 'untitled';
		}

		const trimmed =
			cleaned.length > MAX_COMPONENT_LENGTH ? cleaned.slice(0, MAX_COMPONENT_LENGTH).trim() : cleaned;

		return RESERVED_NAMES.test(stripExtension(trimmed)) ? `_${trimmed}` : trimmed;
	}

	private _fromSource(item: NameableItem, extension: string): string {
		const name = item.sourcePath ? basename(item.sourcePath) : '';

		if (name !== '') {
			return this.sanitise(name);
		}

		// No source path at all — a peer that only sent us metadata. There is nothing
		// to keep, so the standard scheme is the honest fallback rather than a name
		// invented here.
		return this._standard(item, extension);
	}

	/**
	 * Imitate what the local library already does for this show.
	 *
	 * Rather than inferring a template — which needs a grammar and gets it wrong on
	 * the first file with a hyphen in the episode title — an existing sibling is
	 * taken literally and only the parts that must change are changed: its episode
	 * tag becomes ours, its episode title becomes ours. Everything else, including
	 * whatever quality suffix and separator convention the library uses, survives
	 * untouched because it was never parsed.
	 */
	private _fromLocal(item: NameableItem, context: NamingContext, extension: string): string {
		const sample = context.samples?.find((candidate) => candidate.trim() !== '');

		if (!sample) {
			return this._standard(item, extension);
		}

		const sampleName = stripExtension(basename(sample));
		const tag = /s(\d{1,3})[\s._-]*e(\d{1,4})/i.exec(sampleName);

		if (!tag || item.seasonNumber === null || item.episodeNumber === null) {
			// The sample carries no episode tag, or we have no numbers to put in one.
			// Copying the sample verbatim would overwrite it, so the standard scheme
			// takes over rather than the gateway guessing.
			return this._standard(item, extension);
		}

		const replacement = `S${this._pad(item.seasonNumber ?? 0)}E${this._pad(item.episodeNumber ?? 0)}`;
		const renamed = sampleName.replace(tag[0], replacement);

		// What follows the tag in the sample is that library's idea of an episode
		// title. Swapping it keeps the separator and everything after it — which is
		// usually the quality suffix the library's users expect to see.
		const afterTag = renamed.slice(renamed.indexOf(replacement) + replacement.length);
		const separator = /^[\s._-]+/.exec(afterTag)?.[0] ?? ' - ';
		const beforeTag = renamed.slice(0, renamed.indexOf(replacement));
		const episodeTitle = item.title?.trim() ? this.sanitise(item.title) : '';

		const assembled = episodeTitle
			? `${beforeTag}${replacement}${separator}${episodeTitle}`
			: `${beforeTag}${replacement}`;

		return this.sanitise(`${assembled}${extension}`);
	}

	/** `Show - S01E02 - Title.ext`, the shape both servers read. Folders are `_directory`'s. */
	private _standard(item: NameableItem, extension: string): string {
		if (item.kind === MediaKind.EPISODE) {
			const series = this.sanitise(item.seriesTitle?.trim() || item.title);
			const season = this._pad(item.seasonNumber ?? 0);
			const episode = this._pad(item.episodeNumber ?? 0);
			const episodeTitle = item.title?.trim() ? ` - ${this.sanitise(item.title)}` : '';

			return this.sanitise(`${series} - S${season}E${episode}${episodeTitle}${extension}`);
		}

		const title = this.sanitise(item.title);
		const named = item.year ? `${title} (${item.year})` : title;

		return this.sanitise(`${named}${extension}`);
	}

	private _pad(value: number): string {
		return String(Math.max(0, Math.trunc(value))).padStart(2, '0');
	}

	private _extension(sourcePath: string | null | undefined): string {
		const match = /\.[a-z0-9]{1,4}$/i.exec(basename(sourcePath ?? ''));

		// No extension is better than a wrong one: `.mkv` appended to something that is
		// not a Matroska file is how a media server decides it cannot play a file it
		// could have played.
		return match ? match[0].toLowerCase() : '';
	}
}
