import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { LibraryKind, MediaServiceType, SyncTrigger, UserRole, type SyncPlan } from '@mcs/shared';
import { LibraryRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * The destination a plan keeps between runs, over HTTP.
 *
 * A file of its own rather than more of `sync.spec.ts`, which is about what a run
 * plans and does. The question here is different and worth isolating: a preference is
 * a *stored* decision, so what has to be proved is that it survives a write and a read
 * unchanged, and that a library which could never receive a file is refused at the
 * moment somebody chooses it rather than at four in the morning when the schedule
 * fires and nobody is watching.
 *
 * Both refusals are asserted by key. The interface words them, and a route that
 * answered a sentence would make every catalogue a place the API can break.
 */
describe('The destination a sync plan prefers', () => {
	let context: TestApp;
	let manager: TestIdentity;
	let ourLibraryId: string;
	let theirLibraryId: string;
	let unmappedLibraryId: string;

	beforeAll(async () => {
		context = await createTestApp();
		manager = await signInAs(context, UserRole.ADMIN);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const ourPath = mkdtempSync(join(tmpdir(), 'mcs-plan-target-'));

		const ours = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:41',
			}),
		);

		// One of ours in every other respect, and its files are somewhere this gateway
		// cannot reach: the sharing switch says nothing about that, which is the whole
		// point of testing it separately from the peer below.
		const remote = await services.save(
			services.create({
				name: 'Attic server',
				type: MediaServiceType.JELLYFIN,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:43',
			}),
		);

		const theirs = await services.save(
			services.create({
				name: "A friend's server",
				type: MediaServiceType.JELLYFIN,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:42',
			}),
		);

		const shelf = async (
			serviceId: string,
			externalId: string,
			name: string,
			localPath: string | null,
		): Promise<string> =>
			(
				await libraries.save(
					libraries.create({
						serviceId,
						externalId,
						name,
						kind: LibraryKind.SHOWS,
						paths: [localPath ?? '/media/elsewhere'],
						localPath,
						writable: true,
					}),
				)
			).id;

		ourLibraryId = await shelf(ours.id, 'lib-anime', 'Animes', ourPath);
		theirLibraryId = await shelf(theirs.id, 'lib-their-shows', 'Their shows', '/media/theirs');
		unmappedLibraryId = await shelf(remote.id, 'lib-attic', 'Attic shows', null);
	});

	afterAll(async () => {
		await context.close();
	});

	const post = (body: Record<string, unknown>): request.Test =>
		request(context.app.getHttpServer())
			.post('/api/sync/plans')
			.set('Authorization', `Bearer ${manager.token}`)
			.send({
				name: 'Animes, nightly',
				trigger: SyncTrigger.MANUAL,
				scope: { categoryKeys: ['animes'] },
				...body,
			});

	/**
	 * The round trip, which is the whole of piece two on this side of the wire.
	 *
	 * Written, read back on the plan, and read back again in the list: a preference
	 * that survived the write but not the listing would look set on the form somebody
	 * had just filled in and unset everywhere else.
	 */
	it('is stored on the plan and comes back on every reading of it', async () => {
		const created = (await post({ preferredLibraryId: ourLibraryId }).expect(201))
			.body as SyncPlan;

		expect(created.preferredLibraryId).toBe(ourLibraryId);

		const read = (
			await request(context.app.getHttpServer())
				.get(`/api/sync/plans/${created.id}`)
				.set('Authorization', `Bearer ${manager.token}`)
				.expect(200)
		).body as SyncPlan;

		expect(read.preferredLibraryId).toBe(ourLibraryId);

		const listed = (
			await request(context.app.getHttpServer())
				.get('/api/sync/plans')
				.set('Authorization', `Bearer ${manager.token}`)
				.expect(200)
		).body as SyncPlan[];

		expect(listed.find((plan) => plan.id === created.id)?.preferredLibraryId).toBe(
			ourLibraryId,
		);
	});

	it('can be changed, and cleared, on the plan like any other field', async () => {
		const created = (await post({}).expect(201)).body as SyncPlan;

		const patch = (preferredLibraryId: string | null): request.Test =>
			request(context.app.getHttpServer())
				.patch(`/api/sync/plans/${created.id}`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ preferredLibraryId });

		expect(((await patch(ourLibraryId).expect(200)).body as SyncPlan).preferredLibraryId).toBe(
			ourLibraryId,
		);
		// Clearing is always allowed: it asks for the ordinary rules back, and those
		// cannot be unreachable.
		expect(((await patch(null).expect(200)).body as SyncPlan).preferredLibraryId).toBeNull();
	});

	/**
	 * The refusal the destination rule exists for.
	 *
	 * A library on somebody else's server is a directory this gateway will never write
	 * into. A plan pointed at one is not a plan that fails — it is a plan that quietly
	 * places everything somewhere else for ever, with nothing anywhere saying why.
	 */
	it('refuses a library that belongs to a peer', async () => {
		const response = await post({ preferredLibraryId: theirLibraryId }).expect(409);

		expect(response.body).toMatchObject({ message: 'error.transfer.destination_invalid' });
	});

	it('refuses one of ours whose files this gateway cannot reach', async () => {
		const response = await post({ preferredLibraryId: unmappedLibraryId }).expect(409);

		expect(response.body).toMatchObject({ message: 'error.transfer.destination_invalid' });
	});

	it('refuses a library nobody has', async () => {
		const response = await post({
			preferredLibraryId: '11111111-2222-4333-8444-555555555555',
		}).expect(404);

		expect(response.body).toMatchObject({ message: 'error.library.not_found' });
	});

	/** A library is an identifier. A path is a string somebody typed, and is refused. */
	it('refuses a path where a library identifier belongs', async () => {
		await post({ preferredLibraryId: '/media/somewhere' }).expect(400);
	});
});
