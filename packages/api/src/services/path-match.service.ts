import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PathMatch, ServerStructureSupport } from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { HandlerRegistry, type ServiceConnection } from './handlers';

/**
 * A file the gateway writes and the media server is asked to look at.
 *
 * Hidden and with an extension no scanner recognises, because this lands inside
 * somebody's media folder: a visible `probe.mkv` would be picked up as a zero-byte
 * film by whichever server is watching the directory, and the tidy-up happens
 * milliseconds later but the library entry does not clean itself up. The random
 * suffix is what keeps two checks running at once — a scheduled one and a person
 * pressing the button — from deleting each other's marker and concluding a mismatch.
 */
const MARKER_PREFIX = '.mcs-path-check-';
const MARKER_SUFFIX = '.tmp';

/**
 * Proving that two paths designate the same directory.
 *
 * This is the one failure the product exists to prevent and the only one that
 * reports nothing: a library whose `localPath` is not the directory the media server
 * reads accepts every transfer, writes every file, and leaves the server's library
 * empty. Nothing errors, because nothing did anything wrong.
 *
 * **Comparing the two path strings is not a proof and was rejected outright.** They
 * are legitimately different whenever the service runs in its own container — the
 * server says `/data/media/shows`, the gateway sees `/mnt/nas/shows` — which is the
 * ordinary deployment and the entire reason the mapping exists. A comparison would
 * therefore report a mismatch on every correct setup and a match on any wrong one
 * where the two strings happen to agree, which is worse than saying nothing at all.
 *
 * So the gateway writes a marker file into its own path and asks the server to list
 * the directory it says it reads. If the server sees the file, the two are the same
 * directory — not inferred, observed. What it costs is stated at `verify`.
 */
@Injectable()
export class PathMatchService {
	private readonly _logger = new Logger(PathMatchService.name);

	public constructor(private readonly _handlers: HandlerRegistry) {}

	/**
	 * Write here, look there, and conclude.
	 *
	 * The costs, all three of them real:
	 *
	 * - a file is created and deleted inside a media directory on every check. It is
	 *   hidden and unrecognisable to a scanner, and it is removed even when the
	 *   listing throws, but a directory somebody is watching will show it for a moment.
	 * - it takes one request to the media server per declared server path, so a check
	 *   over eleven libraries is eleven round trips. That is why this runs on demand
	 *   rather than on every page that shows a library.
	 * - a server that caches its directory listings can answer without the marker and
	 *   be reported as a mismatch when the mapping is fine. Neither Jellyfin's
	 *   `/Environment/DirectoryContents` nor Plex's `/services/browse` is known to
	 *   cache, and the answer degrades to a warning rather than a refusal precisely
	 *   because it can be wrong this way.
	 *
	 * Anything that stops the question being asked answers `UNKNOWN` rather than
	 * `MISMATCHED`: no server path, a service that cannot list a directory, a failed
	 * write, a listing that threw. Reporting those as a mismatch would put a red
	 * warning on every correctly configured Plex whose build has no browse route,
	 * and a warning that is wrong more often than right stops being read.
	 */
	public async verify(
		connection: ServiceConnection,
		localPath: string | null,
		serverPaths: readonly string[],
	): Promise<PathMatch> {
		const handler = this._handlers.find(connection.type);

		if (handler === null || localPath === null || localPath === '' || serverPaths.length === 0) {
			return PathMatch.UNKNOWN;
		}

		const marker = `${MARKER_PREFIX}${randomUUID()}${MARKER_SUFFIX}`;
		const markerPath = join(localPath, marker);

		try {
			await writeFile(markerPath, '');
		} catch {
			// An unwritable path is already reported as such by the probe, and this
			// would be a second warning about the same thing in different words.
			return PathMatch.UNKNOWN;
		}

		try {
			let answered = false;

			for (const serverPath of serverPaths) {
				const structure = await handler
					.listServerDirectories(connection, { path: serverPath, includeFiles: true })
					.catch((error: unknown) => {
						this._logger.debug(
							`${connection.id} could not list ${serverPath}: `
								+ (error instanceof Error ? error.message : String(error)),
						);

						return null;
					});

				if (structure === null || structure.support !== ServerStructureSupport.REPORTED) {
					continue;
				}

				answered = true;

				// One matching path settles it: a library with two roots is mapped onto
				// one of them, and the other is expected not to hold the marker.
				if (structure.entries.some((entry) => this._isMarker(entry.path, entry.name, marker))) {
					return PathMatch.MATCHED;
				}
			}

			// Only a server that actually listed something can be said to have looked
			// and not found it. Otherwise nobody has answered the question.
			return answered ? PathMatch.MISMATCHED : PathMatch.UNKNOWN;
		} finally {
			// `force` so that a marker somebody else's tidy-up already removed does not
			// turn a successful check into a rejected promise.
			await rm(markerPath, { force: true }).catch(() => undefined);
		}
	}

	/**
	 * Whether one listed entry is the marker.
	 *
	 * Both the name and the tail of the path are consulted because the two halves of
	 * the answer come from different servers: Jellyfin returns a `Name` beside every
	 * path, and a handler that only ever had the path would otherwise have to invent
	 * one. The separator is checked as either, since the far end may be Windows.
	 */
	private _isMarker(path: string, name: string, marker: string): boolean {
		return name === marker || path.endsWith(`/${marker}`) || path.endsWith(`\\${marker}`);
	}
}
