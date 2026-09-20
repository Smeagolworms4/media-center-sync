import { dirname } from 'node:path';
import { ErrorKey, type DirectoryListing } from '@mcs/shared';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MediaConfig } from '@/config';
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
 * spelling it is the cheapest fix there is — but a browser over the host's filesystem
 * is also the easiest way to hand out a map of it, so the boundary below is the rule
 * this manager exists to apply.
 */

/**
 * The configured roots a browse may reach, and the only ones.
 *
 * `media.root` (`MCS_MEDIA_ROOT`) is where the libraries are mounted and
 * `media.transferRoot` is where incomplete transfers accumulate: between them they
 * are every directory a local path can legitimately name. Named here, as keys into
 * the media configuration, so that widening the browser is one visible edit in one
 * file rather than a second root quietly appearing at a call site — and so that the
 * listing code never has the whole configuration in reach at all.
 */
const ALLOWED_ROOT_KEYS = ['root', 'transferRoot'] as const satisfies readonly (keyof MediaConfig)[];

export interface BrowseRequest {
	/** Empty or absent starts at the first allowed root. */
	path?: string;
	includeHidden?: boolean;
}

@Injectable()
export class FilesystemManager {
	private readonly _roots: readonly string[];

	public constructor(
		config: ConfigService,
		private readonly _filesystem: FilesystemService,
	) {
		const media = config.getOrThrow<MediaConfig>('media');

		this._roots = ALLOWED_ROOT_KEYS.map((key) => media[key]).filter((root) => root !== '');
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
		const roots = await resolveRoots(this._roots);
		const asked = request.path?.trim() ?? '';
		const wanted = asked === '' ? (roots[0] ?? '/') : asked;
		const resolved = await resolveWithinRoots(wanted, this._roots);

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
