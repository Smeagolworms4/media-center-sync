import { MAX_PEER_MAX_DEPTH, NamingScheme, PlacementStrategy } from '@mcs/shared';
import type { ConfigService } from '@nestjs/config';
import type { SettingRepository } from '@/repositories';
import { CacheService } from './cache.service';
import {
	DEFAULT_SETTINGS,
	normalisePublicUrl,
	normaliseTargetPath,
	SettingsService,
} from './settings.service';

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
		service = new SettingsService(
			repository as unknown as SettingRepository,
			cache,
			// No pin: these tests are about the stored values, and a pinned field is one
			// the stored value no longer decides.
			{ get: () => ({ maxDepth: null }) } as unknown as ConfigService,
		);
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

	it('stores the address the gateway is reached at, normalised', async () => {
		await service.update({ publicUrl: 'https://mcs.example.org/interface/' });

		expect((await service.get()).publicUrl).toBe('https://mcs.example.org');
	});

	it('refuses an address nothing could dial, naming the field', async () => {
		await expect(service.update({ publicUrl: 'mcs.example.org' })).rejects.toMatchObject({
			response: { key: 'error.settings.public_url_invalid', field: 'publicUrl' },
		});
	});

	it('takes an emptied box as a clearing rather than as an empty address', async () => {
		await service.update({ publicUrl: 'https://mcs.example.org' });
		await service.update({ publicUrl: '' });

		// Null and not the empty string: an origin of '' concatenated into a share link
		// makes a link to this gateway's own interface, which looks like it worked.
		expect(repository.putMany).toHaveBeenLastCalledWith({ publicUrl: 'null' });
		expect((await service.get()).publicUrl).toBeNull();
	});

	it('clears the fallback target rather than storing an empty string', async () => {
		await service.update({ defaultTargetPath: '  ' });

		expect((await service.get()).defaultTargetPath).toBeNull();
	});

	it('refuses a fallback target that is not absolute', async () => {
		await expect(service.update({ defaultTargetPath: 'incoming' })).rejects.toMatchObject({
			response: { key: 'error.settings.target_path_invalid', field: 'defaultTargetPath' },
		});
	});

	/**
	 * A stored value whose default is null has to survive the read, and did not.
	 *
	 * The shape guard compared `typeof` against the default, which answers `object` for
	 * every setting that defaults to null — so `publicUrl`, `instanceName` and
	 * `defaultTargetLibraryId` were dropped on the way out of the database. Nothing
	 * reported it and no test caught it, because a write keeps its own copy in memory
	 * and answers every later read from it: the value came back correctly until the
	 * process restarted, and then it was simply gone.
	 */
	it('reads back a setting whose default is null, which a restart used to lose', async () => {
		await service.update({ defaultTargetLibraryId: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b' });

		service.invalidate();

		expect((await service.get()).defaultTargetLibraryId).toBe(
			'6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
		);
	});

	it('takes an emptied select as no choice rather than as a library called nothing', async () => {
		await service.update({ defaultTargetLibraryId: '  ' });

		expect((await service.get()).defaultTargetLibraryId).toBeNull();
	});

	it('keeps the category table across a restart, and each entry in it', async () => {
		await service.update({
			categoryTargets: { animes: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b' },
		});

		service.invalidate();

		expect((await service.get()).categoryTargets).toEqual({
			animes: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
		});
	});

	it('answers an empty category table before anybody has configured one', async () => {
		// Empty and not a guess: filing somebody's first anime in whichever library
		// carries the default-target flag is the silent wrong destination this table was
		// added to stop.
		expect((await service.get()).categoryTargets).toEqual({});
		expect((await service.get()).defaultTargetLibraryId).toBeNull();
	});

	it('ignores a category table that got into the row as something else', async () => {
		// Every reader indexes into it, so a stored null or list would turn the next
		// placement lookup into a thrown error rather than into "nothing configured".
		stored.set('categoryTargets', 'null');

		expect((await service.get()).categoryTargets).toEqual({});

		service.invalidate();
		stored.set('categoryTargets', '["lib-1"]');

		expect((await service.get()).categoryTargets).toEqual({});
	});

	it('drops a text setting it cannot make sense of instead of refusing to start', async () => {
		// Written by hand or by an older version. Refusing it on read would lock somebody
		// out of the one screen where they would have corrected it.
		stored.set('publicUrl', '"not a url at all"');

		expect((await service.get()).publicUrl).toBeNull();
	});

	it('does not hold an unusable stored value against a later write', async () => {
		stored.set('publicUrl', '"not a url at all"');

		await expect(service.update({ maxParallelTransfers: 5 })).resolves.toBeDefined();
	});

	describe('what the environment pins', () => {
		const pinned = (maxDepth: number | null): SettingsService =>
			new SettingsService(
				repository as unknown as SettingRepository,
				cache,
				{ get: () => ({ maxDepth }) } as unknown as ConfigService,
			);

		it('overrides the stored value, so the pin is what actually applies', async () => {
			stored.set('peerMaxDepth', JSON.stringify(5));

			await expect(pinned(2).get()).resolves.toMatchObject({ peerMaxDepth: 2 });
		});

		it('names the pinned field, so a form can disable the control', async () => {
			await expect(pinned(2).view()).resolves.toMatchObject({ pinned: ['peerMaxDepth'] });
		});

		it('names nothing when nothing is pinned', async () => {
			await expect(pinned(null).view()).resolves.toMatchObject({ pinned: [] });
		});

		it('refuses a write to a pinned field rather than ignoring it', async () => {
			// Dropping it silently would have the screen report a successful save for a
			// value that did not move — the one outcome nobody can debug, because the
			// form redisplays the stored value and somebody concludes they mistyped.
			await expect(pinned(2).update({ peerMaxDepth: 4 })).rejects.toThrow();
		});

		it('accepts a write that agrees with the pin', async () => {
			// The whole form is saved at once, so the pinned field is sent back unchanged
			// on every save. Refusing that would make every other setting unsaveable.
			await expect(pinned(2).update({ peerMaxDepth: 2, maxParallelTransfers: 6 })).resolves
				.toMatchObject({ peerMaxDepth: 2, maxParallelTransfers: 6 });
		});

		it('brings a pin that is out of range back inside it', async () => {
			// An environment variable holds nonsense as readily as a form does, and a
			// pinned nonsense value cannot be corrected from the interface — which is
			// the whole point of having pinned it.
			await expect(pinned(99).get()).resolves.toMatchObject({
				peerMaxDepth: MAX_PEER_MAX_DEPTH,
			});
		});
	});
});

/**
 * The three addresses, pinned one input at a time.
 *
 * Table-driven because what matters is the whole set of shapes people type — a
 * trailing slash, a path, a scheme in the wrong box — and a table says which one
 * regressed without a stack of near-identical cases.
 */
describe('normalisePublicUrl', () => {
	it.each([
		['https://mcs.example.org', 'https://mcs.example.org'],
		// Everything downstream concatenates onto this, so the slash and the path go.
		['https://mcs.example.org/', 'https://mcs.example.org'],
		['https://mcs.example.org/sub/path?q=1', 'https://mcs.example.org'],
		['http://192.168.0.12:4200', 'http://192.168.0.12:4200'],
		// A default port is not part of an origin, and writing it back would make two
		// spellings of one address.
		['http://mcs.example.org:80', 'http://mcs.example.org'],
		['  https://mcs.example.org  ', 'https://mcs.example.org'],
		['', null],
		['   ', null],
		[null, null],
		[undefined, null],
	])('normalises %p to %p', (input, expected) => {
		expect(normalisePublicUrl(input)).toBe(expected);
	});

	it.each([
		['mcs.example.org'],
		['192.168.0.12:4200'],
		['ftp://mcs.example.org'],
		['javascript:alert(1)'],
		['not a url'],
	])('refuses %p', (input) => {
		expect(() => normalisePublicUrl(input)).toThrow();
	});
});

describe('normaliseTargetPath', () => {
	it.each([
		['/media/incoming', '/media/incoming'],
		['/media/incoming/', '/media/incoming'],
		['  /media/incoming  ', '/media/incoming'],
		['/', '/'],
		['', null],
		[null, null],
	])('normalises %p to %p', (input, expected) => {
		expect(normaliseTargetPath(input)).toBe(expected);
	});

	it.each([
		// Relative resolves against whatever directory the process was started in.
		['incoming'],
		['./incoming'],
		// A fallback that can climb out of where it was pointed can write anywhere.
		['/media/../etc'],
	])('refuses %p', (input) => {
		expect(() => normaliseTargetPath(input)).toThrow();
	});
});
