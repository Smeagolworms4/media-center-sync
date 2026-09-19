import { createPrivateKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerLinkMode } from '@mcs/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { PeerLinkService, type PeerDescriptor } from './peer-link.service';
import { RendezvousClient } from './rendezvous.client';

/** A second gateway, standing in for the friend at the other end. */
function farEnd() {
	const pair = generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});

	return {
		...pair,
		sign: (payload: string) =>
			signBytes(null, Buffer.from(payload), createPrivateKey(pair.privateKey)).toString('base64'),
	};
}

describe('PeerLinkService', () => {
	let directory: string;
	let service: PeerLinkService;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcs-peer-'));
		process.env.PEER_KEY_PATH = join(directory, 'identity.pem');
		delete process.env.PEER_PUBLIC_ADDRESS;

		service = new PeerLinkService(new RendezvousClient());
	});

	afterEach(async () => {
		service.onModuleDestroy();
		delete process.env.PEER_KEY_PATH;
		await rm(directory, { recursive: true, force: true });
	});

	describe('identity', () => {
		it('generates a key pair and a fingerprint on first start', () => {
			expect(service.fingerprint).toHaveLength(64);
			expect(service.publicKey).toContain('BEGIN PUBLIC KEY');
		});

		it('keeps the same fingerprint across a restart', () => {
			// A fingerprint that changes on restart looks exactly like an impersonation
			// attempt to every friend we have.
			expect(new PeerLinkService(new RendezvousClient()).fingerprint).toBe(service.fingerprint);
		});

		it('derives a fingerprint from a public key, not from the key itself', () => {
			expect(service.fingerprintOf(service.publicKey)).toBe(service.fingerprint);
		});

		it('signs what it can verify', () => {
			const signature = service.sign('a challenge');

			expect(service.verify(service.publicKey, 'a challenge', signature)).toBe(true);
			expect(service.verify(service.publicKey, 'another challenge', signature)).toBe(false);
		});

		it('treats a malformed key or signature as a failed verification', () => {
			// Not as an exception to handle three layers up.
			expect(service.verify('not a key', 'payload', 'signature')).toBe(false);
			expect(service.verify(service.publicKey, 'payload', 'not base64 either')).toBe(false);
		});

		it('describes itself for the peers screen', () => {
			expect(service.identity('Home', 'https://meet.example.org')).toEqual({
				nodeId: service.nodeId,
				fingerprint: service.fingerprint,
				name: 'Home',
				rendezvous: 'https://meet.example.org',
				directAddress: null,
				directReachable: false,
			});
		});

		it('keeps its node identity separate from its key', () => {
			// A rotated key does not make a gateway a different participant, and the
			// identifier that stops announcements circling has to survive that.
			expect(service.nodeId).toEqual(expect.any(String));
			expect(service.nodeId).not.toBe(service.fingerprint);
		});

		it('says it is directly reachable when an address is configured', () => {
			process.env.PEER_PUBLIC_ADDRESS = '203.0.113.7:7443';

			expect(service.identity('Home', null)).toMatchObject({
				directAddress: '203.0.113.7:7443',
				directReachable: true,
				rendezvous: '',
			});
		});
	});

	describe('without a link', () => {
		it('says nothing is linked', () => {
			expect(service.isLinked('peer-1')).toBe(false);
			expect(service.state('peer-1')).toBeNull();
		});

		it('refuses a request with a key the interface can act on', async () => {
			await expect(service.request('peer-1', 'catalogue.list')).rejects.toMatchObject({
				response: { key: 'error.peer.unreachable' },
			});
		});

		it('tolerates being told to disconnect something it never held', () => {
			expect(() => service.disconnect('peer-1')).not.toThrow();
		});

		it('refuses to connect with no address and no rendezvous', async () => {
			await expect(
				service.connect(
					{ id: 'p', name: 'Sam', fingerprint: 'abc', address: null, publicKey: null },
					null,
				),
			).rejects.toMatchObject({ response: { key: 'error.peer.unreachable' } });
		});
	});

	describe('over a real socket', () => {
		let server: Server;
		let sockets: WebSocketServer;
		let remote: ReturnType<typeof farEnd>;
		let peer: PeerDescriptor;
		let respondWithWrongFingerprint = false;

		beforeEach(async () => {
			remote = farEnd();
			respondWithWrongFingerprint = false;
			server = createServer();
			sockets = new WebSocketServer({ server, path: '/api/peer' });

			sockets.on('connection', (socket: WebSocket) => {
				socket.on('message', (raw: Buffer) => {
					const message = JSON.parse(raw.toString('utf8')) as {
						id: number;
						method: string;
						params: { challenge?: string };
					};

					if (message.method === 'peer.hello') {
						const challenge = message.params.challenge ?? '';

						socket.send(
							JSON.stringify({
								id: message.id,
								result: {
									fingerprint: respondWithWrongFingerprint
										? 'a-different-fingerprint'
										: service.fingerprintOf(remote.publicKey),
									publicKey: remote.publicKey,
									signature: remote.sign(challenge),
								},
							}),
						);

						return;
					}

					if (message.method === 'media.range') {
						// Binary frames carry the request identifier so several ranges can
						// share one socket.
						const header = Buffer.alloc(4);

						header.writeUInt32BE(message.id, 0);
						socket.send(Buffer.concat([header, Buffer.from('some bytes')]), {
							binary: true,
						});
						socket.send(JSON.stringify({ id: message.id, end: true }));

						return;
					}

					if (message.method === 'fails') {
						socket.send(JSON.stringify({ id: message.id, error: 'nope' }));

						return;
					}

					socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }));
				});
			});

			await new Promise<void>((resolve) => server.listen(0, resolve));

			const { port } = server.address() as AddressInfo;

			peer = {
				id: 'peer-1',
				name: 'Sam',
				fingerprint: service.fingerprintOf(remote.publicKey),
				address: `ws://127.0.0.1:${port}/api/peer`,
				publicKey: remote.publicKey,
			};
		});

		afterEach(async () => {
			service.onModuleDestroy();
			sockets.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it('links directly and records the mode', async () => {
			const state = await service.connect(peer, null);

			expect(state).toMatchObject({
				peerId: 'peer-1',
				mode: PeerLinkMode.DIRECT,
				connected: true,
			});
			expect(service.isLinked('peer-1')).toBe(true);
		});

		it('reuses a link it already holds', async () => {
			const first = await service.connect(peer, null);
			const second = await service.connect(peer, null);

			expect(second.since).toBe(first.since);
		});

		it('drops a far end that cannot prove it holds the key', async () => {
			// The rendezvous chooses the address, so a dishonest one can send us to a
			// machine of its choosing. That machine has to prove itself, and cannot.
			respondWithWrongFingerprint = true;

			await expect(service.connect(peer, null)).rejects.toMatchObject({
				response: { key: 'error.peer.rejected' },
			});
			expect(service.isLinked('peer-1')).toBe(false);
		});

		it('carries a request and its answer', async () => {
			await service.connect(peer, null);

			expect(await service.request('peer-1', 'catalogue.list')).toEqual({
				echoed: 'catalogue.list',
			});
		});

		it('rejects a request the far end refused', async () => {
			await service.connect(peer, null);

			await expect(service.request('peer-1', 'fails')).rejects.toThrow('nope');
		});

		it('streams bytes and ends only when the far end says so', async () => {
			// A stream that ended because the socket went quiet is indistinguishable from
			// a complete one, and that is how a truncated chunk passes for a finished one.
			await service.connect(peer, null);

			const stream = await service.openStream('peer-1', 'media.range', { start: 0, end: 9 });
			const chunks: Buffer[] = [];

			for await (const chunk of stream) {
				chunks.push(chunk as Buffer);
			}

			expect(Buffer.concat(chunks).toString()).toBe('some bytes');
		});

		it('fails everything in flight when the link goes down', async () => {
			await service.connect(peer, null);

			const pending = service.request('peer-1', 'never answered');

			service.disconnect('peer-1');

			await expect(pending).rejects.toThrow();
			expect(service.isLinked('peer-1')).toBe(false);
		});
	});
});
