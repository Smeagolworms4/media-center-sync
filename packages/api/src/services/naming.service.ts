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

export interface NamingContext {
	/**
	 * File names our own library already uses for this show, most relevant first.
	 *
	 * The `LOCAL` scheme is nothing but "do what these do", and with none of them it
	 * has nothing to imitate.
	 */
	samples?: string[];
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

	/** `Show (Year)/Season 01/Show - S01E02 - Title.ext`, the shape both servers read. */
	private _standard(item: NameableItem, extension: string): string {
		if (item.kind === MediaKind.EPISODE) {
			const series = this.sanitise(item.seriesTitle?.trim() || item.title);
			const seriesFolder = item.year ? `${series} (${item.year})` : series;
			const season = this._pad(item.seasonNumber ?? 0);
			const episode = this._pad(item.episodeNumber ?? 0);
			const episodeTitle = item.title?.trim() ? ` - ${this.sanitise(item.title)}` : '';

			return [
				this.sanitise(seriesFolder),
				this.sanitise(`Season ${season}`),
				this.sanitise(`${series} - S${season}E${episode}${episodeTitle}${extension}`),
			].join('/');
		}

		const title = this.sanitise(item.title);
		const named = item.year ? `${title} (${item.year})` : title;

		// A film gets its own folder because that is where its artwork, subtitles and
		// `.nfo` go, and both Jellyfin and Plex expect to find them beside it.
		return [this.sanitise(named), this.sanitise(`${named}${extension}`)].join('/');
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
