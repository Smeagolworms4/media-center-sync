import type {
	AcceptPeerInviteRequest,
	AddPeerRequest,
	BannedPeer,
	MediaService,
	Peer,
	PeerIdentity,
	PeerInvite,
} from '@mcs/shared';
import { EventName, PeerStatus } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useEvents } from '@/hooks/useEvents';

/**
 * The linked gateways, and our own identity as they see it.
 *
 * A peer is identified by its fingerprint, never by its address, so a friend
 * behind a dynamic address is still the same friend tomorrow; the address the
 * list shows is informational and changes under it without meaning anything.
 */
export const usePeersStore = defineStore('peers', () => {
	const { caller } = useCaller();
	const events = useEvents();

	const peers = ref<Peer[]>([]);
	/**
	 * Fingerprints this gateway refuses, which outlive the peer rows they came from.
	 *
	 * Held separately because that is what they are: a ban survives the removal of
	 * the peer, so it cannot be a flag on a row that no longer exists.
	 */
	const bans = ref<BannedPeer[]>([]);
	const identity = ref<PeerIdentity | null>(null);
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	const byId = computed(() => {
		const map: Record<string, Peer> = {};
		for (const peer of peers.value) {
			map[peer.id] = peer;
		}
		return map;
	});

	function replace (peer: Peer): void {
		const index = peers.value.findIndex(one => one.id === peer.id);
		if (index === -1) {
			peers.value = [...peers.value, peer];
		} else {
			peers.value[index] = peer;
		}
	}

	async function load (): Promise<Peer[]> {
		loading.value = true;
		error.value = null;
		try {
			const loadedList = await caller('api').get<Peer[]>('/peers', { keepLastKey: 'peers|list' });
			// An empty body parses to `null`, and a gateway that answers nothing must
			// not leave a page rendering a list that is not one.
			peers.value = Array.isArray(loadedList) ? loadedList : [];
			loaded.value = true;
			return peers.value;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	async function loadIdentity (): Promise<PeerIdentity> {
		identity.value = await caller('api').get<PeerIdentity>('/peers/identity');
		return identity.value;
	}

	async function get (id: string): Promise<Peer> {
		const peer = await caller('api').get<Peer>(`/peers/${id}`);
		replace(peer);
		return peer;
	}

	/**
	 * Linking by fingerprint, which is the honest shape of what a link is: each side
	 * knows the other's public key and has said once that it trusts it. Nothing
	 * secret travels, nothing expires, and the far end sees who is asking before
	 * agreeing to anything. The invitation below does the same job in one code.
	 */
	async function add (request: AddPeerRequest): Promise<Peer> {
		const peer = await caller('api').post<Peer>('/peers', request);
		replace(peer);
		return peer;
	}

	/** Saying yes to a request somebody else made of us. */
	async function approve (id: string): Promise<Peer> {
		const peer = await caller('api').post<Peer>(`/peers/${id}/approve`);
		replace(peer);
		return peer;
	}

	/** One-shot, and it expires: an invitation that never did would be a credential. */
	function invite (): Promise<PeerInvite> {
		return caller('api').post<PeerInvite>('/peers/invites', {});
	}

	async function accept (request: AcceptPeerInviteRequest): Promise<Peer> {
		const peer = await caller('api').post<Peer>('/peers/accept', request);
		replace(peer);
		return peer;
	}

	async function rename (id: string, name: string): Promise<Peer> {
		const peer = await caller('api').patch<Peer>(`/peers/${id}`, { name });
		replace(peer);
		return peer;
	}

	/**
	 * Unlink, optionally refusing the key for good.
	 *
	 * The ban rides on the removal rather than being a second action, because that is
	 * where the decision is made: somebody ejecting a peer is deciding whether they
	 * may come back, and asking again on another screen is asking them to remember.
	 */
	async function remove (id: string, options: { ban?: boolean; reason?: string } = {}): Promise<void> {
		await caller('api').delete(`/peers/${id}`, { body: options });
		peers.value = peers.value.filter(one => one.id !== id);
		if (options.ban) {
			await loadBans();
		}
	}

	async function loadBans (): Promise<BannedPeer[]> {
		const loadedBans = await caller('api').get<BannedPeer[]>('/peers/bans', { keepLastKey: 'peers|bans' });
		bans.value = Array.isArray(loadedBans) ? loadedBans : [];
		return bans.value;
	}

	/**
	 * Refuse a peer for good, and unlink them.
	 *
	 * Unlike blocking, which is a reversible status on a row that stays: this survives
	 * the row, so the same key cannot return through a request, an invitation or an
	 * introduction by a friend.
	 */
	async function ban (id: string, reason?: string): Promise<BannedPeer> {
		const banned = await caller('api').post<BannedPeer>(`/peers/${id}/ban`, { reason });
		peers.value = peers.value.filter(one => one.id !== id);
		bans.value = [banned, ...bans.value.filter(one => one.fingerprint !== banned.fingerprint)];
		return banned;
	}

	/** Refuse a key nobody ever linked to — being told about one before it asks. */
	async function banFingerprint (fingerprint: string, extra: { name?: string; reason?: string } = {}): Promise<BannedPeer> {
		const banned = await caller('api').post<BannedPeer>('/peers/bans', { fingerprint, ...extra });
		bans.value = [banned, ...bans.value.filter(one => one.fingerprint !== banned.fingerprint)];
		return banned;
	}

	/** Lifting a ban re-links nobody: the key is merely allowed to ask again. */
	async function unban (fingerprint: string): Promise<void> {
		await caller('api').delete(`/peers/bans/${encodeURIComponent(fingerprint)}`);
		bans.value = bans.value.filter(one => one.fingerprint !== fingerprint);
	}

	/**
	 * How far introductions through one peer may travel.
	 *
	 * Null puts them back on the gateway's own ceiling, which is what clearing the box
	 * means — not a limit of zero, and not whatever number happened to be the default
	 * the day it was set.
	 */
	async function setMaxDepth (id: string, maxDepth: number | null): Promise<Peer> {
		const peer = await caller('api').patch<Peer>(`/peers/${id}/max-depth`, { maxDepth });
		replace(peer);
		return peer;
	}

	async function block (id: string): Promise<Peer> {
		const peer = await caller('api').post<Peer>(`/peers/${id}/block`);
		replace(peer);
		return peer;
	}

	async function unblock (id: string): Promise<Peer> {
		const peer = await caller('api').post<Peer>(`/peers/${id}/unblock`);
		replace(peer);
		return peer;
	}

	async function connect (id: string): Promise<Peer> {
		const peer = await caller('api').post<Peer>(`/peers/${id}/connect`);
		replace(peer);
		return peer;
	}

	function services (id: string): Promise<MediaService[]> {
		return caller('api').get<MediaService[]>(`/peers/${id}/services`);
	}

	events.on(EventName.PEER_STATUS, payload => {
		const peer = peers.value.find(one => one.id === payload.id);
		if (peer) {
			peer.status = payload.status;
			// A settled link has no direction any more; leaving the old one on the row
			// keeps an accepted request looking like one still waiting for an answer.
			if (payload.status !== PeerStatus.PENDING) {
				peer.direction = null;
			}
			peer.linkMode = payload.linkMode;
			peer.lastSeenAt = payload.lastSeenAt;
		}
	});

	return {
		peers,
		bans,
		identity,
		loading,
		loaded,
		error,
		byId,
		load,
		loadIdentity,
		get,
		add,
		approve,
		invite,
		accept,
		rename,
		remove,
		loadBans,
		ban,
		banFingerprint,
		unban,
		setMaxDepth,
		block,
		unblock,
		connect,
		services,
	};
});
