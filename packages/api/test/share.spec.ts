import request from 'supertest';
import {
	LibraryKind,
	MediaServiceScope,
	MediaServiceType,
	PeerStatus,
	PeerTrust,
	ShareVisibility,
	UserRole,
	type ShareAudit,
	type SharePolicy,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaServiceRepository,
	PeerRepository,
} from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * What this gateway exposes, over HTTP.
 *
 * Two things are worth proving here rather than in a unit test. The first is that
 * every field `UpdateSharePolicyRequest` documents actually survives the validation
 * pipe — `relay` did not, and a policy could therefore never be given the consent the
 * manager demands, which made a remote library impossible to share at all through the
 * API that documents how to share it. The second is the relay rule itself, which only
 * reads correctly end to end: it depends on the scope of the service the library sits
 * on, which no DTO carries.
 */
describe('Sharing', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let guest: TestIdentity;
	/** On a service of ours: our disk, our bytes, nothing to agree to. */
	let ownLibraryId: string;
	/** On somebody else's: sharing it makes us the conduit. */
	let remoteLibraryId: string;
	let friendId: string;
	let acquaintanceId: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		guest = await signInAs(context, UserRole.GUEST);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const peers = context.app.get(PeerRepository);

		const ours = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://127.0.0.1:51',
			}),
		);

		const theirs = await services.save(
			services.create({
				name: "A friend's Plex",
				type: MediaServiceType.PLEX,
				scope: MediaServiceScope.REMOTE,
				baseUrl: 'http://127.0.0.1:52',
			}),
		);

		ownLibraryId = (
			await libraries.save(
				libraries.create({
					serviceId: ours.id,
					externalId: 'lib-shows',
					name: 'Shows',
					kind: LibraryKind.SHOWS,
					paths: ['/media/shows'],
					itemCount: 12,
				}),
			)
		).id;

		remoteLibraryId = (
			await libraries.save(
				libraries.create({
					serviceId: theirs.id,
					externalId: 'lib-films',
					name: 'Their films',
					kind: LibraryKind.MOVIES,
					paths: ['/srv/films'],
					itemCount: 4,
				}),
			)
		).id;

		friendId = (
			await peers.save(
				peers.create({
					name: 'Alice',
					fingerprint: 'fingerprint-alice',
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND,
				}),
			)
		).id;

		acquaintanceId = (
			await peers.save(
				peers.create({
					name: 'Carol',
					fingerprint: 'fingerprint-carol',
					status: PeerStatus.LINKED,
					trust: PeerTrust.FRIEND_OF_FRIEND,
					viaPeerId: friendId,
				}),
			)
		).id;
	});

	afterAll(async () => {
		await context.close();
	});

	const put = (libraryId: string, body: Record<string, unknown>, identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.put(`/api/shares/${libraryId}`)
			.set('Authorization', `Bearer ${identity.token}`)
			.send(body);

	const list = (identity: TestIdentity = admin): request.Test =>
		request(context.app.getHttpServer())
			.get('/api/shares')
			.set('Authorization', `Bearer ${identity.token}`);

	const stored = async (libraryId: string): Promise<SharePolicy | undefined> =>
		((await list().expect(200)).body as SharePolicy[]).find(
			(policy) => policy.libraryId === libraryId,
		);

	describe('writing a policy', () => {
		it('creates one on the first write, and answers the shape the model documents', async () => {
			const response = await put(ownLibraryId, {
				visibility: ShareVisibility.FRIENDS,
			}).expect(200);

			expect(response.body as SharePolicy).toMatchObject({
				id: expect.any(String),
				libraryId: ownLibraryId,
				libraryName: 'Shows',
				serviceId: expect.any(String),
				visibility: ShareVisibility.FRIENDS,
				allowedPeerIds: [],
				deniedPeerIds: [],
				rateLimit: 0,
				// Ours to give: sharing it costs nobody an access they were not given.
				relays: false,
				relay: false,
			});
		});

		it('is the same saved twice, which is what PUT on a library identifier means', async () => {
			const first = await put(ownLibraryId, { visibility: ShareVisibility.FRIENDS }).expect(200);
			const second = await put(ownLibraryId, { visibility: ShareVisibility.FRIENDS }).expect(200);

			expect((second.body as SharePolicy).id).toBe((first.body as SharePolicy).id);
			expect(
				((await list().expect(200)).body as SharePolicy[]).filter(
					(policy) => policy.libraryId === ownLibraryId,
				),
			).toHaveLength(1);
		});

		it('accepts `visibility`', async () => {
			await put(ownLibraryId, { visibility: ShareVisibility.FRIENDS_OF_FRIENDS }).expect(200);

			expect((await stored(ownLibraryId))?.visibility).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
		});

		it('accepts `allowedPeerIds`', async () => {
			await put(ownLibraryId, { allowedPeerIds: [friendId] }).expect(200);

			expect((await stored(ownLibraryId))?.allowedPeerIds).toEqual([friendId]);
		});

		it('accepts `deniedPeerIds`', async () => {
			await put(ownLibraryId, { deniedPeerIds: [acquaintanceId] }).expect(200);

			expect((await stored(ownLibraryId))?.deniedPeerIds).toEqual([acquaintanceId]);
		});

		it('accepts `rateLimit`', async () => {
			await put(ownLibraryId, { rateLimit: 1_048_576 }).expect(200);

			expect((await stored(ownLibraryId))?.rateLimit).toBe(1_048_576);
		});

		it('accepts `relay`, the consent without which a remote library cannot be shared', async () => {
			// `UpdateSharePolicyRequest` has carried `relay` since the rule was added and
			// the manager reads it; the DTO did not declare it, so the whitelist answered
			// `400 property relay should not exist` and the only way to agree to relaying
			// was to write the row by hand.
			await put(ownLibraryId, { relay: true }).expect(200);

			expect((await stored(ownLibraryId))?.relay).toBe(true);

			await put(ownLibraryId, { relay: false }).expect(200);

			expect((await stored(ownLibraryId))?.relay).toBe(false);
		});

		it('leaves every field the request did not name alone', async () => {
			await put(ownLibraryId, {
				visibility: ShareVisibility.FRIENDS,
				allowedPeerIds: [friendId],
				deniedPeerIds: [acquaintanceId],
				rateLimit: 2_097_152,
			}).expect(200);

			const before = await stored(ownLibraryId);

			await put(ownLibraryId, { rateLimit: 4_194_304 }).expect(200);

			const after = await stored(ownLibraryId);

			expect(after?.rateLimit).toBe(4_194_304);
			expect(after?.visibility).toBe(before?.visibility);
			expect(after?.allowedPeerIds).toEqual(before?.allowedPeerIds);
			expect(after?.deniedPeerIds).toEqual(before?.deniedPeerIds);
			expect(after?.relay).toBe(before?.relay);
		});

		it('says plainly whether a policy makes us a relay, in the list as well as on the write', async () => {
			// `relays` is a fact about the library, not a setting: it is the difference
			// between serving our own disk and passing on somebody else's server, and a
			// list that reported every library as a relay would make the flag useless on
			// the one screen that shows them all.
			await put(remoteLibraryId, { visibility: ShareVisibility.PRIVATE }).expect(200);

			expect((await stored(ownLibraryId))?.relays).toBe(false);
			expect((await stored(remoteLibraryId))?.relays).toBe(true);
		});

		it('refuses a library nobody holds', async () => {
			const response = await put('11111111-2222-4333-8444-555555555555', {
				visibility: ShareVisibility.FRIENDS,
			}).expect(404);

			expect(response.body).toMatchObject({ message: 'error.library.not_found' });
		});

		it('refuses a property the DTO never declared', async () => {
			const response = await put(ownLibraryId, { relays: false }).expect(400);

			expect((response.body as { message: string[] }).message.join(' ')).toContain('relays');
		});

		it('refuses a visibility that is not one, and a peer identifier that is not one', async () => {
			await put(ownLibraryId, { visibility: 'everybody' }).expect(400);
			await put(ownLibraryId, { allowedPeerIds: ['not-a-uuid'] }).expect(400);
			await put(ownLibraryId, { rateLimit: -1 }).expect(400);
		});
	});

	describe('relay consent', () => {
		beforeEach(async () => {
			// Back to private before each case: the rule is about what a change to
			// visibility is allowed to do, so the starting point has to be the same one.
			await request(context.app.getHttpServer())
				.delete(`/api/shares/${remoteLibraryId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);
		});

		it('refuses to share a library that is not ours without the agreement', async () => {
			const response = await put(remoteLibraryId, {
				visibility: ShareVisibility.FRIENDS,
			}).expect(409);

			expect(response.body).toMatchObject({ message: 'error.share.relay_not_agreed' });
		});

		it('refuses it for friends of friends too, which is the wider of the two', async () => {
			const response = await put(remoteLibraryId, {
				visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
			}).expect(409);

			expect(response.body).toMatchObject({ message: 'error.share.relay_not_agreed' });
		});

		it('allows it once somebody has said so out loud', async () => {
			const response = await put(remoteLibraryId, {
				visibility: ShareVisibility.FRIENDS,
				relay: true,
			}).expect(200);

			expect(response.body as SharePolicy).toMatchObject({ relays: true, relay: true });
		});

		it('allows a private policy on a remote library, because private relays nothing', async () => {
			const response = await put(remoteLibraryId, {
				visibility: ShareVisibility.PRIVATE,
			}).expect(200);

			expect(response.body as SharePolicy).toMatchObject({ relays: true, relay: false });
		});

		it('refuses withdrawing the agreement while the library is still shared', async () => {
			await put(remoteLibraryId, {
				visibility: ShareVisibility.FRIENDS,
				relay: true,
			}).expect(200);

			const response = await put(remoteLibraryId, { relay: false }).expect(409);

			expect(response.body).toMatchObject({ message: 'error.share.relay_not_agreed' });
			// And nothing was written: a refused change must not half apply.
			expect((await stored(remoteLibraryId))?.relay).toBe(true);
		});

		it('never asks it of one of our own libraries', async () => {
			await put(ownLibraryId, { visibility: ShareVisibility.FRIENDS_OF_FRIENDS }).expect(200);

			expect((await stored(ownLibraryId))?.relay).toBe(false);
		});
	});

	describe('deleting a policy', () => {
		it('makes the library private again, which is the same as never having shared it', async () => {
			await put(ownLibraryId, { visibility: ShareVisibility.FRIENDS }).expect(200);

			await request(context.app.getHttpServer())
				.delete(`/api/shares/${ownLibraryId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);

			expect(await stored(ownLibraryId)).toBeUndefined();
		});

		it('is the same answer twice, because the absence of a row is the whole state', async () => {
			await request(context.app.getHttpServer())
				.delete(`/api/shares/${ownLibraryId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(204);
		});
	});

	describe('the audit', () => {
		beforeAll(async () => {
			await put(ownLibraryId, {
				visibility: ShareVisibility.FRIENDS,
				allowedPeerIds: [],
				deniedPeerIds: [],
			}).expect(200);
			await put(remoteLibraryId, {
				visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
				relay: true,
			}).expect(200);
		});

		const audit = (peerId: string, identity: TestIdentity = admin): request.Test =>
			request(context.app.getHttpServer())
				.get(`/api/shares/audit/${peerId}`)
				.set('Authorization', `Bearer ${identity.token}`);

		it('answers what a friend would see, and says which of it goes through us', async () => {
			const response = await audit(friendId).expect(200);
			const result = response.body as ShareAudit;

			expect(result).toMatchObject({
				peerId: friendId,
				peerName: 'Alice',
				trust: PeerTrust.FRIEND,
			});
			expect(result.libraries.map((library) => library.libraryId).sort()).toEqual(
				[ownLibraryId, remoteLibraryId].sort(),
			);
			expect(
				result.libraries.find((library) => library.libraryId === remoteLibraryId),
			).toMatchObject({ throughUs: true, itemCount: 4 });
			expect(
				result.libraries.find((library) => library.libraryId === ownLibraryId),
			).toMatchObject({ throughUs: false, itemCount: 12 });
		});

		it('answers a friend of a friend with only what that reaches', async () => {
			// A friend of a friend is not a friend: the `friends` library is invisible to
			// them, and the whole point of the trust level is that this line exists.
			const response = await audit(acquaintanceId).expect(200);

			expect((response.body as ShareAudit).libraries.map((library) => library.libraryId)).toEqual(
				[remoteLibraryId],
			);
		});

		it('is served rather than read as a library identifier', async () => {
			await audit(friendId).expect(200);
		});

		it('answers a key for a peer nobody linked to', async () => {
			const response = await audit('11111111-2222-4333-8444-555555555555').expect(404);

			expect(response.body).toMatchObject({ message: 'error.peer.not_found' });
		});
	});

	describe('rights', () => {
		it('refuses a guest, on every route', async () => {
			await list(guest).expect(403);
			await put(ownLibraryId, { visibility: ShareVisibility.PRIVATE }, guest).expect(403);
			await request(context.app.getHttpServer())
				.delete(`/api/shares/${ownLibraryId}`)
				.set('Authorization', `Bearer ${guest.token}`)
				.expect(403);
			await request(context.app.getHttpServer())
				.get(`/api/shares/audit/${friendId}`)
				.set('Authorization', `Bearer ${guest.token}`)
				.expect(403);
		});

		it('refuses an anonymous caller entirely', async () => {
			await request(context.app.getHttpServer()).get('/api/shares').expect(401);
		});
	});
});
