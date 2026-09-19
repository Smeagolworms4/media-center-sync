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
