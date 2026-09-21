import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceType,
	SyncState,
	TransferErrorKind,
	TransferState,
	UserRole,
	type Transfer,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	TransferRepository,
} from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * Removing a service while it is still feeding the queue, over HTTP.
 *
 * Its transfers used to outlive it: still queued, paused or mid-download, they failed
 * later on a source nobody could find, and read in the queue as a fault to chase. The
 * removal now stops them there and then, as cancelled with a reason of its own — and
 * leaves what already finished alone, because that is the history of what was pulled.
 *
 * Against a real database because the whole question is which rows the join from a
 * transfer to its source item's service reaches, before the cascade takes the items
 * away; a fake repository would only answer what the test told it to.
 */
describe('Removing a service with transfers still in the queue', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let removedServiceId: string;
	const ids: Record<string, string> = {};

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);
		const transfers = context.app.get(TransferRepository);

		const source = async (name: string, port: number): Promise<{ serviceId: string; itemId: string }> => {
			const service = await services.save(
				services.create({
					name,
					type: MediaServiceType.JELLYFIN,
					filesMounted: false,
					baseUrl: `http://127.0.0.1:${port}`,
				}),
			);
			const library = await libraries.save(
				libraries.create({
					serviceId: service.id,
					externalId: `${name}-shows`,
					name: 'Shows',
					kind: LibraryKind.SHOWS,
					paths: ['/srv/shows'],
				}),
			);
			const item = await items.save(
				items.create({
					serviceId: service.id,
					libraryId: library.id,
					externalId: `${name}-s01e01`,
					kind: MediaKind.EPISODE,
					title: 'Pilot',
					normalizedTitle: 'pilot',
					syncState: SyncState.MISSING,
				}),
			);

			return { serviceId: service.id, itemId: item.id };
		};

		const removed = await source('leaving', 61);
		const staying = await source('staying', 62);

		removedServiceId = removed.serviceId;

		const seed = async (key: string, itemId: string, state: TransferState): Promise<void> => {
			const id = randomUUID();

			ids[key] = id;
			await transfers.save(
				transfers.create({
					id,
					itemId,
					title: key,
					state,
					targetPath: `/media/shows/${key}.mkv`,
					targetLibraryId: null,
					workPath: `/var/transfer/${id}.part`,
					bytesTotal: 4_000,
					bytesDone: state === TransferState.DONE ? 4_000 : 1_000,
					chunkSize: 1_000,
					chunksTotal: 4,
					errorKind: state === TransferState.FAILED ? TransferErrorKind.NETWORK : null,
				}),
			);
		};

		await seed('queued', removed.itemId, TransferState.QUEUED);
		await seed('downloading', removed.itemId, TransferState.DOWNLOADING);
		await seed('paused', removed.itemId, TransferState.PAUSED);
		await seed('done', removed.itemId, TransferState.DONE);
		await seed('failed', removed.itemId, TransferState.FAILED);
		await seed('elsewhere', staying.itemId, TransferState.QUEUED);

		await request(context.app.getHttpServer())
			.delete(`/api/services/${removedServiceId}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(204);
	});

	afterAll(async () => {
		await context.close();
	});

	const read = async (key: string): Promise<Transfer> =>
		(
			await request(context.app.getHttpServer())
				.get(`/api/transfers/${ids[key]}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200)
		).body as Transfer;

	it.each(['queued', 'downloading', 'paused'])(
		'cancels a %s transfer from it, saying the service was removed',
		async (key) => {
			const transfer = await read(key);

			expect(transfer.state).toBe(TransferState.CANCELLED);
			expect(transfer.errorKind).toBe(TransferErrorKind.SERVICE_REMOVED);
			expect(transfer.finishedAt).not.toBeNull();
		},
	);

	it('leaves what already finished as it was, as history', async () => {
		expect(await read('done')).toMatchObject({ state: TransferState.DONE, errorKind: null });
		expect(await read('failed')).toMatchObject({
			state: TransferState.FAILED,
			errorKind: TransferErrorKind.NETWORK,
		});
	});

	it('does not touch a transfer from another service', async () => {
		expect(await read('elsewhere')).toMatchObject({ state: TransferState.QUEUED, errorKind: null });
	});

	it('removed the service itself', async () => {
		await request(context.app.getHttpServer())
			.get(`/api/services/${removedServiceId}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(404);
	});
});
