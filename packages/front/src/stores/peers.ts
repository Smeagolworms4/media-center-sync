import type {
	AcceptPeerInviteRequest,
	MediaService,
	Peer,
	PeerIdentity,
	PeerInvite,
} from '@mcs/shared';
import { EventName } from '@mcs/shared';
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
			peers.value.splice(index, 1, peer);
		}
	}

	async function load (): Promise<Peer[]> {
		loading.value = true;
		error.value = null;
		try {
			peers.value = await caller('api').get<Peer[]>('/peers', { keepLastKey: 'peers|list' });
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

	async function remove (id: string): Promise<void> {
		await caller('api').delete(`/peers/${id}`);
		peers.value = peers.value.filter(one => one.id !== id);
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
			peer.linkMode = payload.linkMode;
			peer.lastSeenAt = payload.lastSeenAt;
		}
	});

	return {
		peers,
		identity,
		loading,
		loaded,
		error,
		byId,
		load,
		loadIdentity,
		get,
		invite,
		accept,
		rename,
		remove,
		block,
		unblock,
		connect,
		services,
	};
});
