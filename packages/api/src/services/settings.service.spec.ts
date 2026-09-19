import { NamingScheme, PlacementStrategy } from '@mcs/shared';
import type { SettingRepository } from '@/repositories';
import { CacheService } from './cache.service';
import { DEFAULT_SETTINGS, SettingsService } from './settings.service';

describe('SettingsService', () => {
	let stored: Map<string, string>;
	let repository: { findAllAsMap: jest.Mock; putMany: jest.Mock };
	let cache: CacheService;
	let service: SettingsService;

	beforeEach(() => {
		delete process.env.REDIS_HOST;
		stored = new Map();
		repository = {
			findAllAsMap: jest.fn(async () => stored),
			putMany: jest.fn(async (values: Record<string, string>) => {
				for (const [key, value] of Object.entries(values)) {
					stored.set(key, value);
				}
			}),
		};
		cache = new CacheService();
		service = new SettingsService(repository as unknown as SettingRepository, cache);
	});

	afterEach(async () => {
		await cache.onModuleDestroy();
	});

	it('answers with the defaults when nothing has been stored', async () => {
		expect(await service.get()).toEqual(DEFAULT_SETTINGS);
	});

	it('overlays what has been stored on top of the defaults', async () => {
		stored.set('maxParallelTransfers', '6');
		stored.set('naming', '"standard"');

		const settings = await service.get();

		expect(settings.maxParallelTransfers).toBe(6);
		expect(settings.naming).toBe(NamingScheme.STANDARD);
		expect(settings.chunkSize).toBe(DEFAULT_SETTINGS.chunkSize);
	});

	it('reads the database once and then answers from memory', async () => {
		await service.get();
		await service.get();

		expect(repository.findAllAsMap).toHaveBeenCalledTimes(1);
	});

	it('forgets its copy when asked', async () => {
		await service.get();
		service.invalidate();
		await service.get();

		expect(repository.findAllAsMap).toHaveBeenCalledTimes(2);
	});

	it('ignores a row it cannot read rather than refusing to start', async () => {
		stored.set('chunkSize', 'not json at all');

		expect((await service.get()).chunkSize).toBe(DEFAULT_SETTINGS.chunkSize);
	});

	it('ignores a stored value of the wrong shape', async () => {
		// A `chunkSize` of `"8MB"` coerced to `NaN` would produce a plan of zero chunks
		// and fail much later and much less clearly.
		stored.set('chunkSize', '"8MB"');

		expect((await service.get()).chunkSize).toBe(DEFAULT_SETTINGS.chunkSize);
	});

	it('clamps a stored value that is out of range instead of failing to boot', async () => {
		stored.set('maxParallelTransfers', '9999');

		expect((await service.get()).maxParallelTransfers).toBe(32);
	});

	it('keeps a disk reserve somebody can actually run against', async () => {
		// Zero is a real answer — fill the disk to the last byte, on a machine that holds
		// nothing else — and a reserve larger than most libraries would refuse every run
		// for room that is never going to be used.
		await expect(service.update({ diskReserveBytes: 0 })).resolves.toBeDefined();
		await expect(service.update({ diskReserveBytes: 2 * 1024 ** 4 })).rejects.toThrow();

		stored.set('diskReserveBytes', String(9 * 1024 ** 4));

		service.invalidate();

		expect((await service.get()).diskReserveBytes).toBe(1024 ** 4);
	});

	it('writes only the keys it was given', async () => {
		await service.update({ maxParallelTransfers: 5 });

		expect(repository.putMany).toHaveBeenCalledWith({ maxParallelTransfers: '5' });
		expect((await service.get()).maxParallelTransfers).toBe(5);
	});

	it('stores values as JSON so their type survives the round trip', async () => {
		await service.update({ pullMetadata: false, fixedPath: null });

		expect(repository.putMany).toHaveBeenCalledWith({
			pullMetadata: 'false',
			fixedPath: 'null',
		});
	});

	it('refuses a fixed-path strategy with no path', async () => {
		// Accepting it leaves a strategy the gateway cannot execute, discovered only
		// when a transfer finishes and has nowhere to go.
		await expect(
			service.update({ placement: PlacementStrategy.FIXED_PATH, fixedPath: '  ' }),
		).rejects.toMatchObject({ response: { key: 'error.settings.invalid', field: 'fixedPath' } });
	});

	it('refuses a value outside its bounds', async () => {
		await expect(service.update({ maxConnectionsPerSource: 99 })).rejects.toMatchObject({
			response: { key: 'error.settings.invalid', field: 'maxConnectionsPerSource' },
		});
	});

	it('refuses a strategy that does not exist', async () => {
		await expect(
			service.update({ placement: 'sideways' as PlacementStrategy }),
		).rejects.toMatchObject({ response: { field: 'placement' } });
	});

	it('writes nothing when a write is refused', async () => {
		await expect(service.update({ matchThreshold: 5 })).rejects.toBeDefined();
		expect(repository.putMany).not.toHaveBeenCalled();
	});

	it('hands the cache its lifetime so one setting governs both', async () => {
		const setDefaultTtl = jest.spyOn(cache, 'setDefaultTtl');

		await service.update({ cacheTtlSeconds: 120 });

		expect(setDefaultTtl).toHaveBeenCalledWith(120);
	});

	it('answers a single value', async () => {
		expect(await service.getValue('allowSwarm')).toBe(DEFAULT_SETTINGS.allowSwarm);
	});
});
