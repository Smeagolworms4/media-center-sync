import { createPrivateKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MAX_INTRODUCERS_ASKED,
	PEER_INTRODUCE_METHOD,
	PROTOCOL_VERSION,
	PeerCapability,
	PeerLinkMode,
} from '@mcs/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { PEER_LINK_PATH } from './peer-gateway.service';
import { PeerLinkService, type PeerDescriptor } from './peer-link.service';

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

		service = new PeerLinkService();
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
			expect(new PeerLinkService().fingerprint).toBe(service.fingerprint);
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
			// No third-party address anywhere in it: what a gateway is, is its key and
			// its own reachability.
			expect(service.identity('Home')).toEqual({
				nodeId: service.nodeId,
				fingerprint: service.fingerprint,
				name: 'Home',
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

			expect(service.identity('Home')).toMatchObject({
				directAddress: '203.0.113.7:7443',
				directReachable: true,
			});
		});

		it('takes the address it is given over the one in the environment', () => {
			// The setting is what somebody filled in; the variable is what a gateway was
			// started with, years ago, before the setting existed.
			process.env.PEER_PUBLIC_ADDRESS = '203.0.113.7:7443';

			expect(service.identity('Home', 'home.example.org:443')).toMatchObject({
				directAddress: 'home.example.org:443',
				directReachable: true,
			});
		});

		it('reads an empty address as no address rather than as one', () => {
			expect(service.identity('Home', '')).toMatchObject({ directReachable: false });
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

		it('refuses to connect with no address and nobody to introduce us', async () => {
			// The stated limit, reported rather than retried forever: two gateways behind
			// two routers with no friend in common cannot be connected, and the peers
			// screen says so instead of leaving a row that silently never links.
			await expect(
				service.connect({
					id: 'p',
					name: 'Sam',
					fingerprint: 'abc',
					address: null,
					publicKey: null,
				}),
			).rejects.toMatchObject({ response: { key: 'error.peer.unreachable' } });
		});

		it('ignores an introducer there is no link to', async () => {
			// A candidate list is built from rows; by the time it is walked the socket may
			// be gone, and asking over a closed one would throw rather than move on.
			await expect(
				service.connect(
					{ id: 'p', name: 'Sam', fingerprint: 'abc', address: null, publicKey: null },
					{ introducers: ['gone-1', 'gone-2'] },
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
		let theirProtocol = PROTOCOL_VERSION;
		let theirHellos: unknown[] = [];
		let theirCapabilities: string[] = [];
		/** Every path a socket was opened on, so a relayed dial can be told apart. */
		let dialledPaths: string[] = [];
		/** What the far end answers `peer.introduce` with, and what it was asked. */
		let introduction: Record<string, unknown> | null = null;
		let introduceParams: unknown[] = [];

		beforeEach(async () => {
			remote = farEnd();
			respondWithWrongFingerprint = false;
			theirProtocol = PROTOCOL_VERSION;
			theirHellos = [];
			theirCapabilities = [PeerCapability.CONTENT, PeerCapability.CATALOGUE];
			dialledPaths = [];
			introduction = null;
			introduceParams = [];
			server = createServer();
			// No `path` filter: the relay rung dials the same host with `/relay` on the
			// end, and a server that only answered the plain path would make a relayed
			// link indistinguishable from an unreachable one.
			sockets = new WebSocketServer({ server });

			sockets.on('connection', (socket: WebSocket, request) => {
				dialledPaths.push(request.url ?? '');
				socket.on('message', (raw: Buffer) => {
					const message = JSON.parse(raw.toString('utf8')) as {
						id: number;
						method: string;
						params: { challenge?: string; hello?: unknown };
					};

					if (message.method === 'peer.hello') {
						const challenge = message.params.challenge ?? '';

						theirHellos.push(message.params.hello);
						socket.send(
							JSON.stringify({
								id: message.id,
								result: {
									hello: {
										nodeId: 'node-sam',
										fingerprint: respondWithWrongFingerprint
											? 'a-different-fingerprint'
											: service.fingerprintOf(remote.publicKey),
										name: 'Sam',
										protocol: theirProtocol,
										capabilities: theirCapabilities,
										// A field this version has never heard of. It must be
										// ignored rather than refused, or every addition to the
										// protocol becomes a breaking change.
										somethingNewer: { nested: true },
									},
									publicKey: remote.publicKey,
									signature: remote.sign(challenge),
								},
							}),
						);

						return;
					}

					if (message.method === PEER_INTRODUCE_METHOD) {
						introduceParams.push((message as { params: unknown }).params);
						socket.send(
							JSON.stringify(
								introduction === null
									? { id: message.id, error: 'error.peer.introduction_refused' }
									: { id: message.id, result: introduction },
							),
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
				address: `ws://127.0.0.1:${port}${PEER_LINK_PATH}`,
				publicKey: remote.publicKey,
			};
		});

		afterEach(async () => {
			service.onModuleDestroy();
			sockets.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it('links directly and records the mode', async () => {
			const state = await service.connect(peer);

			expect(state).toMatchObject({
				peerId: 'peer-1',
				mode: PeerLinkMode.DIRECT,
				connected: true,
			});
			expect(service.isLinked('peer-1')).toBe(true);
		});

		it('exchanges a hello before anything else and keeps what it said', async () => {
			const state = await service.connect(peer);

			expect(theirHellos).toHaveLength(1);
			expect(theirHellos[0]).toMatchObject({
				fingerprint: service.fingerprint,
				nodeId: service.nodeId,
				protocol: PROTOCOL_VERSION,
			});
			expect(state.protocol).toBe(PROTOCOL_VERSION);
			expect(state.nodeId).toBe('node-sam');
			expect(state.capabilities).toEqual([PeerCapability.CONTENT, PeerCapability.CATALOGUE]);
		});

		it('ignores a field in the handshake it has never heard of', async () => {
			// The rule the whole versioning scheme rests on: an unknown field is a newer
			// gateway being newer, not a broken one.
			await expect(service.connect(peer)).resolves.toMatchObject({ connected: true });
		});

		it('uses a feature only when the far end advertised it', async () => {
			await service.connect(peer);

			expect(service.supports('peer-1', PeerCapability.CATALOGUE)).toBe(true);
			expect(service.supports('peer-1', PeerCapability.SWARM)).toBe(false);
			// And nothing at all is assumed of a peer there is no link to.
			expect(service.supports('peer-2', PeerCapability.CONTENT)).toBe(false);
		});

		it('refuses a version it does not speak instead of guessing at it', async () => {
			// Pre-release there is exactly one version. A gateway that guessed would fail
			// later, somewhere unrelated, with an error about a missing field.
			theirProtocol = PROTOCOL_VERSION + 41;

			await expect(service.connect(peer)).rejects.toMatchObject({
				response: { key: 'error.peer.protocol_unsupported' },
			});
			expect(service.isLinked('peer-1')).toBe(false);
		});

		it('reuses a link it already holds', async () => {
			const first = await service.connect(peer);
			const second = await service.connect(peer);

			expect(second.since).toBe(first.since);
		});

		it('drops a far end that cannot prove it holds the key', async () => {
			// An introducer chooses the address, so a dishonest one can send us to a
			// machine of its choosing. That machine has to prove itself, and cannot.
			respondWithWrongFingerprint = true;

			await expect(service.connect(peer)).rejects.toMatchObject({
				response: { key: 'error.peer.rejected' },
			});
			expect(service.isLinked('peer-1')).toBe(false);
		});

		it('carries a request and its answer', async () => {
			await service.connect(peer);

			expect(await service.request('peer-1', 'catalogue.list')).toEqual({
				echoed: 'catalogue.list',
			});
		});

		it('rejects a request the far end refused', async () => {
			await service.connect(peer);

			await expect(service.request('peer-1', 'fails')).rejects.toThrow('nope');
		});

		it('streams bytes and ends only when the far end says so', async () => {
			// A stream that ended because the socket went quiet is indistinguishable from
			// a complete one, and that is how a truncated chunk passes for a finished one.
			await service.connect(peer);

			const stream = await service.openStream('peer-1', 'media.range', { start: 0, end: 9 });
			const chunks: Buffer[] = [];

			for await (const chunk of stream) {
				chunks.push(chunk as Buffer);
			}

			expect(Buffer.concat(chunks).toString()).toBe('some bytes');
		});

		it('fails everything in flight when the link goes down', async () => {
			await service.connect(peer);

			const pending = service.request('peer-1', 'never answered');

			service.disconnect('peer-1');

			await expect(pending).rejects.toThrow();
			expect(service.isLinked('peer-1')).toBe(false);
		});

		/**
		 * The ladder, climbed against the far end above standing in for both parts.
		 *
		 * It answers as the friend in the middle on the ordinary path and as the holder
		 * on `/relay`, which is enough to pin down the only things the ladder decides:
		 * which rung was taken, who was asked, and how many of them.
		 */
		describe('the dial ladder', () => {
			/** Somewhere nothing listens, so the first rung fails without waiting. */
			const NOWHERE = 'ws://127.0.0.1:1/api/peer/link';

			/** A gateway we have never dialled, reached only through the friend above. */
			function holder(address: string | null): PeerDescriptor {
				return {
					id: 'peer-2',
					name: 'Kim',
					fingerprint: service.fingerprintOf(remote.publicKey),
					address,
					publicKey: null,
				};
			}

			function answerWith(address: string | null): void {
				introduction = {
					token: 'a-signed-token',
					fingerprint: service.fingerprintOf(remote.publicKey),
					address,
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					depth: 2,
				};
			}

			beforeEach(() => {
				theirCapabilities = [
					PeerCapability.CONTENT,
					PeerCapability.INTRODUCE,
					PeerCapability.RELAY,
				];
			});

			it('asks a friend to introduce us when the last known address does not answer', async () => {
				await service.connect(peer);
				answerWith(peer.address);

				const state = await service.connect(holder(NOWHERE), { introducers: ['peer-1'] });

				// By fingerprint, because their row identifier for this gateway is theirs
				// and we could never hold it.
				expect(introduceParams).toEqual([{ fingerprint: peer.fingerprint }]);
				expect(state).toMatchObject({ mode: PeerLinkMode.DIRECT, address: peer.address });
			});

			it('falls back to a relay through that same friend', async () => {
				await service.connect(peer);
				// No address to offer: the friend in the middle knows this gateway only
				// through a link it opened, which is the case the relay exists for.
				answerWith(null);

				const state = await service.connect(holder(null), { introducers: ['peer-1'] });

				expect(state).toMatchObject({ mode: PeerLinkMode.RELAY, address: peer.address });
				expect(dialledPaths.at(-1)).toBe(`${PEER_LINK_PATH}/relay`);
			});

			it('does not relay through a friend who never offered to', async () => {
				// Which is every gateway running this code: relaying a friend of a
				// friend's film is what the introduction exists to avoid. Two ends that
				// can neither of them be dialled then cannot be connected, and that is
				// reported rather than retried in silence.
				theirCapabilities = [PeerCapability.CONTENT, PeerCapability.INTRODUCE];
				await service.connect(peer);
				answerWith(null);

				await expect(
					service.connect(holder(null), { introducers: ['peer-1'] }),
				).rejects.toMatchObject({ response: { key: 'error.peer.unreachable' } });
			});

			it('stops after a bounded number of friends rather than working through them all', async () => {
				const introducers: string[] = [];

				for (let index = 0; index < MAX_INTRODUCERS_ASKED + 3; index += 1) {
					const id = `friend-${index}`;

					await service.connect({ ...peer, id });
					introducers.push(id);
				}

				// Every one of them refuses, so the ladder runs out of friends rather
				// than out of answers — which is the case that used to hang a screen.
				introduction = null;

				await expect(
					service.connect(holder(null), { introducers }),
				).rejects.toMatchObject({ response: { key: 'error.peer.unreachable' } });
				expect(introduceParams).toHaveLength(MAX_INTRODUCERS_ASKED);
			});

			it('spends no round trip on a token it was already handed', async () => {
				// `PeerIntroductionManager` has just been given one by this very friend.
				// Asking again would burn a rung of the budget on an answer we hold.
				await service.connect(peer);

				const state = await service.connect(holder(null), {
					introduction: 'a-signed-token',
					via: 'peer-1',
					introducers: ['peer-1'],
				});

				expect(introduceParams).toEqual([]);
				expect(state.mode).toBe(PeerLinkMode.RELAY);
			});
		});
	});
});
