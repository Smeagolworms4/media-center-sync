import { dirname } from 'node:path';
import { ErrorKey, type DirectoryListing } from '@mcs/shared';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MediaConfig } from '@/config';
import { LibraryRepository, MediaServiceRepository } from '@/repositories';
import {
	FilesystemService,
	isInside,
	PathVerdict,
	resolveRoots,
	resolveWithinRoots,
} from '@/services';

/**
 * Which directories of this gateway anybody is allowed to look at.
 *
 * Exists for one failure: a local path typed by hand that does not designate the
 * directory the media server reads accepts transfers the server never sees, and
 * nothing anywhere reports an error. Letting somebody point at a directory instead of
 * spelling it is the cheapest fix there is — and a browser that cannot reach the
 * directory somebody needs to point at does not fix it at all.
 *
 * **So the browser is not restricted by default, and that is a decision rather than
 * an oversight.** It was the other way round first: `MCS_MEDIA_ROOT` was the
 * boundary, the picker opened on it, and every step above it answered 403. That
 * reasoning only holds inside a container, where `/` is already the sandbox and the
 * mounts are the whole tree. Run the gateway straight on a host — a development
 * stack, or anybody without Docker — and the media are wherever that machine keeps
 * them, so the picker opened on a directory holding none of what was being looked
 * for, with no way up and no way across, and the person fell back to typing the path
 * by hand. That is precisely the failure this feature exists to remove, reintroduced
 * by the boundary meant to make it safe.
 *
 * What the boundary was protecting against is worth naming so the trade is legible: a
 * browse route is a way to read the shape of the host's filesystem. It is already
 * behind a session and a right, it lists directory names and never file contents, and
 * anybody holding that right is administering this gateway. A deployment that wants
 * the narrow version back sets `MCS_BROWSE_ROOTS` and gets exactly the old behaviour.
 */

/**
 * The directories worth opening on, as keys into the media configuration.
 *
 * `media.root` (`MCS_MEDIA_ROOT`) is where the libraries are mounted and
 * `media.transferRoot` is where incomplete transfers accumulate. They are no longer a
 * boundary; they are the useful place to start, which is a different job. Named as
 * keys rather than read inline so the listing code never has the whole configuration
 * in reach.
 */
const STARTING_POINT_KEYS = ['root', 'transferRoot'] as const satisfies readonly (keyof MediaConfig)[];

/**
 * The roots this deployment restricts the browser to, comma separated.
 *
 * Unset — the ordinary case — means no restriction: `/` is the root, every directory
 * is navigable, and the breadcrumb walks all the way up. Set, and these are the only
 * directories a browse may reach, which is the narrow behaviour somebody running the
 * gateway on a shared host may well want back.
 */
const BROWSE_ROOTS = 'MCS_BROWSE_ROOTS';

/** No restriction configured: the filesystem's own root, so nothing is out of reach. */
const UNRESTRICTED = ['/'];

export interface BrowseRequest {
	/** Empty or absent starts at the first allowed root. */
	path?: string;
	includeHidden?: boolean;
}

@Injectable()
export class FilesystemManager {
	private readonly _roots: readonly string[];

	private readonly _startingPoints: readonly string[];

	public constructor(
		config: ConfigService,
		private readonly _filesystem: FilesystemService,
		private readonly _services: MediaServiceRepository,
		private readonly _libraries: LibraryRepository,
	) {
		const media = config.getOrThrow<MediaConfig>('media');
		const restricted = (config.get<string>(BROWSE_ROOTS) ?? '')
			.split(',')
			.map((root) => root.trim())
			.filter((root) => root !== '');

		this._startingPoints = STARTING_POINT_KEYS.map((key) => media[key]).filter(
			(root) => root !== '',
		);

		// An empty list would let `resolveWithinRoots` refuse everything, so the
		// unrestricted case has to be spelled as a root rather than as no roots.
		this._roots = restricted.length === 0 ? UNRESTRICTED : restricted;
	}

	/**
	 * Every root a browse may reach: the configured ones, plus the directories this
	 * gateway has already been pointed at.
	 *
	 * The second half closes an inconsistency rather than opening a door. A service's
	 * `localRoot` and a library's `localPath` are directories somebody configured and
	 * that the gateway **writes into** — refusing to *list* them protected nothing,
	 * and it left the picker unable to reach the only places a local path is ever
	 * going to name. Nothing is reachable here that the gateway was not already told
	 * about and already modifies.
	 *
	 * Read per request rather than cached: a root added a minute ago has to be
	 * browsable now, and a picker that needed a restart to see a directory somebody
	 * had just configured would be blamed on the directory.
	 */
	private async _allowedRoots(): Promise<string[]> {
		const configured = [
			...(await this._services.find()).map((service) => service.localRoot),
			...(await this._libraries.find()).map((library) => library.localPath),
		].filter((root): root is string => typeof root === 'string' && root !== '');

		return [...new Set([...this._roots, ...configured])];
	}

	/**
	 * One directory's worth of directories, with the boundary applied.
	 *
	 * The refusals are told apart on purpose. Outside the roots is a 403 and never a
	 * 404: answering "no such directory" for `/etc` would say whether `/etc` exists,
	 * and repeated often enough that is the map. Inside the roots, absence and
	 * unreadability are ordinary answers and are reported as themselves, because the
	 * two are fixed in different places — a typo against a permission or a mount.
	 */
	public async browse(request: BrowseRequest = {}): Promise<DirectoryListing> {
		const allowed = await this._allowedRoots();
		const roots = await resolveRoots(allowed);
		const asked = request.path?.trim() ?? '';
		// Opening on `/` would be correct and useless: the media are several levels
		// down and the first screen would be `bin`, `boot`, `dev`. So a browse with
		// nothing asked for starts where the media are and walks up from there, which
		// is now possible — the starting point and the boundary are different things,
		// and conflating them is what made the picker a dead end.
		const wanted = asked === '' ? (this._startingPoints[0] ?? roots[0] ?? '/') : asked;
		const resolved = await resolveWithinRoots(wanted, allowed);

		if (resolved.verdict === PathVerdict.OUTSIDE) {
			throw new ForbiddenException(ErrorKey.FILESYSTEM_PATH_OUTSIDE_ROOT);
		}

		if (resolved.verdict === PathVerdict.MISSING) {
			throw new NotFoundException(ErrorKey.FILESYSTEM_PATH_NOT_FOUND);
		}

		if (resolved.verdict === PathVerdict.UNREADABLE) {
			throw new ForbiddenException(ErrorKey.FILESYSTEM_PATH_UNREADABLE);
		}

		const scan = await this._filesystem
			.list(resolved.path, { roots, includeHidden: request.includeHidden })
			.catch((error: NodeJS.ErrnoException) => {
				// A path that exists and is not a directory is not a directory that is
				// missing, but it is the same answer to the only question asked here —
				// "show me what is in it" — and it is reached by typing a file name,
				// which is a typo and not a permission problem.
				if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
					throw new NotFoundException(ErrorKey.FILESYSTEM_PATH_NOT_FOUND);
				}

				throw new ForbiddenException(ErrorKey.FILESYSTEM_PATH_UNREADABLE);
			});

		const rights = await this._filesystem.rights(resolved.path);

		return {
			path: resolved.path,
			parent: this._parentWithin(resolved.path, roots),
			readable: rights.readable,
			writable: rights.writable,
			entries: scan.entries,
			truncated: scan.truncated,
			limit: scan.limit,
			roots,
		};
	}

	/**
	 * The directory above, unless it is outside the roots.
	 *
	 * Null is what lets the interface disable going up instead of offering a step that
	 * would be refused: a boundary somebody discovers by being told off is a boundary
	 * they will assume is a bug.
	 */
	private _parentWithin(path: string, roots: readonly string[]): string | null {
		const parent = dirname(path);

		if (parent === path) {
			return null;
		}

		return roots.some((root) => isInside(parent, root)) ? parent : null;
	}
}
