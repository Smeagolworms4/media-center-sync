import type { MediaGroupSource } from '@mcs/shared';
import { MediaOrigin, PeerTrust } from '@mcs/shared';
import { usePeersStore } from '@/stores/peers';

/**
 * Where a copy comes from, drawn so the shape alone tells them apart.
 *
 * The four are the terms people actually think in — mine, a server I registered,
 * a friend, a friend of a friend — and the last two are the pair that matters
 * most: a friend of a friend is somebody nobody in this house has ever agreed to,
 * and a screen that draws them identically is one where that distinction cannot be
 * made at a glance. So the icons are not four shades of the same cloud: one disk,
 * one server, one person, two people.
 */
export const MEDIA_ORIGIN_ICON: Record<MediaOrigin, string> = {
	[MediaOrigin.LOCAL]: 'mdi-harddisk',
	[MediaOrigin.DIRECT]: 'mdi-server-network',
	[MediaOrigin.FRIEND]: 'mdi-account-outline',
	[MediaOrigin.FRIEND_OF_FRIEND]: 'mdi-account-multiple-outline',
};

export interface MediaOriginDescriptor {
	origin: MediaOrigin;
	icon: string;
	/** i18n key of the short label, the one a chip and a mark carry. */
	labelKey: string;
	/** i18n key of the sentence a tooltip explains it with. */
	helpKey: string;
}

export function describeMediaOrigin (origin: MediaOrigin): MediaOriginDescriptor {
	return {
		origin,
		icon: MEDIA_ORIGIN_ICON[origin],
		labelKey: `media.origin.${origin}`,
		helpKey: `media.origin_help.${origin}`,
	};
}

/** The order the filter offers them in: closest to us first. */
export const MEDIA_ORIGINS: MediaOrigin[] = [
	MediaOrigin.LOCAL,
	MediaOrigin.DIRECT,
	MediaOrigin.FRIEND,
	MediaOrigin.FRIEND_OF_FRIEND,
];

/**
 * One place decides where a copy comes from.
 *
 * The API answers the same question for the filter — `MediaGroupQuery.origins` —
 * and a source carries everything needed to answer it again here: ours when the
 * gateway can write into it, direct when no peer is involved, and otherwise
 * whatever the peer's own trust says. Reading it from the peer rather than
 * guessing is the only way `friend_of_friend` can appear at all: a source names
 * its peer and nothing else, and the distance is a property of the link.
 *
 * A peer this browser has not loaded yet answers `null` rather than `friend`.
 * Calling an unknown link a friend is precisely the mistake the distinction exists
 * to prevent, and "through a gateway we cannot name" is a thing a mark can say.
 */
export function useMediaOrigin () {
	const peersStore = usePeersStore();

	function originOf (source: MediaGroupSource): MediaOrigin | null {
		if (source.local) {
			return MediaOrigin.LOCAL;
		}
		if (source.peerId === null) {
			return MediaOrigin.DIRECT;
		}
		const peer = peersStore.byId[source.peerId];
		if (!peer) {
			return null;
		}
		return peer.trust === PeerTrust.FRIEND_OF_FRIEND
			? MediaOrigin.FRIEND_OF_FRIEND
			: MediaOrigin.FRIEND;
	}

	return { originOf, describeMediaOrigin, MEDIA_ORIGIN_ICON, MEDIA_ORIGINS };
}
