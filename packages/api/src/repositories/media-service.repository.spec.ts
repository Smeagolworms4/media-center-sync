import type { DataSource } from 'typeorm';
import {
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
	PeerStatus,
	PeerTrust,
} from '@mcs/shared';
import { Peer } from '@/entities';
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

	it('never offers a service reached through a peer as somewhere to write', async () => {
		/*
		 * The files are on somebody else's disk.
		 *
		 * The scope is written `local` here on purpose, because that is the only way
		 * this can go wrong: a row that arrived local by a bug or by a hand on the
		 * database. Planning a transfer onto it would write to a path that does not
		 * exist on this machine, and the failure would arrive at the end of a completed
		 * download rather than before it started.
		 */
		const peer = await dataSource.getRepository(Peer).save(
			dataSource.getRepository(Peer).create({
				name: 'Alice',
				fingerprint: 'a'.repeat(64),
				status: PeerStatus.LINKED,
				trust: PeerTrust.FRIEND,
			}),
		);

		await aService('home', MediaServiceScope.LOCAL, 10);
		await services.save(
			services.create({
				name: 'Alice',
				type: MediaServiceType.PEER,
				scope: MediaServiceScope.LOCAL,
				baseUrl: `peer://${peer.id}`,
				peerId: peer.id,
				priority: 500,
			}),
		);

		const destinations = await services.findLocal();

		expect(destinations.map((service) => service.name)).toEqual(['home']);
		// And it is still there to read from: excluded as a destination, never hidden.
		await expect(services.findByPeer(peer.id)).resolves.toHaveLength(1);
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
