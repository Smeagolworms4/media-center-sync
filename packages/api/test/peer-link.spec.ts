import { generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	ErrorKey,
	LibraryKind,
	MediaKind,
	MediaServiceScope,
	MediaServiceType,
	PROTOCOL_VERSION,
	PeerCapability,
	PeerDirection,
	PeerStatus,
	PeerTrust,
	ShareVisibility,
	SyncState,
	type PeerHandshake,
} from '@mcs/shared';
import { WebSocket } from 'ws';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	PeerRepository,
	SharePolicyRepository,
} from '@/repositories';
import {
	EVENTS_PATH,
	PEER_LINK_PATH,
	PeerGatewayService,
	PeerLinkService,
	refuseUnknownUpgrades,
} from '@/services';
import { createTestApp, type TestApp } from './utils/app-factory';

/** A gateway at the other end, holding a key pair of its own. */
function gateway() {
	const pair = generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});

	return {
		...pair,
		sign: (payload: string): string =>
			signBytes(null, Buffer.from(payload), pair.privateKey).toString('base64'),
	};
}

/**
 * The peer endpoint, over a real socket on the real application's port.
 *
 * The unit tests pin the framing and the rules; this is the half they cannot show —
 * that the endpoint is really on the HTTP port everything else is served from, that
 * the credential is checked against the database, and that what a peer receives after
 * the handshake comes from the same business layer the HTTP peer routes use.
 */
describe('The peer link endpoint', () => {
	let context: TestApp;
	let port: number;
	let ourFingerprint: string;
	let friend: ReturnType<typeof gateway>;
	let friendFingerprint: string;
	let friendId: string;
	let sharedItemId: string;

	beforeAll(async () => {
		context = await createTestApp();

		// What `main.ts` does once the port is listening. Without it the API answers
		// normally and every peer link is refused by a server that has never heard of
		// the path.
		await context.app.listen(0, '127.0.0.1');

		const server = context.app.getHttpServer() as Server;

		context.app.get(PeerGatewayService).attach(server);
		refuseUnknownUpgrades(server, [EVENTS_PATH, PEER_LINK_PATH]);
		port = (server.address() as AddressInfo).port;

		const links = context.app.get(PeerLinkService);

		ourFingerprint = links.fingerprint;

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);
		const policies = context.app.get(SharePolicyRepository);
		const peers = context.app.get(PeerRepository);

		const service = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				// Port 9 is the discard service: refused at once rather than hanging.
				baseUrl: 'http://127.0.0.1:9',
			}),
		);

		const library = await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-films',
				name: 'Films',
				kind: LibraryKind.MOVIES,
				paths: ['/srv/private/media/films'],
			}),
		);

		sharedItemId = (
			await items.save(
				items.create({
					serviceId: service.id,
					libraryId: library.id,
					externalId: 'jellyfin-item-4711',
					kind: MediaKind.MOVIE,
					title: 'Tears of Steel',
					normalizedTitle: 'tears of steel',
					year: 2012,
					file: {
						path: '/srv/private/media/films/Tears of Steel.mkv',
						size: 1_073_741_824,
						container: 'mkv',
						videoCodec: 'h265',
						audioCodec: 'aac',
						width: 1920,
						height: 1080,
						durationMs: 734_000,
						bitrate: 8_000_000,
						quickHash: 'v1:sampled',
						contentId: 'v1:content-of-the-shared-film',
						checksum: null,
					},
					syncState: SyncState.LOCAL_ONLY,
				}),
			)
		).id;

		await policies.save(
			policies.create({
				libraryId: library.id,
				visibility: ShareVisibility.FRIENDS,
				allowedPeerIds: [],
				deniedPeerIds: [],
				relay: false,
				rateLimit: 0,
			}),
		);

		friend = gateway();
		friendFingerprint = links.fingerprintOf(friend.publicKey);
		friendId = (
			await peers.save(
				peers.create({
					name: 'Alice',
					fingerprint: friendFingerprint,
					publicKey: friend.publicKey,
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND,
				}),
			)
		).id;
	});

	afterAll(async () => {
		await context.close();
	});

	/** The four headers, signed for real, exactly as the outgoing side sends them. */
	function headers(
		who: ReturnType<typeof gateway>,
		fingerprint: string,
		overrides: Record<string, string> = {},
	): Record<string, string> {
		const challenge = `${fingerprint}:${Date.now()}`;

		return {
			'x-mcs-fingerprint': fingerprint,
			'x-mcs-public-key': Buffer.from(who.publicKey).toString('base64'),
			'x-mcs-challenge': challenge,
			'x-mcs-signature': who.sign(challenge),
			...overrides,
		};
	}

	function connect(head: Record<string, string>, path = PEER_LINK_PATH): WebSocket {
		return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: head });
	}

	function opened(client: WebSocket): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			client.once('open', () => resolve());
			client.once('error', reject);
		});
	}

	function answer(client: WebSocket): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			client.once('message', (data: Buffer) =>
				resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>),
			);
		});
	}

	function hello(overrides: Record<string, unknown> = {}) {
		return {
			nodeId: 'node-alice',
			fingerprint: friendFingerprint,
			name: 'Alice',
			protocol: PROTOCOL_VERSION,
			capabilities: [PeerCapability.CONTENT, PeerCapability.CATALOGUE],
			...overrides,
		};
	}

	/** A connected, greeted link — what every method test starts from. */
	async function linked(): Promise<WebSocket> {
		const client = connect(headers(friend, friendFingerprint));

		await opened(client);
		client.send(
			JSON.stringify({ id: 1, method: 'peer.hello', params: { challenge: 'c', hello: hello() } }),
		);
		await answer(client);

		return client;
	}

	describe('getting in', () => {
		it('shares the port the interface and the API are on', async () => {
			// The whole point of the endpoint: one port, one certificate, one line in a
			// reverse proxy. The event stream is on the same server, on its own path.
			const client = connect(headers(friend, friendFingerprint));

			await expect(opened(client)).resolves.toBeUndefined();
			client.close();
		});

		it('refuses a socket with no credential at all', async () => {
			await expect(opened(connect({}))).rejects.toThrow('401');
		});

		it('refuses a signature that does not verify', async () => {
			const forged = headers(friend, friendFingerprint, { 'x-mcs-signature': friend.sign('else') });

			await expect(opened(connect(forged))).rejects.toThrow('401');
		});

		it('refuses a challenge old enough to have been lifted off the wire', async () => {
			const stale = `${friendFingerprint}:${Date.now() - 3_600_000}`;

			await expect(
				opened(
					connect(
						headers(friend, friendFingerprint, {
							'x-mcs-challenge': stale,
							'x-mcs-signature': friend.sign(stale),
						}),
					),
				),
			).rejects.toThrow('401');
		});

		it('records an unknown gateway as a request and refuses it', async () => {
			const stranger = gateway();
			const links = context.app.get(PeerLinkService);
			const fingerprint = links.fingerprintOf(stranger.publicKey);

			await expect(opened(connect(headers(stranger, fingerprint)))).rejects.toThrow('401');

			// The only thing a stranger can do is ask. Somebody has to say yes before a
			// single catalogue row crosses.
			const recorded = await context.app.get(PeerRepository).findByFingerprint(fingerprint);

			expect(recorded).toMatchObject({
				status: PeerStatus.PENDING,
				direction: PeerDirection.INCOMING,
			});
		});

		it('refuses a peer that has been blocked', async () => {
			const blocked = gateway();
			const peers = context.app.get(PeerRepository);
			const links = context.app.get(PeerLinkService);
			const fingerprint = links.fingerprintOf(blocked.publicKey);

			await peers.save(
				peers.create({
					name: 'Mallory',
					fingerprint,
					publicKey: blocked.publicKey,
					status: PeerStatus.BLOCKED,
					trust: PeerTrust.FRIEND,
				}),
			);

			await expect(opened(connect(headers(blocked, fingerprint)))).rejects.toThrow('401');
			// Still blocked afterwards: knocking is not a way out of it.
			expect(await peers.findByFingerprint(fingerprint)).toMatchObject({
				status: PeerStatus.BLOCKED,
			});
		});

		it('refuses an upgrade to a path nobody claims', async () => {
			await expect(
				opened(connect(headers(friend, friendFingerprint), '/api/peer/nowhere')),
			).rejects.toThrow('404');
		});
	});

	describe('the handshake', () => {
		it('answers with our hello and a signature over their challenge', async () => {
			const client = connect(headers(friend, friendFingerprint));

			await opened(client);
			client.send(
				JSON.stringify({
					id: 1,
					method: 'peer.hello',
					params: { challenge: 'a-challenge-of-theirs', hello: hello() },
				}),
			);

			const frame = (await answer(client)) as { id: number; result: PeerHandshake };

			expect(frame.result.hello).toMatchObject({
				fingerprint: ourFingerprint,
				protocol: PROTOCOL_VERSION,
				capabilities: expect.arrayContaining([PeerCapability.CONTENT]),
			});

			// The proof: the key hashes to the fingerprint we published, and it really
			// signed the challenge this peer chose.
			const links = context.app.get(PeerLinkService);

			expect(links.fingerprintOf(frame.result.publicKey)).toBe(ourFingerprint);
			expect(
				verifyBytes(
					null,
					Buffer.from('a-challenge-of-theirs'),
					frame.result.publicKey,
					Buffer.from(frame.result.signature, 'base64'),
				),
			).toBe(true);

			client.close();
		});

		it('writes the agreed version and what they advertised onto the peer', async () => {
			const client = await linked();
			const peer = await context.app.get(PeerRepository).findOne({ where: { id: friendId } });

			expect(peer).toMatchObject({
				protocol: PROTOCOL_VERSION,
				capabilities: [PeerCapability.CONTENT, PeerCapability.CATALOGUE],
				nodeId: 'node-alice',
			});
			client.close();
		});

		it('refuses a version it does not speak and closes the link', async () => {
			const client = connect(headers(friend, friendFingerprint));

			await opened(client);
			client.send(
				JSON.stringify({
					id: 1,
					method: 'peer.hello',
					params: { challenge: 'c', hello: hello({ protocol: PROTOCOL_VERSION + 41 }) },
				}),
			);

			expect(await answer(client)).toEqual({ id: 1, error: ErrorKey.PEER_PROTOCOL_UNSUPPORTED });
			await new Promise<void>((resolve) => client.once('close', () => resolve()));
		});

		it('serves nothing before the hello', async () => {
			const client = connect(headers(friend, friendFingerprint));

			await opened(client);
			client.send(JSON.stringify({ id: 1, method: 'catalogue.list', params: {} }));

			expect(await answer(client)).toEqual({ id: 1, error: ErrorKey.PEER_REJECTED });
			client.close();
		});
	});

	describe('once linked', () => {
		it('answers the catalogue the share policies allow, and nothing else', async () => {
			const client = await linked();

			client.send(JSON.stringify({ id: 2, method: 'catalogue.list', params: {} }));

			const frame = (await answer(client)) as {
				result: { entries: { externalId: string; title: string }[] };
			};

			expect(frame.result.entries.map((entry) => entry.externalId)).toEqual([sharedItemId]);
			client.close();
		});

		it('describes one item by the identifier it published', async () => {
			const client = await linked();

			client.send(
				JSON.stringify({
					id: 3,
					method: 'media.describe',
					params: { serviceId: 'theirs', externalId: sharedItemId },
				}),
			);

			// The two fields the transport reads are still exactly where they were: a peer
			// running an older image reads `size` and `resumable` and nothing else, so
			// moving them under the row would break every transfer already in flight.
			// The row rides alongside them, under a key of its own.
			expect(await answer(client)).toMatchObject({
				id: 3,
				result: {
					size: 1_073_741_824,
					resumable: true,
					entry: { externalId: sharedItemId, title: 'Tears of Steel' },
				},
			});
			client.close();
		});

		it('answers "not found" for an item this peer may not see', async () => {
			const client = await linked();

			client.send(
				JSON.stringify({
					id: 4,
					method: 'media.describe',
					params: { externalId: '00000000-0000-4000-8000-000000000000' },
				}),
			);

			// Not "forbidden": a peer able to tell the two apart can map out what
			// somebody holds without being allowed to see any of it.
			expect(await answer(client)).toEqual({ id: 4, error: ErrorKey.MEDIA_NOT_FOUND });
			client.close();
		});

		it('answers "not supported" to a method it does not know, and stays open', async () => {
			const client = await linked();

			client.send(JSON.stringify({ id: 5, method: 'media.thumbnail', params: {} }));
			expect(await answer(client)).toEqual({ id: 5, error: ErrorKey.PEER_METHOD_UNSUPPORTED });

			client.send(JSON.stringify({ id: 6, method: 'catalogue.list', params: {} }));
			expect(await answer(client)).toMatchObject({ id: 6 });
			client.close();
		});

		it('ignores a parameter it has never heard of', async () => {
			const client = await linked();

			client.send(
				JSON.stringify({
					id: 7,
					method: 'catalogue.list',
					params: { page: 1, sortedHowExactly: 'by-vibes' },
				}),
			);

			expect(await answer(client)).toMatchObject({ id: 7, result: expect.any(Object) });
			client.close();
		});
	});
});
