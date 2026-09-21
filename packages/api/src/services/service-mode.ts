import { MediaServiceMode } from '@mcs/shared';

/** The parts of a library this derivation reads, so a caller can pass a row or a fake. */
export interface MountedLibrary {
	/** Where the gateway reaches this library's files, when anybody has said. */
	localPath: string | null;
}

/** The parts of a service this derivation reads. */
export interface MountedService {
	/** Where the service's disks are, as this gateway reaches them. */
	rootMappings: readonly unknown[];
}

/**
 * Whether the gateway reaches this service's files on disk.
 *
 * The fact behind `MediaService.filesMounted`, kept pure so the derivation can be
 * tested on its own and so the two places that write the column cannot drift apart.
 *
 * Two ways a mapping can exist, and either is enough. A mapping stated on the service
 * is the ordinary one, and it answers before any library has been scanned — a service
 * registered with its mappings is a destination immediately rather than after its
 * first scan. A library with a path of its own is the exception the mappings cannot
 * express, and a service that has only those is just as mounted as one with a mapping.
 *
 * Any mapping at all counts, including one no library sits under yet. That is a
 * declaration that this gateway reaches that server's disk, and the library the server
 * adds there tomorrow derives its path at the next probe; a service that turned remote
 * until then would drop out of the destinations in between for no reason anybody set.
 *
 * Deliberately **not** a filesystem probe. A mapping is a declaration and a disk is a
 * state: a NAS that goes down for ten minutes must not turn the service remote, drop
 * its libraries out of `LibraryManager.check()` and take with them the one screen that
 * would have said the path is unreachable. What is on disk right now is that check's
 * question, not this one's.
 */
export const reachesFiles = (
	service: MountedService,
	libraries: readonly MountedLibrary[],
): boolean => {
	if (service.rootMappings.length > 0) {
		return true;
	}

	return libraries.some(
		(library) => library.localPath !== null && library.localPath !== '',
	);
};

/**
 * Which of the three kinds a registered service is.
 *
 * Pure and synchronous, and that is a constraint rather than a happy accident: this
 * is read by the destination list, the share resolution, the library check and the
 * services screen's banding, all of which hold whole collections of services in hand.
 * Making it async — or letting it probe a path — would turn every one of those into an
 * await inside a loop and a burst of `stat` calls per page render. So the one fact it
 * needs that is not on the row by nature, whether the files are reachable, is derived
 * once by `reachesFiles` and stored as `filesMounted`.
 *
 * The peer test comes first and overrules everything, and that order is the whole
 * point. A service reached through a peer belongs to somebody else's machine however
 * its row reads: we cannot write into their disk, so treating it as local would plan a
 * transfer onto a path that does not exist here, and the failure would arrive at the
 * end of a completed download.
 *
 * Nothing here reads whether the service is shared. Sharing is a decision somebody
 * made and this is a fact about the mounts; the two were one field once, and the cost
 * was that somebody who answered "remote" because their server is on the far side of
 * the house found its libraries private, the server refused as a destination, and no
 * screen connecting either to the word they had chosen.
 */
export const serviceMode = (service: {
	filesMounted: boolean;
	peerId: string | null;
}): MediaServiceMode => {
	if (service.peerId !== null && service.peerId !== undefined) {
		return MediaServiceMode.PEER;
	}

	return service.filesMounted ? MediaServiceMode.LOCAL : MediaServiceMode.REMOTE;
};
