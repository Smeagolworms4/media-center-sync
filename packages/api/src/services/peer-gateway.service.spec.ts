import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { ErrorKey, PROTOCOL_VERSION, PeerCapability, negotiateProtocol } from '@mcs/shared';
import { WebSocket } from 'ws';
import {
	PEER_LINK_PATH,
	PeerGatewayService,
	PeerMethodKind,
	refuseUnknownUpgrades,
	type PeerLinkAuthority,
	type PeerMethodHandler,
} from './peer-gateway.service';

/** The four headers the outgoing side puts on every upgrade. */
function credentials(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		'x-mcs-fingerprint': 'their-fingerprint',
		'x-mcs-public-key': Buffer.from('-----BEGIN PUBLIC KEY-----').toString('base64'),
		'x-mcs-challenge': `their-fingerprint:${Date.now()}`,
		'x-mcs-signature': 'a-signature',
		...overrides,
	};
}

function hello(overrides: Record<string, unknown> = {}) {
	return {
		nodeId: 'node-sam',
		fingerprint: 'their-fingerprint',
		name: 'Sam',
		protocol: PROTOCOL_VERSION,
		capabilities: [PeerCapability.CONTENT],
		...overrides,
	};
}

describe('PeerGatewayService', () => {
	let server: Server;
	let gateway: PeerGatewayService;
	let authority: jest.Mocked<PeerLinkAuthority>;
	let methods: PeerMethodHandler;
	let call: jest.Mock;
	let stream: jest.Mock;
	let clients: WebSocket[];
	let port: number;

	beforeEach(async () => {
		authority = {
			admit: jest.fn(async () => ({ peerId: 'peer-1', name: 'Sam' })),
			greet: jest.fn(async (_peerId: string, theirs: { protocol: number }, challenge: string) =>
				negotiateProtocol(theirs.protocol) === null
					? null
					: {
						hello: {
							nodeId: 'node-us',
							fingerprint: 'our-fingerprint',
							name: 'Home',
							protocol: PROTOCOL_VERSION,
							capabilities: [PeerCapability.CONTENT, PeerCapability.CATALOGUE],
						},
						publicKey: 'our-key',
						signature: `signed:${challenge}`,
					},
			),
		} as unknown as jest.Mocked<PeerLinkAuthority>;

		call = jest.fn(async () => ({ entries: [] }));
		stream = jest.fn(async () => Readable.from([Buffer.from('some bytes')]));
		methods = {
			kind: (method: string) => {
				if (method === 'catalogue.list') {
					return PeerMethodKind.VALUE;
				}

				return method === 'media.range' ? PeerMethodKind.STREAM : null;
			},
			call: call as unknown as PeerMethodHandler['call'],
			stream: stream as unknown as PeerMethodHandler['stream'],
		};

		clients = [];
		gateway = new PeerGatewayService(authority, methods);
		server = createServer();
		gateway.attach(server);
		refuseUnknownUpgrades(server, [PEER_LINK_PATH]);

		await new Promise<void>((resolve) => server.listen(0, resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		for (const client of clients) {
			client.close();
		}

		gateway.onModuleDestroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	/** A raw client, so that every frame this test sends is the one it means to send. */
	function open(headers = credentials(), path = PEER_LINK_PATH): WebSocket {
		const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });

		clients.push(client);

		return client;
	}

	function opened(client: WebSocket): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			client.once('open', () => resolve());
			client.once('error', reject);
		});
	}

	/** The next text frame, parsed. Binary frames are collected separately. */
	function next(client: WebSocket): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			client.once('message', (data: Buffer, isBinary: boolean) => {
				if (isBinary) {
					resolve({ binary: data });

					return;
				}

				resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
			});
		});
	}

	async function greeted(): Promise<WebSocket> {
		const client = open();

		await opened(client);
		client.send(JSON.stringify({ id: 1, method: 'peer.hello', params: { challenge: 'c', hello: hello() } }));
		await next(client);

		return client;
	}

	describe('the upgrade', () => {
		it('refuses a socket that presents no credential', async () => {
			await expect(opened(open({}))).rejects.toThrow('401');
		});

		it('refuses a socket the authority does not recognise', async () => {
			authority.admit.mockResolvedValue(null);

			await expect(opened(open())).rejects.toThrow('401');
		});

		it('hands the authority what the far end presented, key decoded', async () => {
			await opened(open());

			expect(authority.admit).toHaveBeenCalledWith(
				expect.objectContaining({
					fingerprint: 'their-fingerprint',
					publicKey: '-----BEGIN PUBLIC KEY-----',
					signature: 'a-signature',
				}),
			);
		});

		it('refuses an upgrade to a path nobody claims rather than leaving it open', async () => {
			// Both gateways return rather than reject when the path is not theirs, so
			// without the last handler this socket would sit half open until a timeout.
			await expect(opened(open(credentials(), '/api/nothing'))).rejects.toThrow('404');
		});
	});

	describe('the handshake', () => {
		it('answers a hello with ours, signed with their challenge', async () => {
			const client = open();

			await opened(client);
			client.send(
				JSON.stringify({ id: 7, method: 'peer.hello', params: { challenge: 'c-1', hello: hello() } }),
			);

			expect(await next(client)).toEqual({
				id: 7,
				result: {
					hello: expect.objectContaining({ protocol: PROTOCOL_VERSION }),
					publicKey: 'our-key',
					signature: 'signed:c-1',
				},
			});
			expect(gateway.sessionCount).toBe(1);
		});

		it('refuses a version it does not speak, and closes the link', async () => {
			const client = open();

			await opened(client);
			client.send(
				JSON.stringify({
					id: 1,
					method: 'peer.hello',
					params: { challenge: 'c', hello: hello({ protocol: PROTOCOL_VERSION + 41 }) },
				}),
			);

			expect(await next(client)).toEqual({ id: 1, error: ErrorKey.PEER_PROTOCOL_UNSUPPORTED });
			await new Promise<void>((resolve) => client.once('close', () => resolve()));
		});

		it('serves nothing before the hello', async () => {
			// A socket through the upgrade that could read the catalogue without agreeing
			// on a version would meet its first incompatibility somewhere else entirely.
			const client = open();

			await opened(client);
			client.send(JSON.stringify({ id: 1, method: 'catalogue.list', params: {} }));

			expect(await next(client)).toEqual({ id: 1, error: ErrorKey.PEER_REJECTED });
			expect(call).not.toHaveBeenCalled();
		});

		it('ignores a field in the hello it has never heard of', async () => {
			const client = open();

			await opened(client);
			client.send(
				JSON.stringify({
					id: 1,
					method: 'peer.hello',
					params: {
						challenge: 'c',
						hello: hello({ tomorrowsField: [1, 2, 3] }),
						alsoNew: true,
					},
				}),
			);

			expect(await next(client)).toMatchObject({ id: 1, result: expect.any(Object) });
			expect(authority.greet).toHaveBeenCalledWith(
				'peer-1',
				expect.objectContaining({ nodeId: 'node-sam', protocol: PROTOCOL_VERSION }),
				'c',
			);
			// Dropped on the way in rather than carried around as an unknown quantity.
			expect(authority.greet.mock.calls[0][1]).not.toHaveProperty('tomorrowsField');
		});
	});

	describe('once linked', () => {
		it('answers a method it knows', async () => {
			const client = await greeted();

			client.send(JSON.stringify({ id: 2, method: 'catalogue.list', params: { page: 1 } }));

			expect(await next(client)).toEqual({ id: 2, result: { entries: [] } });
			expect(call).toHaveBeenCalledWith('peer-1', 'catalogue.list', { page: 1 });
		});

		it('answers "not supported" to a method it does not know, and stays open', async () => {
			const client = await greeted();

			client.send(JSON.stringify({ id: 2, method: 'media.thumbnail', params: {} }));

			expect(await next(client)).toEqual({ id: 2, error: ErrorKey.PEER_METHOD_UNSUPPORTED });

			// The point of the rule: the link is still usable afterwards, so one side can
			// gain a method without the other being updated first.
			expect(client.readyState).toBe(WebSocket.OPEN);
			client.send(JSON.stringify({ id: 3, method: 'catalogue.list', params: {} }));
			expect(await next(client)).toEqual({ id: 3, result: { entries: [] } });
		});

		it('frames a byte answer with the identifier that asked for it', async () => {
			const client = await greeted();
			const frames: Buffer[] = [];

			client.on('message', (data: Buffer, isBinary: boolean) => {
				if (isBinary) {
					frames.push(data);
				}
			});

			client.send(JSON.stringify({ id: 9, method: 'media.range', params: { start: 0, end: 9 } }));

			// Only an explicit end closes a byte stream: one that simply stopped is
			// indistinguishable from a complete one.
			await new Promise<void>((resolve) => {
				client.on('message', (data: Buffer, isBinary: boolean) => {
					if (!isBinary && (JSON.parse(data.toString('utf8')) as { end?: boolean }).end) {
						resolve();
					}
				});
			});

			expect(frames).toHaveLength(1);
			expect(frames[0].readUInt32BE(0)).toBe(9);
			expect(frames[0].subarray(4).toString('utf8')).toBe('some bytes');
		});

		it('answers the error key behind a refusal, not a stack trace', async () => {
			const client = await greeted();

			call.mockRejectedValue({ getResponse: () => ({ key: ErrorKey.MEDIA_NOT_FOUND }) });
			client.send(JSON.stringify({ id: 4, method: 'catalogue.list', params: {} }));

			expect(await next(client)).toEqual({ id: 4, error: ErrorKey.MEDIA_NOT_FOUND });
		});

		it('drops a frame it cannot read instead of the link', async () => {
			const client = await greeted();

			client.send('not json at all');
			client.send(JSON.stringify({ method: 'catalogue.list' }));
			client.send(JSON.stringify({ id: 5, method: 'catalogue.list', params: {} }));

			expect(await next(client)).toEqual({ id: 5, result: { entries: [] } });
		});

		it('forgets a session when its socket closes', async () => {
			const client = await greeted();

			expect(gateway.linkedPeerIds).toEqual(['peer-1']);
			client.close();
			await new Promise<void>((resolve) => client.once('close', () => resolve()));
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(gateway.sessionCount).toBe(0);
		});
	});

	describe('with nothing bound to answer', () => {
		it('refuses every upgrade when no authority is registered', async () => {
			const bare = new PeerGatewayService();
			const other = createServer();

			bare.attach(other);
			await new Promise<void>((resolve) => other.listen(0, resolve));

			const address = (other.address() as AddressInfo).port;
			const client = new WebSocket(`ws://127.0.0.1:${address}${PEER_LINK_PATH}`, {
				headers: credentials(),
			});

			clients.push(client);
			await expect(opened(client)).rejects.toThrow('503');

			bare.onModuleDestroy();
			await new Promise<void>((resolve) => other.close(() => resolve()));
		});
	});
});
