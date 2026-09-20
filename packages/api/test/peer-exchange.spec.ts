import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceScope,
	MediaServiceType,
	PeerStatus,
	PeerTrust,
	ShareVisibility,
	SyncState,
	type CatalogueEntry,
	type MediaFileInfo,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	PeerRepository,
	SharePolicyRepository,
} from '@/repositories';
import { PeerLinkService } from '@/services';
import { createTestApp, type TestApp } from './utils/app-factory';

/**
 * The routes another gateway calls, with a credential it really signed.
 *
 * `guards.spec.ts` proves nobody gets in without one. This is the other half, and the
 * one a unit test cannot show: that a peer which *can* prove itself is handed exactly
 * what the share policies say and nothing else — no library identifier, no service
 * identifier, no path — and that an item it may not see answers "not found" rather
 * than "forbidden", because a peer able to tell those apart can map out what somebody
 * holds without being allowed to see any of it.
 */
describe('The peer protocol', () => {
	let context: TestApp;
	/** A linked friend, holding the private half of the key the gateway knows. */
	let friend: { fingerprint: string; credential: string; id: string };
	/** Linked, and only a friend of a friend: the `friends` library is not theirs. */
	let acquaintance: { fingerprint: string; credential: string; id: string };
	let sharedLibraryId: string;
	let sharedItemId: string;
	let hiddenItemId: string;
	let itemWithoutFileId: string;
	let episodeId: string;

	const CONTENT_ID = 'v1:content-of-the-shared-film';

	const fileInfo = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
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
		contentId: CONTENT_ID,
		checksum: null,
		...overrides,
	});

	/**
	 * A peer the gateway can really verify.
	 *
	 * The credential is a signature over `<their fingerprint>:<ours>` — exactly what
	 * the link negotiation signs — so this exercises the guard's cryptography rather
	 * than stubbing past it.
	 */
	const link = async (
		name: string,
		trust: PeerTrust,
	): Promise<{ fingerprint: string; credential: string; id: string }> => {
		const links = context.app.get(PeerLinkService);
		const peers = context.app.get(PeerRepository);
		const pair = generateKeyPairSync('ed25519', {
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' },
		});
		const fingerprint = links.fingerprintOf(pair.publicKey);
		const peer = await peers.save(
			peers.create({
				name,
				fingerprint,
				publicKey: pair.publicKey,
				status: PeerStatus.LINKED,
				trust,
			}),
		);

		return {
			id: peer.id,
			fingerprint,
			credential: `Peer ${fingerprint}:${signBytes(
				null,
				Buffer.from(`${fingerprint}:${links.fingerprint}`),
				pair.privateKey,
			).toString('base64')}`,
		};
	};

	beforeAll(async () => {
		context = await createTestApp();

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);
		const policies = context.app.get(SharePolicyRepository);

		const service = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				// Port 9 is the discard service: refused at once rather than hanging for
				// the handler's whole timeout, and nothing is ever listening on it.
				baseUrl: 'http://127.0.0.1:9',
			}),
		);

		const shared = await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-films',
				name: 'Films',
				kind: LibraryKind.MOVIES,
				paths: ['/srv/private/media/films'],
			}),
		);

		sharedLibraryId = shared.id;

		const hidden = await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-home-videos',
				name: 'Home videos',
				kind: LibraryKind.OTHER,
				paths: ['/srv/private/media/home'],
			}),
		);

		sharedItemId = (
			await items.save(
				items.create({
					serviceId: service.id,
					libraryId: shared.id,
					externalId: 'jellyfin-item-4711',
					kind: MediaKind.MOVIE,
					title: 'Tears of Steel',
					normalizedTitle: 'tears of steel',
					year: 2012,
					externalIds: { tmdb: '133701', provider: 'jellyfin-internal-4711' },
					file: fileInfo(),
					quality: {
						label: 'x265 · 1080p',
						mixed: false,
						dominant: null,
						variants: [],
						fileCount: 1,
						totalBytes: 1_073_741_824,
					},
					syncState: SyncState.LOCAL_ONLY,
				}),
			)
		).id;

		episodeId = (
			await items.save(
				items.create({
					serviceId: service.id,
					libraryId: shared.id,
					externalId: 'jellyfin-item-4712',
					parentId: sharedItemId,
					kind: MediaKind.EPISODE,
					title: 'A short',
					normalizedTitle: 'a short',
					seasonNumber: 1,
					episodeNumber: 2,
					file: fileInfo({ contentId: 'v1:another-thing' }),
					syncState: SyncState.LOCAL_ONLY,
				}),
			)
		).id;

		itemWithoutFileId = (
			await items.save(
				items.create({
					serviceId: service.id,
					libraryId: shared.id,
					externalId: 'jellyfin-item-4713',
					kind: MediaKind.MOVIE,
					title: 'Announced but unscanned',
					normalizedTitle: 'announced but unscanned',
					file: null,
					syncState: SyncState.UNKNOWN,
				}),
			)
		).id;

		hiddenItemId = (
			await items.save(
				items.create({
					serviceId: service.id,
					libraryId: hidden.id,
					externalId: 'jellyfin-item-9000',
					kind: MediaKind.MOVIE,
					title: 'A birthday',
					normalizedTitle: 'a birthday',
					file: fileInfo({ contentId: 'v1:a-birthday' }),
					syncState: SyncState.LOCAL_ONLY,
				}),
			)
		).id;

		// Only the films are shared, and only with the people we linked to ourselves.
		await policies.save(
			policies.create({
				libraryId: shared.id,
				visibility: ShareVisibility.FRIENDS,
				allowedPeerIds: [],
				deniedPeerIds: [],
				relay: false,
				rateLimit: 0,
			}),
		);

		// The home videos are private, and said so rather than left unsaid: this service
		// is one of ours, so a library with no row follows the gateway default — which
		// ships as `friends_of_friends`. An explicit private is what keeps something off
		// the wire, and it is also the case worth pinning here, because it is the one the
		// default must never be allowed to overrule.
		await policies.save(
			policies.create({
				libraryId: hidden.id,
				visibility: ShareVisibility.PRIVATE,
				allowedPeerIds: [],
				deniedPeerIds: [],
				relay: false,
				rateLimit: 0,
			}),
		);

		friend = await link('Alice', PeerTrust.FRIEND);
		acquaintance = await link('Carol', PeerTrust.FRIEND_OF_FRIEND);
	});

	afterAll(async () => {
		await context.close();
	});

	const call = (path: string, credential: string = friend.credential): request.Test =>
		request(context.app.getHttpServer())
			.get(`/api/peer${path}`)
			.set('Authorization', credential);

	describe('the catalogue', () => {
		it('hands a friend what the policies say, and only that', async () => {
			const response = await call('/catalogue').expect(200);
			const entries = response.body as CatalogueEntry[];

			expect(entries.map((entry) => entry.externalId).sort()).toEqual(
				[sharedItemId, episodeId, itemWithoutFileId].sort(),
			);
			expect(entries.some((entry) => entry.title === 'A birthday')).toBe(false);
		});

		it('answers the shape the exchange model documents', async () => {
			const response = await call('/catalogue').expect(200);
			const film = (response.body as CatalogueEntry[]).find(
				(entry) => entry.externalId === sharedItemId,
			);

			expect(film).toEqual({
				externalId: sharedItemId,
				// The library it sits in, named by our row identifier and by nothing that
				// describes our disk. A peer files these rows into libraries of its own,
				// and without a handle it can only ever make one.
				libraryId: sharedLibraryId,
				kind: MediaKind.MOVIE,
				title: 'Tears of Steel',
				year: 2012,
				seasonNumber: null,
				episodeNumber: null,
				parentExternalId: null,
				// The metadata identifiers are the point: both sides can correlate on
				// them. `provider` is how *our* service keys the row and means nothing at
				// the far end, so it is not published.
				externalIds: { tmdb: '133701' },
				contentId: CONTENT_ID,
				size: 1_073_741_824,
				quality: 'x265 · 1080p',
			});
		});

		it('publishes an episode under the identifier it published for its parent', async () => {
			const response = await call('/catalogue').expect(200);
			const episode = (response.body as CatalogueEntry[]).find(
				(entry) => entry.externalId === episodeId,
			);

			expect(episode).toMatchObject({
				seasonNumber: 1,
				episodeNumber: 2,
				parentExternalId: sharedItemId,
			});
		});

		it('leaks no path and no identifier a media service of ours keys its rows by', async () => {
			const payload = JSON.stringify((await call('/catalogue').expect(200)).body);

			// The shape of somebody's disk is of no use to the far end, and publishing it
			// tempts both sides into addressing a library by path. Our own row
			// identifiers are a different thing and do cross — the item's, and the
			// library's, which is what lets a peer file these rows where they belong.
			expect(payload).not.toContain('/srv/private');
			expect(payload).not.toContain('jellyfin-item-4711');
			expect(payload).not.toContain('serviceId');
		});

		it('gives a friend of a friend nothing, when the library is for friends', async () => {
			const response = await call('/catalogue', acquaintance.credential).expect(200);

			expect(response.body as CatalogueEntry[]).toEqual([]);
		});

		it('answers only what changed since a stamp, so a peer does not re-read everything', async () => {
			const future = new Date(Date.now() + 3_600_000).toISOString();

			expect((await call(`/catalogue?since=${future}`).expect(200)).body).toEqual([]);
			expect(
				((await call('/catalogue?since=1970-01-01T00:00:00.000Z').expect(200))
					.body as CatalogueEntry[]).length,
			).toBeGreaterThan(0);
		});

		it('pages', async () => {
			expect((await call('/catalogue?page=2').expect(200)).body).toEqual([]);
		});

		it('refuses a page below one, and a query parameter it never declared', async () => {
			await call('/catalogue?page=0').expect(400);
			await call('/catalogue?limit=10').expect(400);
		});
	});

	describe('one item', () => {
		it('describes an item the caller may see', async () => {
			const response = await call(`/items/${sharedItemId}`).expect(200);

			expect(response.body as CatalogueEntry).toMatchObject({
				externalId: sharedItemId,
				title: 'Tears of Steel',
			});
		});

		it('answers "not found" for an item the caller may not see, never "forbidden"', async () => {
			// Telling a peer that something exists but is hidden is itself a leak of what
			// somebody holds.
			const response = await call(`/items/${hiddenItemId}`).expect(404);

			expect(response.body).toMatchObject({ message: 'error.media.not_found' });
		});

		it('answers the same for an item nobody holds', async () => {
			const response = await call('/items/11111111-2222-4333-8444-555555555555').expect(404);

			expect(response.body).toMatchObject({ message: 'error.media.not_found' });
		});

		it('answers the same to a friend of a friend the library is not shared with', async () => {
			await call(`/items/${sharedItemId}`, acquaintance.credential).expect(404);
		});
	});

	describe('the bytes', () => {
		it('refuses an item we announced but never scanned a file for', async () => {
			const response = await call(`/items/${itemWithoutFileId}/content`).expect(404);

			expect(response.body).toMatchObject({ message: 'error.media.not_found' });
		});

		it('refuses an item the caller may not see', async () => {
			await call(`/items/${hiddenItemId}/content`).expect(404);
		});
	});

	describe('revalidation', () => {
		const revalidate = (body: Record<string, unknown>, credential: string = friend.credential): request.Test =>
			request(context.app.getHttpServer())
				.post('/api/peer/revalidate')
				.set('Authorization', credential)
				.send(body);

		it('fails loudly when the service cannot be reached, rather than answering "gone"', async () => {
			// The distinction this route exists for. A silence read as "gone" would have
			// the far end abandon a perfectly good source and re-download everything.
			const response = await revalidate({ itemId: sharedItemId }).expect(503);

			expect(response.body).toMatchObject({ message: 'error.service.unreachable' });
		});

		it('answers "not found" for an item the caller may not see', async () => {
			const response = await revalidate({ itemId: hiddenItemId }).expect(404);

			expect(response.body).toMatchObject({ message: 'error.media.not_found' });
		});

		it('refuses a body with no item, and one carrying a field it never declared', async () => {
			await revalidate({}).expect(400);
			await revalidate({ itemId: '' }).expect(400);
			await revalidate({ itemId: sharedItemId, peerId: acquaintance.id }).expect(400);
		});
	});

	describe('announcements', () => {
		it('says we hold a content identifier that sits in a shared library', async () => {
			const response = await call(`/announce/${CONTENT_ID}`).expect(200);

			expect(response.body).toEqual({ contentId: CONTENT_ID, held: true, holders: [] });
		});

		it('says we do not hold one nobody has', async () => {
			expect((await call('/announce/v1:nothing-like-it').expect(200)).body).toMatchObject({
				held: false,
			});
		});

		it('never announces something that sits in a library the caller cannot pull from', async () => {
			// Announcing what we would refuse to serve has the far end queue a source that
			// can never deliver a byte.
			expect((await call('/announce/v1:a-birthday').expect(200)).body).toMatchObject({
				held: false,
			});
		});

		it('answers nothing at all to a peer the policies hide everything from', async () => {
			expect(
				(await call(`/announce/${CONTENT_ID}`, acquaintance.credential).expect(200)).body,
			).toMatchObject({ held: false, holders: [] });
		});
	});

	describe('the credential', () => {
		it('refuses a signature made over the wrong payload', async () => {
			const pair = generateKeyPairSync('ed25519', {
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
				publicKeyEncoding: { type: 'spki', format: 'pem' },
			});
			const forged = signBytes(
				null,
				Buffer.from('something-else'),
				pair.privateKey,
			).toString('base64');

			const response = await call('/catalogue', `Peer ${friend.fingerprint}:${forged}`)
				.expect(401);

			expect(response.body).toMatchObject({ message: 'error.peer.rejected' });
		});


		it('refuses a peer that has only asked, and not been accepted', async () => {
			const peers = context.app.get(PeerRepository);
			const pending = await link('Dave', PeerTrust.FRIEND);

			await peers.setStatus(pending.id, PeerStatus.PENDING);

			await call('/catalogue', pending.credential).expect(401);
		});
	});

	/**
	 * A peer forbidden from reading, over every path that answers a peer.
	 *
	 * The claim is not that one route filters: it is that *all* of them do, because
	 * they all go through `ShareManager.visiblePolicies`, and that the link is
	 * untouched while they do — the peer keeps talking to us and keeps being answered,
	 * with nothing in every answer. That is the whole trade this replaced blocking
	 * with, and the only place it can be shown is here, over the real guard.
	 */
	describe('a peer forbidden from reading', () => {
		let outcast: { fingerprint: string; credential: string; id: string };

		beforeAll(async () => {
			const peers = context.app.get(PeerRepository);

			outcast = await link('Mallory', PeerTrust.FRIEND);

			const row = await peers.findByFingerprint(outcast.fingerprint);

			row!.readingForbidden = true;
			await peers.save(row!);
		});

		it('is still let in, because the link is deliberately kept open', async () => {
			// Not a 401. They stay connected on their side; what changes is what they
			// are served, not whether they are heard.
			await call('/catalogue', outcast.credential).expect(200);
		});

		it('is served an empty catalogue', async () => {
			const response = await call('/catalogue', outcast.credential).expect(200);

			expect(response.body as CatalogueEntry[]).toEqual([]);
		});

		it('cannot see an item a friend can', async () => {
			// Not found rather than forbidden: a peer able to tell the two apart can map
			// out what somebody holds without being allowed to see any of it.
			await call(`/items/${sharedItemId}`, friend.credential).expect(200);
			await call(`/items/${sharedItemId}`, outcast.credential).expect(404);
		});

		it('cannot pull the bytes of an item a friend can', async () => {
			await call(`/items/${sharedItemId}/content`, outcast.credential).expect(404);
		});

		it('is told we hold nothing, and is given nobody else to ask', async () => {
			const answer = await call(`/announce/${CONTENT_ID}`, outcast.credential).expect(200);

			expect(answer.body).toMatchObject({ held: false, holders: [] });

			// And the same question from a friend still finds it, so the emptiness above
			// is about this peer and not about the gateway having nothing.
			const theirs = await call(`/announce/${CONTENT_ID}`, friend.credential).expect(200);

			expect(theirs.body).toMatchObject({ held: true });
		});

		it('is told nothing by a revalidation either', async () => {
			await request(context.app.getHttpServer())
				.post('/api/peer/revalidate')
				.set('Authorization', outcast.credential)
				.send({ itemId: sharedItemId })
				.expect(404);
		});

		it('sees everything again the moment it is allowed', async () => {
			const peers = context.app.get(PeerRepository);
			const row = await peers.findByFingerprint(outcast.fingerprint);

			row!.readingForbidden = false;
			await peers.save(row!);

			const response = await call('/catalogue', outcast.credential).expect(200);

			expect((response.body as CatalogueEntry[]).length).toBeGreaterThan(0);

			row!.readingForbidden = true;
			await peers.save(row!);
		});
	});
});
