import { join } from 'node:path';

/** The parts of a library this mapping needs, so a caller can pass a row or a fake. */
export interface PathMappedLibrary {
	/** Roots as the media service reports them — its own, not ours. */
	paths: string[];
	/** Where the gateway can reach the same files, when somebody has told us. */
	localPath: string | null;
}

/**
 * The path as the gateway sees it, from the path a service reported.
 *
 * The two differ as soon as the service runs in its own container: Jellyfin says
 * `/media/Shows/…` and the gateway sees `/mnt/nas/Shows/…`. Every use of a reported
 * path outside the service that reported it has to go through here — reading a file to
 * fingerprint it, and looking at how a library files its shows before putting something
 * new in it. Skipping the translation does not fail loudly; it silently decides that
 * the gateway holds nothing at that path, and the feature that depended on it just
 * stops happening.
 *
 * Only a root the library actually declares is rewritten. Anything else yields null,
 * because a prefix guessed here is a read outside the library.
 */
export const toLocalPath = (library: PathMappedLibrary, reported: string | null): string | null => {
	if (reported === null || reported === '' || library.localPath === null || library.localPath === '') {
		return null;
	}

	for (const root of library.paths) {
		if (reported === root) {
			return library.localPath;
		}

		if (reported.startsWith(`${root}/`)) {
			return join(library.localPath, reported.slice(root.length));
		}
	}

	return null;
};

/** A service's statement about where its own root is, as the gateway reaches it. */
export interface ServiceRootMapping {
	/** The prefix the service reports, in its own filesystem. */
	remoteRoot: string | null;
	/** The same directory, in ours. */
	localRoot: string | null;
}

/** Trailing separators say nothing about a directory and break every prefix test. */
const withoutTrailingSlash = (path: string): string => path.trim().replace(/\/+$/, '');

/**
 * Where a library's files are for us, worked out from its service's root mapping.
 *
 * This is what a service states once instead of every library stating it again. A
 * server with six libraries was six paths to type and six chances to get one wrong,
 * and a library whose two paths do not designate the same directory accepts transfers
 * the media server never sees, with nothing anywhere reporting an error.
 *
 * Null whenever the mapping cannot answer: no roots stated, no reported path, or a
 * path that does not sit under `remoteRoot`. A null is the caller's signal to fall
 * back to what somebody typed, and it is deliberately preferred to a guess — a
 * rewritten prefix that was never declared points the gateway at a directory nobody
 * chose, which is the failure this whole mapping exists to prevent.
 *
 * Only the first reported path that the mapping can answer for is used. A library
 * declaring several roots is declaring several places its own service reads from, and
 * a gateway has one directory to write into; taking the first keeps the answer stable
 * across scans, where picking "the best" would depend on the order the service listed
 * them in.
 */
export const derivedLocalPath = (
	reported: readonly string[],
	mapping: ServiceRootMapping,
): string | null => {
	if (mapping.remoteRoot === null || mapping.localRoot === null) {
		return null;
	}

	const from = withoutTrailingSlash(mapping.remoteRoot);
	const to = withoutTrailingSlash(mapping.localRoot);

	if (from === '' || to === '') {
		return null;
	}

	for (const entry of reported) {
		const path = withoutTrailingSlash(entry);

		if (path === from) {
			// The library is the root itself, which is the ordinary case for a service
			// whose whole media directory is one library.
			return to;
		}

		if (path.startsWith(`${from}/`)) {
			return join(to, path.slice(from.length));
		}
	}

	return null;
};
