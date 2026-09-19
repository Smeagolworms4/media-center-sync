import {
	ErrorKey,
	EventName,
	LibraryKind,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType,
	type MediaServiceProbe,
} from '@mcs/shared';
import { ConflictException } from '@nestjs/common';
import type { Library, MediaService } from '@/entities';
import type {
	LibraryRepository,
	MediaItemRepository,
	MediaMatchRepository,
	MediaServiceRepository,
} from '@/repositories';
import type {
	EventGatewayService,
	FingerprintService,
	HandlerRegistry,
	QualityService,
} from '@/services';
import type { MediaManager } from './media.manager';
import { ServiceManager } from './service.manager';

const probe = (overrides: Partial<MediaServiceProbe> = {}): MediaServiceProbe => ({
	reachable: true,
	authenticated: true,
	type: MediaServiceType.JELLYFIN,
	version: '10.9.0',
	serverName: 'Living room',
	libraries: [{ externalId: 'lib-1', name: 'Shows', kind: LibraryKind.SHOWS, paths: ['/media/shows'] }],
	error: null,
	...overrides,
});

const service = (overrides: Partial<MediaService> = {}): MediaService =>
	({
		id: 'service-1',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		scope: MediaServiceScope.LOCAL,
		baseUrl: 'http://jellyfin:8096',
		token: 'api-key',
		username: null,
		password: null,
		status: MediaServiceStatus.ONLINE,
		version: '10.9.0',
		authProvider: false,
		priority: 100,
		peerId: null,
		lastProbeAt: null,
		lastScanAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaService;

interface Fakes {
	services: {
		find: jest.Mock;
		findOne: jest.Mock;
		findByPriority: jest.Mock;
		findByBaseUrl: jest.Mock;
		findWithSecrets: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
		update: jest.Mock;
		delete: jest.Mock;
		setStatus: jest.Mock;
		count: jest.Mock;
	};
	libraries: {
		count: jest.Mock;
		findByService: jest.Mock;
		findByExternalId: jest.Mock;
		create: jest.Mock;
		save: jest.Mock;
	};
	matches: { deleteForService: jest.Mock; deleteForItems: jest.Mock };
	probe: jest.Mock;
	events: { emit: jest.Mock };
}

const build = (): { manager: ServiceManager; fakes: Fakes } => {
	const fakes: Fakes = {
		services: {
			find: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(service()),
			findByPriority: jest.fn().mockResolvedValue([service()]),
			findByBaseUrl: jest.fn().mockResolvedValue(null),
			findWithSecrets: jest.fn().mockResolvedValue(service()),
			create: jest.fn((value: Partial<MediaService>) => service(value)),
			save: jest.fn((value: MediaService) => Promise.resolve(value)),
			update: jest.fn().mockResolvedValue(undefined),
			delete: jest.fn().mockResolvedValue(undefined),
			setStatus: jest.fn().mockResolvedValue(undefined),
			count: jest.fn().mockResolvedValue(0),
		},
		libraries: {
			count: jest.fn().mockResolvedValue(1),
			findByService: jest.fn().mockResolvedValue([]),
			findByExternalId: jest.fn().mockResolvedValue(null),
			create: jest.fn((value: Partial<Library>) => value as Library),
			save: jest.fn((value: Library) => Promise.resolve(value)),
		},
		matches: {
			deleteForService: jest.fn().mockResolvedValue(0),
			deleteForItems: jest.fn().mockResolvedValue(0),
		},
		probe: jest.fn().mockResolvedValue(probe()),
		events: { emit: jest.fn() },
	};

	const manager = new ServiceManager(
		fakes.services as unknown as MediaServiceRepository,
		fakes.libraries as unknown as LibraryRepository,
		{
			countByService: jest.fn().mockResolvedValue(12),
			findFingerprintable: jest.fn().mockResolvedValue([]),
		} as unknown as MediaItemRepository,
		// Fingerprinting only runs for a library with a local path, and none of these
		// tests declares one.
		{} as unknown as FingerprintService,
		fakes.matches as unknown as MediaMatchRepository,
		{
			find: jest.fn(() => ({ probe: fakes.probe })),
			get: jest.fn(() => ({ probe: fakes.probe })),
		} as unknown as HandlerRegistry,
		{} as unknown as QualityService,
		{ correlateService: jest.fn().mockResolvedValue(0) } as unknown as MediaManager,
		fakes.events as unknown as EventGatewayService,
	);

	return { manager, fakes };
};

describe('ServiceManager', () => {
	describe('registering', () => {
		it('refuses the same base URL on the same side twice', async () => {
			const { manager, fakes } = build();

			fakes.services.findByBaseUrl.mockResolvedValue(service());

			await expect(
				manager.create({
					name: 'Living room again',
					type: MediaServiceType.JELLYFIN,
					scope: MediaServiceScope.LOCAL,
					baseUrl: 'http://jellyfin:8096',
				}),
			).rejects.toThrow(ConflictException);

			expect(fakes.services.save).not.toHaveBeenCalled();
		});

		it('treats a trailing slash as the same server, which the index does not', async () => {
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://jellyfin:8096/',
			});

			expect(fakes.services.findByBaseUrl).toHaveBeenCalledWith('http://jellyfin:8096', null);
			expect((fakes.services.create.mock.calls[0][0] as MediaService).baseUrl).toBe(
				'http://jellyfin:8096',
			);
		});

		it('records what the probe said instead of assuming the service works', async () => {
			const { manager, fakes } = build();

			fakes.probe.mockResolvedValue(probe({ reachable: true, authenticated: false }));

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://jellyfin:8096',
			});

			expect((fakes.services.create.mock.calls[0][0] as MediaService).status).toBe(
				MediaServiceStatus.UNAUTHORIZED,
			);
		});

		it('creates the libraries the probe reported', async () => {
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				scope: MediaServiceScope.LOCAL,
				baseUrl: 'http://jellyfin:8096',
			});

			expect(fakes.libraries.create).toHaveBeenCalledWith(
				expect.objectContaining({ externalId: 'lib-1', kind: LibraryKind.SHOWS }),
			);
		});

		it('leaves a library’s local path alone when the service renames it', async () => {
			const { manager, fakes } = build();

			fakes.libraries.findByExternalId.mockResolvedValue({
				id: 'library-1',
				name: 'Old name',
				localPath: '/mnt/nas/shows',
				writable: true,
				isDefaultTarget: true,
			} as Library);

			await manager.probe('service-1');

			const saved = fakes.libraries.save.mock.calls[0][0] as Library;

			expect(saved.name).toBe('Shows');
			expect(saved.localPath).toBe('/mnt/nas/shows');
			expect(saved.isDefaultTarget).toBe(true);
		});
	});

	describe('probing', () => {
		it('answers rather than throwing when the server is unreachable', async () => {
			const { manager, fakes } = build();

			fakes.probe.mockRejectedValue(new Error('ECONNREFUSED'));

			await expect(
				manager.probeUnregistered({
					type: MediaServiceType.JELLYFIN,
					baseUrl: 'http://nowhere:8096',
				}),
			).resolves.toMatchObject({ reachable: false, error: ErrorKey.SERVICE_UNREACHABLE });
		});

		it('answers a handler nobody wrote rather than failing to start', async () => {
			const { manager } = build();
			const manager2 = manager as unknown as { _handlers: { find: jest.Mock } };

			manager2._handlers.find.mockReturnValue(null);

			await expect(
				manager.probeUnregistered({
					type: MediaServiceType.JELLYFIN,
					baseUrl: 'http://nowhere:8096',
				}),
			).resolves.toMatchObject({ error: ErrorKey.SERVICE_HANDLER_UNKNOWN });
		});

		it('records the status on the row and tells the interface', async () => {
			const { manager, fakes } = build();

			await manager.probe('service-1');

			expect(fakes.services.setStatus).toHaveBeenCalledWith(
				'service-1',
				MediaServiceStatus.ONLINE,
				'10.9.0',
				expect.any(Date),
			);
			expect(fakes.events.emit).toHaveBeenCalledWith(
				EventName.SERVICE_STATUS,
				expect.objectContaining({ id: 'service-1', status: MediaServiceStatus.ONLINE }),
			);
		});
	});

	describe('updating', () => {
		it('keeps the stored token when the form did not send one', async () => {
			const { manager, fakes } = build();

			await manager.update('service-1', { name: 'Renamed' });

			const saved = fakes.services.save.mock.calls[0][0] as MediaService;

			expect(saved.name).toBe('Renamed');
			expect(saved.token).toBe('api-key');
		});

		it('re-probes when something that decides reachability moved', async () => {
			const { manager, fakes } = build();

			await manager.update('service-1', { token: 'a-new-key' });

			expect(fakes.services.setStatus).toHaveBeenCalled();
		});

		it('leaves the status alone for a rename', async () => {
			const { manager, fakes } = build();

			await manager.update('service-1', { name: 'Renamed' });

			expect(fakes.services.setStatus).not.toHaveBeenCalled();
		});
	});

	describe('removing', () => {
		it('deletes the matches a foreign key could never have reached', async () => {
			const { manager, fakes } = build();

			await manager.remove('service-1');

			expect(fakes.matches.deleteForService).toHaveBeenCalledWith('service-1');
			expect(fakes.services.delete).toHaveBeenCalledWith({ id: 'service-1' });
		});

		it('answers a key for a service nobody registered', async () => {
			const { manager, fakes } = build();

			fakes.services.findOne.mockResolvedValue(null);

			await expect(manager.remove('ghost')).rejects.toThrow(ErrorKey.SERVICE_NOT_FOUND);
		});
	});

	describe('indexing', () => {
		it('never lets a second scan of the same service race the first', async () => {
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([]);

			await manager.scan('service-1');
			await manager.scan('service-1');
			// The walk is detached from the request, so the assertions wait for the queue
			// to drain rather than for the call that started it.
			await new Promise((resolve) => setImmediate(resolve));

			// Both calls answered `202`; only the first one walks. Two passes would write
			// the same rows, and the loser's stale-item sweep would delete what the winner
			// had just written.
			expect(fakes.services.findWithSecrets).toHaveBeenCalledTimes(1);
		});
	});

	it('never lets a token into the shape it hands back', async () => {
		const { manager } = build();

		const listed = await manager.list();

		expect(listed[0]).not.toHaveProperty('token');
		expect(listed[0]).not.toHaveProperty('password');
		expect(listed[0].itemCount).toBe(12);
	});
});
