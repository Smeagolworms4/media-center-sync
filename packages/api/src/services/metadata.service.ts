import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { ExternalIds, Settings } from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { nfoNameFor, renderNfo, type NfoFacts } from './nfo';
import { basename, stripExtension } from './title-normalizer';

/** What the media servers read from beside a file. */
export type SidecarKind = 'artwork' | 'subtitle' | 'nfo' | 'other';

const SUBTITLE_EXTENSIONS = new Set([
	'.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt', '.sup', '.smi',
]);

const ARTWORK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tbn']);

/**
 * Artwork that belongs to the folder rather than to one file.
 *
 * Both Jellyfin and Plex read these by name, and they are shared by everything in
 * the directory — which is why they are the ones most likely to already exist
 * locally, and the ones it would be rudest to overwrite.
 */
const FOLDER_ARTWORK = new Set([
	'folder.jpg', 'poster.jpg', 'fanart.jpg', 'banner.jpg', 'backdrop.jpg', 'thumb.jpg',
	'folder.png', 'poster.png', 'fanart.png',
]);

export interface SidecarFile {
	/** Name as it will land next to the media, already renamed to the target's base. */
	name: string;
	kind: SidecarKind;
	size: number | null;
	open(): Promise<Readable>;
}

export interface MetadataResult {
	copied: string[];
	/** Skipped because a local file was already there and the settings said to keep it. */
	kept: string[];
	failed: { name: string; error: string }[];
}

/**
 * Artwork, subtitles and `.nfo` files, moved with the media.
 *
 * The rule that governs everything here is that a local file is never overwritten
 * unless `preferSourceMetadata` says so. Somebody's own artwork, their own
 * corrected `.nfo`, their own hand-timed subtitles are work they did; a sync that
 * quietly replaces them with a stranger's is a sync they turn off. When in doubt
 * the local file wins, and the interface can say what was kept.
 */
@Injectable()
export class MetadataService {
	private readonly _logger = new Logger(MetadataService.name);

	/**
	 * Companion files sitting next to a media file we can read directly.
	 *
	 * Only usable when the source library is mounted on this machine — a local
	 * service, or a NAS both gateways see. For a remote peer the sidecars travel over
	 * the link and arrive as `SidecarFile`s built by the caller, which is why this
	 * returns the same shape either way.
	 */
	public async discover(sourcePath: string, targetPath: string): Promise<SidecarFile[]> {
		const directory = dirname(sourcePath);
		const sourceBase = stripExtension(basename(sourcePath));
		const targetBase = stripExtension(basename(targetPath));

		let entries: string[];

		try {
			entries = await readdir(directory);
		} catch {
			// An unreadable source directory is the normal case for a remote service,
			// not a failure worth reporting: there is simply nothing to pick up here.
			return [];
		}

		const sidecars: SidecarFile[] = [];

		for (const entry of entries) {
			const full = join(directory, entry);
			const extension = extname(entry).toLowerCase();
			const base = stripExtension(entry);
			const kind = this._kindOf(entry, extension);

			if (!kind) {
				continue;
			}

			// A companion either shares the media's base name — possibly with a language
			// suffix, `Film.en.srt` — or is one of the folder-wide artwork names.
			const belongs =
				base === sourceBase ||
				base.startsWith(`${sourceBase}.`) ||
				base.startsWith(`${sourceBase}-`) ||
				FOLDER_ARTWORK.has(entry.toLowerCase());

			if (!belongs) {
				continue;
			}

			const suffix = base.slice(sourceBase.length);
			const name = FOLDER_ARTWORK.has(entry.toLowerCase())
				? entry
				: // Renamed to follow the media file, or the servers stop associating
			// them: a subtitle called after the source's name next to a file
			// called something else is a subtitle nobody sees.
				`${targetBase}${suffix}${extension}`;

			const size = await stat(full)
				.then((stats) => stats.size)
				.catch(() => null);

			sidecars.push({
				name,
				kind,
				size,
				open: async () => createReadStream(full),
			});
		}

		return sidecars;
	}

	/**
	 * Write the companions next to the placed media.
	 *
	 * Each file is decided on separately: one existing local poster does not stop the
	 * subtitles from arriving, and a failure on one is reported rather than thrown, so
	 * a transfer is never lost over a `.nfo`.
	 */
	public async apply(
		targetPath: string,
		sidecars: SidecarFile[],
		settings: Settings,
	): Promise<MetadataResult> {
		const result: MetadataResult = { copied: [], kept: [], failed: [] };

		if (!settings.pullMetadata || sidecars.length === 0) {
			return result;
		}

		const directory = dirname(targetPath);

		await mkdir(directory, { recursive: true });

		for (const sidecar of sidecars) {
			const destination = join(directory, sidecar.name);
			const exists = await access(destination, constants.F_OK).then(
				() => true,
				() => false,
			);

			if (exists && !settings.preferSourceMetadata) {
				result.kept.push(sidecar.name);

				continue;
			}

			try {
				// Written through a temporary name and renamed, so an interrupted copy
				// never leaves a half-written poster where a good one used to be.
				const temporary = `${destination}.mcs-part`;

				await pipeline(await sidecar.open(), createWriteStream(temporary));
				await this._replace(temporary, destination);

				result.copied.push(sidecar.name);
			} catch (error) {
				this._logger.warn(`Could not place "${sidecar.name}": ${String(error)}`);
				result.failed.push({ name: sidecar.name, error: String(error) });
			}
		}

		return result;
	}


	/**
	 * Write an `.nfo` of our own beside the placed file.
	 *
	 * Separate from `apply`, which only copies companions that exist. The case this
	 * answers is the common one: a source holds rich metadata in its own database and
	 * nothing on disk, so copying gives us the file and none of the facts, and the
	 * local media server re-identifies the episode from its filename. That is how a
	 * correctly named episode is filed under a different series of the same name.
	 *
	 * **Never overwrites an existing document. Not under any setting.**
	 *
	 * `preferSourceMetadata` does not reach here, and the asymmetry with `apply` is
	 * the point. That setting says a companion the source really has may be richer
	 * than ours — a poster, a subtitle, a `.nfo` somebody curated at the other end —
	 * and it is a fair thing to prefer. This document is not one of those: it is
	 * assembled from fields we hold, and losing a `.nfo` somebody wrote to a summary
	 * we generated is a loss with nothing gained. So the local file wins, full stop.
	 *
	 * The order also follows from it: `apply` runs first and may legitimately place
	 * the source's own document, and this then finds a file and declines. A real
	 * document beats an assembled one whichever side it came from.
	 *
	 * Returns the name written, or null when nothing was.
	 */
	public async writeNfo(
		targetPath: string,
		facts: NfoFacts,
		settings: Settings,
	): Promise<string | null> {
		if (!settings.writeNfo) {
			return null;
		}

		const name = nfoNameFor(facts.kind, basename(targetPath));
		const document = name === null ? null : renderNfo(facts);

		if (name === null || document === null) {
			return null;
		}

		const destination = join(dirname(targetPath), name);

		try {
			const exists = await access(destination, constants.F_OK).then(
				() => true,
				() => false,
			);

			if (exists) {
				return null;
			}

			await mkdir(dirname(destination), { recursive: true });

			// Through a temporary name, like every other companion: an interrupted write
			// must not leave a truncated document where a readable one used to be. A
			// media server reads a half-written `.nfo` as authoritative and wrong.
			const temporary = `${destination}.mcs-part`;

			await writeFile(temporary, document, 'utf8');
			await this._replace(temporary, destination);

			return name;
		} catch (error) {
			// Logged and swallowed, like the companions: a transfer must not be lost
			// over a metadata file.
			this._logger.warn(`Could not write "${name}": ${String(error)}`);

			return null;
		}
	}

	/**
	 * Fold the source's provider identifiers into ours.
	 *
	 * Identifiers are additive by nature: one library knows the TVDB number, the other
	 * the TMDB one, and holding both makes every later correlation cheaper. A
	 * disagreement on the same provider is the only real decision, and it goes to the
	 * local value unless the settings say the source knows better — our own value is
	 * the one somebody may have corrected by hand.
	 */
	public mergeExternalIds(
		local: ExternalIds | null | undefined,
		source: ExternalIds | null | undefined,
		preferSource: boolean,
	): ExternalIds {
		const merged: ExternalIds = { ...(local ?? {}) };

		for (const [key, value] of Object.entries(source ?? {})) {
			if (!value) {
				continue;
			}

			const field = key as keyof ExternalIds;

			// `provider` is the identifier inside the service that reported the item;
			// copying a remote one over ours would point at somebody else's database.
			if (field === 'provider') {
				continue;
			}

			if (!merged[field] || preferSource) {
				merged[field] = value;
			}
		}

		return merged;
	}

	private _kindOf(entry: string, extension: string): SidecarKind | null {
		if (extension === '.nfo') {
			return 'nfo';
		}

		if (SUBTITLE_EXTENSIONS.has(extension)) {
			return 'subtitle';
		}

		if (ARTWORK_EXTENSIONS.has(extension)) {
			return 'artwork';
		}

		return null;
	}

	private async _replace(temporary: string, destination: string): Promise<void> {
		const { rename, rm } = await import('node:fs/promises');

		try {
			await rename(temporary, destination);
		} catch (error) {
			await rm(temporary, { force: true });

			throw error;
		}
	}
}
