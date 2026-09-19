import type { DataSource } from 'typeorm';
import { MediaServiceScope, MediaServiceStatus, MediaServiceType } from '@mcs/shared';
import { createTestDataSource } from '../../test/utils/database';
import { MediaServiceRepository } from './media-service.repository';

describe('MediaServiceRepository', () => {
	let dataSource: DataSource;
	let services: MediaServiceRepository;

	beforeEach(async () => {
		dataSource = await createTestDataSource();
		services = new MediaServiceRepository(dataSource);
	});

	afterEach(async () => {
		await dataSource.destroy();
	});

	const aService = (name: string, scope: MediaServiceScope, priority: number) =>
		services.save(
			services.create({
				name,
				type: MediaServiceType.JELLYFIN,
				scope,
				baseUrl: `http://${name}.test`,
				priority,
				token: `${name}-token`,
			}),
		);

	it('keeps the credentials out of an ordinary read', async () => {
		const saved = await aService('home', MediaServiceScope.LOCAL, 10);

		const read = await services.findOne({ where: { id: saved.id } });

		// This is what makes returning an entity from a controller safe: the column is
		// simply not in the row, so no serialisation step has to remember to remove it.
		expect(read?.token).toBeUndefined();
	});

	it('brings the credentials back only when they are asked for', async () => {
		const saved = await aService('home', MediaServiceScope.LOCAL, 10);

		await expect(services.findWithSecrets(saved.id)).resolves.toMatchObject({
			token: 'home-token',
		});
	});

	it('answers nothing for a service that does not exist', async () => {
		await expect(services.findWithSecrets('missing')).resolves.toBeNull();
	});

	it('separates the services it can write into from the ones it only reads', async () => {
		await aService('home', MediaServiceScope.LOCAL, 10);
		await aService('friend', MediaServiceScope.REMOTE, 20);

		await expect(services.findLocal()).resolves.toHaveLength(1);
		await expect(services.findRemote()).resolves.toHaveLength(1);
	});

	it('lists services lowest priority first, which is the order a sync consults them', async () => {
		await aService('third', MediaServiceScope.REMOTE, 30);
		await aService('first', MediaServiceScope.LOCAL, 10);
		await aService('second', MediaServiceScope.REMOTE, 20);

		const ordered = await services.findByPriority();

		expect(ordered.map((service) => service.name)).toEqual(['first', 'second', 'third']);
	});

	it('records a probe result', async () => {
		const saved = await aService('home', MediaServiceScope.LOCAL, 10);

		await services.setStatus(saved.id, MediaServiceStatus.ONLINE, '10.9.0');

		await expect(services.findOne({ where: { id: saved.id } })).resolves.toMatchObject({
			status: MediaServiceStatus.ONLINE,
			version: '10.9.0',
		});
	});
});
