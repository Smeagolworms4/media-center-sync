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
	/**
	 * The year of the series, for an episode — never the episode's own.
	 *
	 * The two are different numbers and confusing them split one show across four
	 * folders on a real library. A media server dates an episode by when it aired, so
	 * `year` on a Spartacus episode is 2010 in season one and 2013 in season three;
	 * building the series folder from it produced `Spartacus (2010)`,
	 * `Spartacus (2011)`, `Spartacus (2012)` and `Spartacus (2013)`, each holding one
	 * season, and Jellyfin duly showed four separate shows of one season each. The
	 * owner's verdict was that he clearly did not have everything, and he was right:
	 * what he had was the show, quartered.
	 *
	 * Unknown means no year at all in the folder name. `Spartacus/Season 03` groups
	 * correctly and is what matters here; a wrong year does not.
	 */
	seriesYear?: number | null;
	/** Path on the source, which carries the name the source library gave it. */
	sourcePath?: string | null;
}

/**
 * One media named the way a person would say it out loud.
 *
 * An episode's own title is the episode's — `Monstres` — and on a queue of forty
 * transfers that is a list of words with nothing to attach them to. The owner watched
 * a run of Spartacus go past as `Monstres`, `Mors Indecepta`, and had to read the
 * destination path to find out which show and which season each belonged to.
 *
 * Built from what the row already carries rather than from the path, because the path
 * is where the file is going and this is what the file *is* — the two disagree the
 * moment somebody redirects a transfer, and the name must not move when the folder
 * does.
 *
 * A film and a season keep their own title: there is nothing above them to say.
 */
export const episodeLabel = (item: NameableItem): string => {
	if (item.kind !== MediaKind.EPISODE) {
		return item.title;
	}

	const coordinates =
		item.seasonNumber === null || item.seasonNumber === undefined
			|| item.episodeNumber === null || item.episodeNumber === undefined
			? null
			: `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`;

	// Joined with what each part is, and skipping what the service did not say: a show
	// with no number yet reads `Spartacus — Monstres` rather than `Spartacus — SNaNENaN`.
	return [item.seriesTitle?.trim() || null, coordinates, item.title]
		.filter((part): part is string => part !== null && part !== '')
		.join(' — ');
};

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
	 * The `LOCAL` step is nothing but "do what these do", and with none of them it has
	 * nothing to imitate and hands on to the next step.
	 *
	 * Optional because `siblingPath` already carries one: a caller that found a local
	 * copy to file this beside has, by definition, found a file whose name can be
	 * imitated. Passing samples is how a caller offers several, or offers names from
	 * somewhere other than the sibling it chose.
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
 * Both halves of the answer are chains, and neither is a choice between exclusive
 * options. The folders come from `_directory`, which imitates the destination
 * library's own spelling and falls back to a template. The file name comes from the
 * order in the settings, each step either answering or handing on.
 *
 * `SOURCE` leads that order by default and looks like the worst step in it, because
 * the names it produces are the ugly scene names nobody would choose. It is the safe
 * one precisely because it chooses nothing: the file arrives with the name the
 * source's own library already scrapes correctly, so whatever agent identified it
 * there identifies it here. Every renaming scheme encodes assumptions — that the
 * episode numbering matches the one the scraper uses, that the year is the one the
 * metadata agent picked, that a two-part episode is `S01E01-E02` — and each
 * assumption is wrong on some library, where it turns a correctly identified file
 * into an unrecognised one sitting in the wrong folder. Ugly and right beats tidy and
 * occasionally invisible.
 */
@Injectable()
export class NamingService {
	/**
	 * The path relative to the destination library root, directories included.
	 *
	 * A relative path rather than a bare name because the conventions genuinely need
	 * folders — a show whose episodes all land in the library root is not a library —
	 * and because the placement service is the only thing that should know the root.
	 */
	public render(
		order: NamingScheme[],
		item: NameableItem,
		context: NamingContext = {},
	): string {
		const extension = this._extension(item.sourcePath);
		const name = this._fileName(order, item, context, extension);
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
	 *
	 * A dotted name is the case that needed handling separately, and it is not a rare
	 * one: it is what the dotted convention produces and what every scene-named source
	 * file already looks like. See `_tagged`.
	 */
	public disambiguate(relativeName: string, marks: VersionMarks, attempt: number): string {
		const cut = relativeName.replace(/\\/g, '/');
		const slash = cut.lastIndexOf('/');
		const directory = slash === -1 ? '' : cut.slice(0, slash + 1);
		const name = slash === -1 ? cut : cut.slice(slash + 1);
		const extension = this._extension(name);
		const stem = extension === '' ? name : name.slice(0, name.length - extension.length);
		const label = this._versionLabel(marks);
		const rendered = label === null ? null : this._tagged(label.text, label.edition);

		// A source whose own name already carries the label is the case where repeating
		// it would produce `Film {edition-Extended} - {edition-Extended}.mkv` and still
		// collide. The counter is the only thing left that is guaranteed to differ.
		const usable =
			rendered !== null && !stem.toLowerCase().includes(rendered.toLowerCase()) ? label : null;

		const counted =
			usable === null
				? String(attempt + 1)
				: attempt === 1
					? usable.text
					: `${usable.text} (${attempt})`;

		// The counter goes inside the tag rather than after it. Outside, the `(2)` is
		// what Plex is left holding once it has stripped the tag, and it is read as
		// more title.
		const suffix = this._tagged(counted, this._isDotted(stem) || (usable?.edition ?? false));

		return `${directory}${this.sanitise(`${stem} - ${suffix}${extension}`)}`;
	}

	/**
	 * Does this name write its words with dots rather than spaces?
	 *
	 * Read off the name rather than taken from the settings, because the name may have
	 * come from the source or from an imitated sibling: the setting says what this
	 * gateway would have produced, not what is actually on the line.
	 */
	private _isDotted(stem: string): boolean {
		return !stem.includes(' ') && stem.includes('.');
	}

	/**
	 * A marker in the form the name it is glued to cannot swallow.
	 *
	 * The separator before it stays ` - ` whatever the name looks like, because that is
	 * the one Jellyfin reads a version name after and there is no dotted equivalent:
	 * `Film.1982.2160p.mkv` beside `Film.1982.mkv` gives Jellyfin two files and no
	 * statement that they are one film. What a dotted name changes is the *content* of
	 * the marker.
	 *
	 * In a spaced name the marker reads as a distinct trailing field and both servers
	 * treat it as one. In a dotted name every word is already separated by a dot, both
	 * scanners normalise those dots to spaces before matching a title, and ` - 2` then
	 * arrives as two more title words: `Some.Film - 2.mkv` is matched as *Some Film 2*,
	 * a sequel — which is exactly how two versions of one film become two films. So a
	 * dotted name has its marker wrapped in the `{edition-…}` tag, which Plex strips
	 * unconditionally before matching, while Jellyfin still finds a version name after
	 * the last ` - `. Jellyfin then shows the version as `{edition-2160p}` rather than
	 * `2160p`, which is ugly and is the right trade: a clumsily labelled version is a
	 * version, and a second film is a second film for ever.
	 */
	private _tagged(text: string, tag: boolean): string {
		return tag ? `{edition-${text}}` : text;
	}

	/**
	 * What tells this copy from the one already there, and whether it is an edition.
	 *
	 * The edition travels with the flag rather than pre-wrapped because the counter
	 * has to be able to go inside the tag with it.
	 */
	private _versionLabel(marks: VersionMarks): { text: string; edition: boolean } | null {
		const edition = marks.edition?.trim();

		if (edition) {
			return { text: this.sanitise(edition), edition: true };
		}

		const quality = marks.quality?.trim();

		return quality ? { text: this.sanitise(quality), edition: false } : null;
	}

	/**
	 * Where the file goes, which is a separate question from what it is called.
	 *
	 * The naming order decides the name and nothing else. Folders are not negotiable: a
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
			// The *series'* year, and never the episode's — see `NameableItem.seriesYear`.
			// The episode's is the year it aired, which is a different number in every
			// season and gave one show four folders.
			const seriesFolder = this.sanitise(
				item.seriesYear ? `${series} (${item.seriesYear})` : series,
			);

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

	/**
	 * The first step of the order that can answer.
	 *
	 * The standard convention closes the chain whatever the order says, because a
	 * caller is entitled to a name: an order that ends in a step which handed on —
	 * saved before the validator existed, or hand-edited into the settings table —
	 * would otherwise leave a finished download with nothing to be called. The
	 * settings refuse such an order on the way in; this is what makes the refusal a
	 * validation rather than the only thing standing between a pull and a crash.
	 */
	private _fileName(
		order: NamingScheme[],
		item: NameableItem,
		context: NamingContext,
		extension: string,
	): string {
		for (const step of order) {
			const candidate = this._step(step, item, context, extension);

			if (candidate !== null) {
				return candidate;
			}
		}

		return this._standard(item, extension);
	}

	/** One step's answer, or null when it has nothing to go on and the next takes over. */
	private _step(
		step: NamingScheme,
		item: NameableItem,
		context: NamingContext,
		extension: string,
	): string | null {
		switch (step) {
			case NamingScheme.SOURCE:
				return this._fromSource(item);

			case NamingScheme.LOCAL:
				return this._fromLocal(item, context, extension);

			case NamingScheme.STANDARD:
				return this._standard(item, extension);

			case NamingScheme.DOTTED:
				return this._dotted(item, extension);
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

	/** Null when the source sent no path — a peer that shared metadata and no file. */
	private _fromSource(item: NameableItem): string | null {
		const name = item.sourcePath ? basename(item.sourcePath) : '';

		return name === '' ? null : this.sanitise(name);
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
	 *
	 * The sibling is used when the caller offered no samples of its own. Without that
	 * this step was unreachable in practice — the one caller in the application finds
	 * the local copy to file beside and passes it as `siblingPath`, so imitation was
	 * configured, looked configured, and every pull quietly took the fallback.
	 */
	private _fromLocal(
		item: NameableItem,
		context: NamingContext,
		extension: string,
	): string | null {
		const offered = context.samples?.length ? context.samples : [context.siblingPath ?? ''];
		const sample = offered.find((candidate) => candidate.trim() !== '');

		if (!sample) {
			return null;
		}

		const sampleName = stripExtension(basename(sample));
		const tag = /s(\d{1,3})[\s._-]*e(\d{1,4})/i.exec(sampleName);

		if (!tag || item.seasonNumber === null || item.episodeNumber === null) {
			// The sample carries no episode tag, or we have no numbers to put in one.
			// Copying the sample verbatim would overwrite the very file we took as a
			// model, so the next step takes over rather than the gateway guessing.
			return null;
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

	/**
	 * `Show - S01E02 - Title.ext`, the spaced convention both servers read.
	 *
	 * It closes the chain when nothing above answered, so it never returns null.
	 * Folders are `_directory`'s.
	 */
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

	/**
	 * `Show.Year.S01E03.Title.ext`, the dotted convention.
	 *
	 * A different convention from `_standard`, not a prettier one: it is what scene
	 * releases carry and what a great many Plex libraries are entirely made of, and
	 * both servers read it. Somebody whose library already looks like this does not
	 * want one file in it spelled with spaces.
	 *
	 * Dots everywhere, including in place of the ` - ` the spaced convention uses,
	 * because a name that mixes the two is neither: the whole point of the convention
	 * is that every separator in it means the same thing to a parser.
	 */
	private _dotted(item: NameableItem, extension: string): string {
		if (item.kind === MediaKind.EPISODE) {
			const series = item.seriesTitle?.trim() || item.title;
			const tag = `S${this._pad(item.seasonNumber ?? 0)}E${this._pad(item.episodeNumber ?? 0)}`;

			// The series' year for the same reason the folder uses it: a dotted name
			// carrying the episode's year says `Spartacus.2013.S03E08`, which every
			// scraper reads as a show that started in 2013.
			return this.sanitise(
				`${this._dots([series, item.seriesYear, tag, item.title])}${extension}`,
			);
		}

		return this.sanitise(`${this._dots([item.title, item.year])}${extension}`);
	}

	/**
	 * The parts joined the way the dotted convention joins them.
	 *
	 * Each part is sanitised before its spaces become dots, so an illegal character
	 * turns into a separator rather than vanishing — `Batman: Begins` is
	 * `Batman.Begins` and not `BatmanBegins`. Empty parts drop out entirely: a missing
	 * year would otherwise leave `Show..S01E02`, which both scanners read as a title
	 * with an empty word in it.
	 */
	private _dots(parts: (string | number | null | undefined)[]): string {
		return parts
			.map((part) => (typeof part === 'number' ? String(part) : (part ?? '').trim()))
			.filter((part) => part !== '')
			.map((part) => this.sanitise(part).replace(/\s+/g, '.'))
			.join('.')
			.replace(/\.{2,}/g, '.');
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
