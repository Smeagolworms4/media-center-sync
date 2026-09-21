import { ConnectionRoute } from '@mcs/shared';
import type { DirectoryConnection } from './service-directory.interface';

/**
 * Which kind of path a listed address is.
 *
 * The relay flag wins over the local one: an address carried by the relay is the
 * relay whatever network it claims to be on, and it is the relay's bandwidth cap that
 * decides what a transfer through it costs.
 */
export const routeOf = (connection: DirectoryConnection): ConnectionRoute => {
	if (connection.relay) {
		return ConnectionRoute.RELAY;
	}

	return connection.local ? ConnectionRoute.LOCAL : ConnectionRoute.REMOTE;
};

const ROUTE_RANK: Record<ConnectionRoute, number> = {
	[ConnectionRoute.LOCAL]: 0,
	[ConnectionRoute.REMOTE]: 1,
	[ConnectionRoute.RELAY]: 2,
};

/**
 * The order the addresses of one server are preferred in. Written down because it is
 * the whole decision, and each step of it has a reason:
 *
 * 1. **The local network first.** It is the only path whose speed is the disk's and
 *    the LAN's rather than somebody's upload, and a household gateway is usually on
 *    the same network as its own Plex. An address that is local to the *server* is
 *    not necessarily local to us — a friend's `192.168.1.20` is somebody else's LAN —
 *    which is why every candidate is probed rather than trusted, and why a probe also
 *    checks the server's identity.
 * 2. **Then the direct remote addresses**, the server's own HTTPS name on
 *    `plex.direct` first. These are what a friend's server, or ours reached from
 *    elsewhere, answers on at the speed of its owner's upload.
 * 3. **The relay last, always.** It is carried through the account service's own
 *    infrastructure and capped by it: good enough to browse a catalogue, a crawl for
 *    pulling a film. It is taken only when nothing else answered, and the route is
 *    stored so the interface can say so instead of letting a transfer silently take
 *    all night.
 *
 * Within a step, HTTPS before HTTP: when both answer, the encrypted one costs nothing
 * extra on a LAN and a great deal less to trust across the internet. The sort is
 * stable, so the directory's own order breaks every remaining tie.
 */
export const orderConnections = (connections: readonly DirectoryConnection[]): DirectoryConnection[] =>
	connections
		.map((connection, index) => ({ connection, index }))
		.sort((a, b) =>
			ROUTE_RANK[routeOf(a.connection)] - ROUTE_RANK[routeOf(b.connection)]
			|| Number(b.connection.protocol === 'https') - Number(a.connection.protocol === 'https')
			|| a.index - b.index)
		.map(({ connection }) => connection);
