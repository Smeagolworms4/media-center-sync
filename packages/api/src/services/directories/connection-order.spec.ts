import { ConnectionRoute } from '@mcs/shared';
import { orderConnections, routeOf } from './connection-order';
import type { DirectoryConnection } from './service-directory.interface';

const connection = (uri: string, overrides: Partial<DirectoryConnection> = {}): DirectoryConnection => ({
	uri,
	local: false,
	relay: false,
	protocol: uri.startsWith('https:') ? 'https' : 'http',
	...overrides,
});

describe('connection order', () => {
	it('prefers the local network, then the direct remote addresses, and the relay last', () => {
		const relay = connection('https://1-2-3-4.hash.plex.direct:8443', { relay: true });
		const remote = connection('https://82-1-2-3.hash.plex.direct:32400');
		const local = connection('http://192.168.1.20:32400', { local: true });

		// Listed in the worst order on purpose: plex.tv makes no promise about its own.
		expect(orderConnections([relay, remote, local])).toEqual([local, remote, relay]);
	});

	it('tries HTTPS before HTTP within the same kind of path', () => {
		const plain = connection('http://82.1.2.3:32400');
		const secure = connection('https://82-1-2-3.hash.plex.direct:32400');
		const localPlain = connection('http://192.168.1.20:32400', { local: true });
		const localSecure = connection('https://192-168-1-20.hash.plex.direct:32400', { local: true });

		expect(orderConnections([plain, localPlain, secure, localSecure]))
			.toEqual([localSecure, localPlain, secure, plain]);
	});

	it('keeps the directory’s own order where nothing else separates two addresses', () => {
		const first = connection('https://a.plex.direct:32400');
		const second = connection('https://b.plex.direct:32400');

		expect(orderConnections([first, second])).toEqual([first, second]);
		expect(orderConnections([second, first])).toEqual([second, first]);
	});

	it('names a relayed address the relay even when it claims to be local', () => {
		// The relay's bandwidth cap is what a transfer through it pays, whatever
		// network the address says it is on.
		expect(routeOf(connection('https://x.plex.direct:8443', { relay: true, local: true })))
			.toBe(ConnectionRoute.RELAY);
		expect(routeOf(connection('http://192.168.1.20:32400', { local: true }))).toBe(ConnectionRoute.LOCAL);
		expect(routeOf(connection('https://x.plex.direct:32400'))).toBe(ConnectionRoute.REMOTE);
	});

	it('does not reorder the list it was given', () => {
		const list = [connection('https://r.plex.direct:8443', { relay: true }), connection('http://10.0.0.2:32400', { local: true })];
		const copy = [...list];

		orderConnections(list);

		expect(list).toEqual(copy);
	});
});
