import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
	RELAY_MAX_BUFFERED_BYTES,
	RELAY_MAX_SESSIONS,
	RELAY_OPEN_TIMEOUT_MS,
	PeerCapability,
	PeerLinkMode,
	RelayOpcode,
	RelayRefusal,
	negotiateProtocol,
	type Settings,
} from '@mcs/shared';
import { BandwidthService } from './bandwidth.service';
import {
	PEER_LINK_PATH,
	PEER_RELAY_PATH,
	PeerGatewayService,
	PeerMethodKind,
	refuseUnknownUpgrades,
	type PeerLinkAuthority,
	type PeerMethodHandler,
	type PeerRelayGrant,
} from './peer-gateway.service';
import { PeerLinkService } from './peer-link.service';
import { RelayFrameReader, encodeRelayFrame, type RelayFrame } from './peer-relay.frames';
import {
	PeerRelayService,
	type CarriedClient,
	type RelayChannel,
	type RelayTransport,
} from './peer-relay.service';
import type { SettingsService } from './settings.service';

/**
 * Three gateways in one process, and not a single socket leaving it.
 *
 * Only the friend in the middle listens, which is the whole point: the other two are
 * behind routers in the story and behind nothing at all here, because neither of them
 * ever accepts a connection. A dials the middle, the holder dialled the middle
 * earlier, and the link between them exists only inside that second socket.
 */
const settingsSaying = (relaying: () => boolean): SettingsService =>
	({ get: async () => ({ relayForPeers: relaying() }) as Settings }) as unknown as SettingsService;

/** What each gateway calls the other, derived so both ends agree without a database. */
const idOf = (fingerprint: string): string => `peer-${fingerprint.slice(0, 8)}`;

interface Gateway {
	links: PeerLinkService;
	relay: PeerRelayService;
	gateway: PeerGatewayService;
	calls: jest.Mock;
	grant: jest.Mock;
}

describe('PeerRelayService', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcs-relay-'));
	});

	afterEach(async () => {
		delete process.env.PEER_KEY_PATH;
		delete process.env.PEER_NODE_ID_PATH;
		await rm(directory, { recursive: true, force: true });
	});

	describe('over a real carried link', () => {
		let server: Server;
		let ada: Gateway;
		let bea: Gateway;
		let kim: Gateway;
		let beaCarries = true;
		let address: string;

		/** One gateway: an identity, an endpoint, and whatever it agreed to carry. */
		function build(name: string, carrying: () => boolean): Gateway {
			process.env.PEER_KEY_PATH = join(directory, `${name}.pem`);
			process.env.PEER_NODE_ID_PATH = join(directory, `${name}.node`);

			const relay = new PeerRelayService(settingsSaying(carrying), new BandwidthService());
			const links = new PeerLinkService(relay);
			const calls = jest.fn(async () => ({ entries: [] }));
			const grant = jest.fn(async (): Promise<PeerRelayGrant | null> => null);
			const authority: PeerLinkAuthority = {
				admit: async (credential) => ({
					peerId: idOf(credential.fingerprint),
					name: idOf(credential.fingerprint),
				}),
				greet: async (_peerId, theirs, challenge) =>
					negotiateProtocol(theirs.protocol) === null
						? null
						: {
							hello: await links.hello(),
							publicKey: links.publicKey,
							signature: links.sign(challenge),
						},
				carry: grant as unknown as PeerLinkAuthority['carry'],
			};
			const methods: PeerMethodHandler = {
				kind: (method) => {
					if (method === 'catalogue.list') {
						return PeerMethodKind.VALUE;
					}

					return method === 'media.range' ? PeerMethodKind.STREAM : null;
				},
				call: calls as unknown as PeerMethodHandler['call'],
				stream: (async () =>
					Readable.from([Buffer.from('some bytes')])) as unknown as PeerMethodHandler['stream'],
			};

			return {
				links,
				relay,
				gateway: new PeerGatewayService(authority, methods, relay),
				calls,
				grant,
			};
		}

		function holder() {
			return {
				id: 'kim',
				name: 'Kim',
				fingerprint: kim.links.fingerprint,
				// No address at all: the holder is behind a router and the only way to
				// them is back down the socket they opened to the friend in the middle.
				address: null,
				publicKey: null,
			};
		}

		async function until(condition: () => boolean): Promise<void> {
			for (let attempt = 0; attempt < 200; attempt += 1) {
				if (condition()) {
					return;
				}

				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			throw new Error('condition never held');
		}

		beforeEach(async () => {
			beaCarries = true;
			ada = build('ada', () => false);
			kim = build('kim', () => false);
			bea = build('bea', () => beaCarries);

			server = createServer();
			bea.gateway.attach(server);
			refuseUnknownUpgrades(server, [PEER_LINK_PATH, PEER_RELAY_PATH]);

			await new Promise<void>((resolve) => server.listen(0, resolve));

			address = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${PEER_LINK_PATH}`;
			bea.grant.mockImplementation(async () => ({
				holderPeerId: idOf(kim.links.fingerprint),
				holderName: 'Kim',
				subjectName: 'Ada',
			}));

			const middle = {
				id: 'bea',
				name: 'Bea',
				fingerprint: bea.links.fingerprint,
				address,
				publicKey: null,
			};

			// The holder dials the friend in the middle first, and that inbound socket is
			// the only route to it for the rest of this describe.
			await kim.links.connect(middle);
			await ada.links.connect(middle);
		});

		afterEach(async () => {
			for (const gateway of [ada, bea, kim]) {
				gateway.links.onModuleDestroy();
				gateway.gateway.onModuleDestroy();
				gateway.relay.onModuleDestroy();
			}

			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it('advertises relaying only when the household agreed to it', async () => {
			// Advertising the capability *is* the promise, so it comes from the setting
			// and never from a constant.
			expect(ada.links.supports('bea', PeerCapability.RELAY)).toBe(true);

			beaCarries = false;
			ada.links.disconnect('bea');
			await ada.links.connect({
				id: 'bea',
				name: 'Bea',
				fingerprint: bea.links.fingerprint,
				address,
				publicKey: null,
			});

			expect(ada.links.supports('bea', PeerCapability.RELAY)).toBe(false);
		});

		it('opens a link through the friend in the middle', async () => {
			const state = await ada.links.connect(holder(), {
				introduction: 'a-token',
				via: 'bea',
				introducers: ['bea'],
			});

			expect(state).toMatchObject({ peerId: 'kim', mode: PeerLinkMode.RELAY, connected: true });
			// The holder ran its ordinary inbound session over somebody else's socket.
			expect(kim.gateway.sessionCount).toBe(1);
			expect(bea.relay.carriedCount).toBe(1);
		});

		it('carries a request and its answer', async () => {
			await ada.links.connect(holder(), {
				introduction: 'a-token',
				via: 'bea',
				introducers: ['bea'],
			});

			await expect(ada.links.request('kim', 'catalogue.list')).resolves.toEqual({ entries: [] });
			// Answered by the holder as the dialler, not as the carrier: the credential
			// that crossed is the dialler's own.
			expect(kim.calls).toHaveBeenCalledWith(
				idOf(ada.links.fingerprint),
				'catalogue.list',
				expect.anything(),
			);
		});

		it('carries bytes, which is the whole point of it', async () => {
			await ada.links.connect(holder(), {
				introduction: 'a-token',
				via: 'bea',
				introducers: ['bea'],
			});

			const stream = await ada.links.openStream('kim', 'media.range', { start: 0, end: 9 });
			const chunks: Buffer[] = [];

			for await (const chunk of stream) {
				chunks.push(chunk as Buffer);
			}

			expect(Buffer.concat(chunks).toString()).toBe('some bytes');
		});

		it('does not relay through a friend whose household said no', async () => {
			beaCarries = false;
			ada.links.disconnect('bea');
			await ada.links.connect({
				id: 'bea',
				name: 'Bea',
				fingerprint: bea.links.fingerprint,
				address,
				publicKey: null,
			});

			await expect(
				ada.links.connect(holder(), {
					introduction: 'a-token',
					via: 'bea',
					introducers: ['bea'],
				}),
			).rejects.toMatchObject({ response: { key: 'error.peer.unreachable' } });
			expect(bea.grant).not.toHaveBeenCalled();
		});

		it('refuses to carry a link the friend in the middle did not agree to', async () => {
			// The token is what authorises a relay, and it is checked by whoever minted
			// it. A grant of null is that refusal, and it must not leave a socket behind.
			bea.grant.mockResolvedValue(null);

			await expect(
				ada.links.connect(holder(), {
					introduction: 'not-a-token-we-minted',
					via: 'bea',
					introducers: ['bea'],
				}),
			).rejects.toMatchObject({ response: { key: 'error.peer.unreachable' } });
			expect(bea.relay.carriedCount).toBe(0);
		});

		it('ends the carried link when the holder disappears', async () => {
			await ada.links.connect(holder(), {
				introduction: 'a-token',
				via: 'bea',
				introducers: ['bea'],
			});

			kim.links.disconnect('bea');

			await until(() => !ada.links.isLinked('kim'));
			expect(bea.relay.carriedCount).toBe(0);
		});

		it('ends the carried link when the gateway that dialled disappears', async () => {
			await ada.links.connect(holder(), {
				introduction: 'a-token',
				via: 'bea',
				introducers: ['bea'],
			});

			ada.links.disconnect('kim');

			await until(() => kim.gateway.sessionCount === 0);
			expect(bea.relay.carriedCount).toBe(0);
		});
	});

	/**
	 * The rules, against a link that is a pair of functions.
	 *
	 * A real socket proves the thing works; these prove what it refuses, which needs a
	 * holder that answers exactly what the test says and a bandwidth budget that never
	 * pays out.
	 */
	describe('what it refuses', () => {
		let relay: PeerRelayService;
		let channel: RelayChannel;
		let sent: RelayFrame[];
		let open: boolean;
		let carrying: boolean;
		let bandwidth: BandwidthService;
		let paid: number[];
		let paying: (bytes: number) => Promise<void>;
		let answer: 'accept' | 'refuse' | 'silence';

		/** Let every microtask the relay queued run before looking at what it sent. */
		const flush = (): Promise<void> =>
			new Promise<void>((resolve) => {
				setImmediate(resolve);
			});

		const payload = {
			fingerprint: 'their-fingerprint',
			publicKey: 'their-key',
			challenge: 'their-fingerprint:1',
			signature: 'a-signature',
			introduction: 'a-token',
			address: '198.51.100.9',
		};

		function client(): CarriedClient & { closed: boolean } {
			return {
				readyState: 1,
				closed: false,
				on: () => undefined,
				send: () => undefined,
				close(): void {
					this.closed = true;
				},
			};
		}

		beforeEach(() => {
			sent = [];
			open = true;
			carrying = true;
			answer = 'accept';
			paid = [];
			paying = async () => undefined;
			bandwidth = {
				send: async (bytes: number) => {
					paid.push(bytes);

					await paying(bytes);
				},
			} as unknown as BandwidthService;
			relay = new PeerRelayService(settingsSaying(() => carrying), bandwidth);

			const reader = new RelayFrameReader();
			const transport: RelayTransport = {
				peerId: 'holder',
				dialled: false,
				get open(): boolean {
					return open;
				},
				send: (frame: Buffer) => {
					for (const decoded of reader.push(frame)) {
						sent.push(decoded);

						// The holder answering, synchronously, which is what a socket on
						// the same machine amounts to for the purposes of these rules.
						if (decoded.opcode === RelayOpcode.OPEN && answer !== 'silence') {
							channel.receive(
								encodeRelayFrame(
									answer === 'accept' ? RelayOpcode.ACCEPT : RelayOpcode.REFUSE,
									decoded.session,
								),
							);
						}
					}
				},
			};

			channel = relay.register(transport);
		});

		it('carries nothing at all when the household did not agree', async () => {
			carrying = false;

			await expect(relay.reserve('holder', payload)).resolves.toBeNull();
			// Not even asked. A gateway that put the question to the holder would be
			// telling it who is trying to reach it, having refused to help.
			expect(sent).toEqual([]);
		});

		it('carries nothing to a peer there is no link to', async () => {
			await expect(relay.reserve('somebody-else', payload)).resolves.toBeNull();
			expect(sent).toEqual([]);
		});

		it('stops at the number of links it offered to carry', async () => {
			for (let index = 0; index < RELAY_MAX_SESSIONS; index += 1) {
				expect(await relay.reserve('holder', payload)).not.toBeNull();
			}

			// An unbounded relay is a gateway somebody else can saturate.
			await expect(relay.reserve('holder', payload)).resolves.toBeNull();
			expect(relay.carriedCount).toBe(RELAY_MAX_SESSIONS);
		});

		it('gives a place back when the holder refuses', async () => {
			answer = 'refuse';

			await expect(relay.reserve('holder', payload)).resolves.toBeNull();
			expect(relay.carriedCount).toBe(0);
		});

		it('gives a place back when the holder never answers', async () => {
			// Which is what a gateway from before any of this existed does: it drops a
			// binary frame it cannot place, and says nothing.
			jest.useFakeTimers();
			answer = 'silence';

			try {
				const reserved = relay.reserve('holder', payload);

				await jest.advanceTimersByTimeAsync(RELAY_OPEN_TIMEOUT_MS);

				await expect(reserved).resolves.toBeNull();
				expect(relay.carriedCount).toBe(0);
			} finally {
				jest.useRealTimers();
			}
		});

		it('gives a place back when the dialler gave up before the upgrade finished', async () => {
			const session = await relay.reserve('holder', payload);

			relay.abandon(session!, RelayRefusal.LINK_LOST);

			expect(relay.carriedCount).toBe(0);
		});

		it('drops everything riding on a link that went away', async () => {
			const session = await relay.reserve('holder', payload);
			const dialler = client();

			relay.attach(session!, dialler);
			open = false;
			channel.close();

			expect(relay.carriedCount).toBe(0);
			expect(dialler.closed).toBe(true);
		});

		it('closes a session with more waiting than it is allowed to hold', async () => {
			// A holder on a fast line feeding a dialler on a slow one, with nothing to
			// stop the difference accumulating here. That, rather than the bandwidth
			// everybody expects, is what an unbounded relay really costs.
			paying = () => new Promise<void>(() => undefined);

			const session = await relay.reserve('holder', payload);
			const dialler = client();

			relay.attach(session!, dialler);

			const block = Buffer.alloc(RELAY_MAX_BUFFERED_BYTES / 4);

			for (let index = 0; index < 8; index += 1) {
				channel.receive(encodeRelayFrame(RelayOpcode.BINARY, session!.id, block));
			}

			expect(relay.carriedCount).toBe(0);
			expect(dialler.closed).toBe(true);
			expect(sent.at(-1)?.opcode).toBe(RelayOpcode.CLOSE);
		});

		it('refuses to be an endpoint when nothing is bound to admit anybody', async () => {
			channel.receive(
				encodeRelayFrame(RelayOpcode.OPEN, 2, Buffer.from(JSON.stringify(payload), 'utf8')),
			);

			await flush();

			expect(sent.at(-1)?.opcode).toBe(RelayOpcode.REFUSE);
		});

		it('refuses a relayed link its endpoint would not admit', async () => {
			relay.bind({ accept: async () => false });

			channel.receive(
				encodeRelayFrame(RelayOpcode.OPEN, 2, Buffer.from(JSON.stringify(payload), 'utf8')),
			);

			await flush();

			expect(sent.at(-1)?.opcode).toBe(RelayOpcode.REFUSE);
		});

		it('pays for every byte it puts on the wire, out of the upload budget', async () => {
			// Relayed traffic is inside `uploadRateLimit` rather than beside it: the
			// uplink does not care why a byte is leaving, and a relay with its own budget
			// would be a way round a cap somebody set to keep their line usable.
			const session = await relay.reserve('holder', payload);

			relay.attach(session!, client());
			channel.receive(
				encodeRelayFrame(RelayOpcode.BINARY, session!.id, Buffer.from('twelve bytes')),
			);

			await flush();

			expect(paid).toEqual([12]);
		});
	});
});
