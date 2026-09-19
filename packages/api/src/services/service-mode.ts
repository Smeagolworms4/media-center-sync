import { MediaServiceMode, MediaServiceScope } from '@mcs/shared';

/**
 * Which of the three kinds a registered service is.
 *
 * Derived rather than stored, because it is a reading of two fields that are already
 * the truth — storing it would make a third place that can disagree with them.
 *
 * The peer test comes first and overrules the scope, and that order is the whole
 * point. A service reached through a peer belongs to somebody else's machine however
 * its scope reads: we cannot write into their disk, so treating it as local would
 * plan a transfer onto a path that does not exist here, and the failure would arrive
 * at the end of a completed download.
 */
export const serviceMode = (service: {
	scope: MediaServiceScope;
	peerId: string | null;
}): MediaServiceMode => {
	if (service.peerId !== null && service.peerId !== undefined) {
		return MediaServiceMode.PEER;
	}

	return service.scope === MediaServiceScope.LOCAL
		? MediaServiceMode.LOCAL
		: MediaServiceMode.REMOTE;
};
