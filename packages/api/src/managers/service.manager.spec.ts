import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ErrorKey,
	EventName,
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	type MediaFileInfo,
	type MediaServiceProbe,
	type QualitySummary,
} from '@mcs/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Library, MediaItem, MediaService } from '@/entities';
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
	NormalisedMediaItem,
	QualityService,
} from '@/services';
import type { LandingManager } from './landing.manager';
import type { LibraryManager } from './library.manager';
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
		shared: true,
		filesMounted: true,
		baseUrl: 'http://jellyfin:8096',
		token: 'api-key',
		username: null,
		password: null,
		status: MediaServiceStatus.ONLINE,
		version: '10.9.0',
		authProvider: false,
		priority: 100,
		rootMappings: [],
		peerId: null,
		lastProbeAt: null,
		lastScanAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as MediaService;

/** A probed library whose kind the handler could not work out. See its two tests. */
const noKind = (entry: { externalId: string; name: string }): MediaServiceProbe['libraries'][number] =>
	({ ...entry, kind: null, paths: [] }) as unknown as MediaServiceProbe['libraries'][number];

const library = (overrides: Partial<Library> = {}): Library =>
	({
		id: 'library-1',
		serviceId: 'service-1',
		externalId: 'lib-1',
		name: 'Shows',
		alias: null,
		position: 100,
		kind: LibraryKind.SHOWS,
		paths: ['/media/shows'],
		localPath: null,
		writable: false,
		isDefaultTarget: false,
		lastScanAt: null,
		scanCursor: null,
		lastRefreshAt: null,
		itemCount: 0,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as Library;

const reported = (overrides: Partial<NormalisedMediaItem> = {}): NormalisedMediaItem => ({
	externalId: 'external-1',
	parentExternalId: null,
	kind: MediaKind.MOVIE,
	title: 'Arrival',
	normalizedTitle: 'arrival',
	year: 2016,
	seasonNumber: null,
	episodeNumber: null,
	externalIds: {},
	overview: null,
	artworkUrl: null,
	file: null,
	addedAt: null,
	...overrides,
});

const fileInfo = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
	path: '/media/shows/Arrival.mkv',
	size: 1_000,
	container: 'mkv',
	videoCodec: 'x265',
	audioCodec: 'eac3',
	width: 1920,
	height: 1080,
	durationMs: 1_000,
	bitrate: 1_000,
	quickHash: null,
	contentId: null,
	checksum: null,
	...overrides,
});

const row = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'row-0',
		serviceId: 'service-1',
		libraryId: 'library-1',
		externalId: 'external-1',
		parentId: null,
		kind: MediaKind.MOVIE,
		title: 'Arrival',
		normalizedTitle: 'arrival',
		year: 2016,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: null,
		artworkUrl: null,
		file: null,
		quality: null,
		companions: null,
		overrides: null,
		reported: null,
		ignored: false,
		addedAt: null,
		childCount: 0,
		...overrides,
	}) as MediaItem;

/** A handler's full scan, which is an async iterable rather than an array. */
const yielding = (items: NormalisedMediaItem[]): AsyncIterable<NormalisedMediaItem> => ({
	async *[Symbol.asyncIterator]() {
		for (const item of items) {
			yield item;
		}
	},
});

/**
 * Wait for the detached indexing pass.
 *
 * `scan` answers before the walk has done anything at all — that is the whole point
 * of it — so a test asserting straight afterwards would be asserting about an empty
 * index. The manager keeps the promise so a second call can join the first, and this
 * joins it the same way.
 */
const settle = async (manager: ServiceManager, serviceId = 'service-1'): Promise<void> => {
	await (manager as unknown as { _indexing: Map<string, Promise<void>> })._indexing.get(serviceId);
	await new Promise((resolve) => setImmediate(resolve));
};

interface ItemFakes {
	/** The index as it stands, so a test can assert what a scan actually wrote. */
	rows: MediaItem[];
	findByExternalId: jest.Mock;
	linkKnownParents: jest.Mock;
	findUnresolvedParents: jest.Mock;
	findStale: jest.Mock;
	findFingerprintable: jest.Mock;
	countByService: jest.Mock;
	create: jest.Mock;
	save: jest.Mock;
	find: jest.Mock;
	remove: jest.Mock;
}

/**
 * The item repository as a small store rather than a set of stubs.
 *
 * Everything worth testing in the indexing pass is about what ends up in the index —
 * an override that survived, a parent that was resolved, a row a full scan dropped —
 * and none of that is visible from a `save` that resolves whatever it was handed.
 */
const itemStore = (seed: MediaItem[] = []): ItemFakes => {
	const rows = [...seed];
	let sequence = rows.length;

	const put = (value: MediaItem): MediaItem => {
		const index = rows.findIndex((candidate) => candidate.id === value.id);

		if (index === -1) {
			rows.push(value);
		} else {
			rows[index] = value;
		}

		return value;
	};

	return {
		rows,
		findByExternalId: jest.fn((serviceId: string, externalId: string) =>
			Promise.resolve(
				rows.find(
					(candidate) =>
						candidate.serviceId === serviceId && candidate.externalId === externalId,
				) ?? null,
			),
		),
		/*
		 * The reconciliation's two queries, kept as set operations over the whole store.
		 *
		 * They are written this way on purpose: what the tests need to pin down is that
		 * the pass costs a fixed number of calls whatever the library holds, and a fake
		 * that answered one row at a time would let a per-item implementation pass.
		 */
		linkKnownParents: jest.fn((serviceId: string) => {
			let linked = 0;

			for (const candidate of rows) {
				if (
					candidate.serviceId !== serviceId ||
					candidate.parentId !== null ||
					candidate.parentExternalId === null ||
					candidate.parentExternalId === undefined
				) {
					continue;
				}

				const parent = rows.find(
					(other) =>
						other.serviceId === serviceId &&
						other.externalId === candidate.parentExternalId,
				);

				if (parent !== undefined) {
					candidate.parentId = parent.id;
					linked += 1;
				}
			}

			return Promise.resolve(linked);
		}),
		findUnresolvedParents: jest.fn((serviceId: string) => {
			const grouped = new Map<string, string>();

			for (const candidate of rows) {
				const wanted = candidate.parentExternalId;

				if (
					candidate.serviceId !== serviceId ||
					candidate.parentId !== null ||
					wanted === null ||
					wanted === undefined ||
					grouped.has(wanted)
				) {
					continue;
				}

				const known = rows.some(
					(other) => other.serviceId === serviceId && other.externalId === wanted,
				);

				if (!known) {
					grouped.set(wanted, candidate.libraryId);
				}
			}

			return Promise.resolve(
				[...grouped].map(([parentExternalId, libraryId]) => ({ parentExternalId, libraryId })),
			);
		}),
		findStale: jest.fn((libraryId: string, seen: string[]) =>
			Promise.resolve(
				rows.filter(
					(candidate) =>
						candidate.libraryId === libraryId && !seen.includes(candidate.externalId),
				),
			),
		),
		findFingerprintable: jest.fn((libraryId: string) =>
			Promise.resolve(
				rows.filter(
					(candidate) =>
						candidate.libraryId === libraryId &&
						candidate.file !== null &&
						candidate.file !== undefined &&
						(candidate.file.quickHash === null || candidate.file.quickHash === ''),
				),
			),
		),
		countByService: jest.fn().mockResolvedValue(12),
		create: jest.fn((value: Partial<MediaItem>) => {
			sequence += 1;

			return { id: `row-${sequence}`, ...value } as MediaItem;
		}),
		save: jest.fn((value: MediaItem | MediaItem[]) =>
			Promise.resolve(Array.isArray(value) ? value.map(put) : put(value)),
		),
		find: jest.fn((options?: { where?: { libraryId?: string } }) =>
			Promise.resolve(
				options?.where?.libraryId === undefined
					? [...rows]
					: rows.filter((candidate) => candidate.libraryId === options.where?.libraryId),
			),
		),
		remove: jest.fn((victims: MediaItem[]) => {
			for (const victim of victims) {
				const index = rows.findIndex((candidate) => candidate.id === victim.id);

				if (index !== -1) {
					rows.splice(index, 1);
				}
			}

			return Promise.resolve(victims);
		}),
	};
};

const summary = (fileCount: number): QualitySummary => ({
	label: fileCount === 0 ? '' : 'x265 · 1080p',
	mixed: false,
	dominant: null,
	variants: [],
	fileCount,
	totalBytes: fileCount * 1_000,
});

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
		update: jest.Mock;
		setScanCursor: jest.Mock;
		setItemCount: jest.Mock;
	};
	matches: { deleteForService: jest.Mock; deleteForItems: jest.Mock };
	items: ItemFakes;
	handler: {
		probe: jest.Mock;
		scanLibrary: jest.Mock;
		refreshLibrary: jest.Mock;
		getItem: jest.Mock;
		requestRescan: jest.Mock;
	};
	fingerprints: { fingerprint: jest.Mock; contentId: jest.Mock };
	quality: { summarise: jest.Mock };
	media: { correlateService: jest.Mock };
	probe: jest.Mock;
	events: { emit: jest.Mock };
	libraryManager: { applyRootMapping: jest.Mock };
	landings: { reconcile: jest.Mock; onRescan: jest.Mock };
}

const build = (seed: MediaItem[] = []): { manager: ServiceManager; fakes: Fakes } => {
	const probeFake = jest.fn().mockResolvedValue(probe());
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
			update: jest.fn().mockResolvedValue(undefined),
			setScanCursor: jest.fn().mockResolvedValue(undefined),
			setItemCount: jest.fn().mockResolvedValue(undefined),
		},
		matches: {
			deleteForService: jest.fn().mockResolvedValue(0),
			deleteForItems: jest.fn().mockResolvedValue(0),
		},
		items: itemStore(seed),
		handler: {
			probe: probeFake,
			scanLibrary: jest.fn(() => yielding([])),
			refreshLibrary: jest.fn().mockResolvedValue({ items: [], cursor: null }),
			// Null is what a service says about an item it does not hold, and the
			// default here: a test about anything else must not have parents appear
			// out of nowhere.
			getItem: jest.fn().mockResolvedValue(null),
			requestRescan: jest.fn().mockResolvedValue('library'),
		},
		fingerprints: {
			fingerprint: jest.fn().mockResolvedValue({ quickHash: 'hash', size: 1_000 }),
			contentId: jest.fn((quickHash: string) => `q1-${quickHash}`),
		},
		quality: { summarise: jest.fn((files: unknown[]) => summary(files.length)) },
		media: { correlateService: jest.fn().mockResolvedValue(0) },
		probe: probeFake,
		events: { emit: jest.fn() },
		libraryManager: { applyRootMapping: jest.fn().mockResolvedValue(undefined) },
		// A scan settles the landings on its way out, so every test in this file walks
		// through it. The fake records the call, which is what one of them asserts on.
		landings: { reconcile: jest.fn().mockResolvedValue(undefined), onRescan: jest.fn() },
	};

	const manager = new ServiceManager(
		fakes.services as unknown as MediaServiceRepository,
		fakes.libraries as unknown as LibraryRepository,
		fakes.items as unknown as MediaItemRepository,
		fakes.fingerprints as unknown as FingerprintService,
		fakes.matches as unknown as MediaMatchRepository,
		{
			find: jest.fn(() => fakes.handler),
			get: jest.fn(() => fakes.handler),
		} as unknown as HandlerRegistry,
		fakes.quality as unknown as QualityService,
		fakes.media as unknown as MediaManager,
		fakes.events as unknown as EventGatewayService,
		fakes.libraryManager as unknown as LibraryManager,
		fakes.landings as unknown as LandingManager,
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
				baseUrl: 'http://jellyfin:8096',
			});

			expect((fakes.services.create.mock.calls[0][0] as MediaService).status).toBe(
				MediaServiceStatus.UNAUTHORIZED,
			);
		});

		it('files a library the service gave no kind for rather than dropping it', async () => {
			// A library with no kind is still a library, and refusing it would make half
			// of somebody's server invisible. The shape says the field is always there;
			// the guard is for the handler somebody writes next, whose mapping table
			// will miss a collection type nobody here has seen — which is why the value
			// is forced past the type rather than the guard removed.
			const { manager, fakes } = build();

			fakes.probe.mockResolvedValue(
				probe({
					libraries: [noKind({ externalId: 'lib-9', name: 'Concerts' })],
				}),
			);

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
			});

			expect(fakes.libraries.create).toHaveBeenCalledWith(
				expect.objectContaining({ externalId: 'lib-9', kind: LibraryKind.OTHER }),
			);
		});

		it('keeps the kind a library already had when the service stops reporting one', async () => {
			const { manager, fakes } = build();

			fakes.probe.mockResolvedValue(
				probe({ libraries: [noKind({ externalId: 'lib-1', name: 'Shows' })] }),
			);
			fakes.libraries.findByExternalId.mockResolvedValue(library({ kind: LibraryKind.SHOWS }));

			await manager.probe('service-1');

			expect((fakes.libraries.save.mock.calls[0][0] as Library).kind).toBe(LibraryKind.SHOWS);
		});

		it('creates the libraries the probe reported', async () => {
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
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

		it('records the status of a server that has gone offline', async () => {
			// The whole point of the column: a service that stopped answering is
			// something the interface has to show without probing it itself.
			const { manager, fakes } = build();

			fakes.probe.mockResolvedValue(
				probe({ reachable: false, authenticated: false, version: null }),
			);

			await manager.probe('service-1');

			expect(fakes.services.setStatus).toHaveBeenCalledWith(
				'service-1',
				MediaServiceStatus.OFFLINE,
				null,
				expect.any(Date),
			);
		});

		it('does not adopt libraries from a probe that failed', async () => {
			// An unreachable server reports no libraries, and treating that as the truth
			// would be a scan result rather than a failure.
			const { manager, fakes } = build();

			fakes.probe.mockResolvedValue(
				probe({ reachable: true, authenticated: false, libraries: [] }),
			);

			await manager.probe('service-1');

			expect(fakes.libraries.save).not.toHaveBeenCalled();
		});

		it('probes a service that signs in with a password rather than a token', async () => {
			// Plex behind a username and password has no token at all, and passing an
			// empty one through would make the handler ask with a credential it does not
			// have instead of the one it does.
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(
				service({ token: null, username: 'someone', password: 'secret' }),
			);

			await manager.probe('service-1');

			expect(fakes.handler.probe).toHaveBeenCalledWith(
				expect.objectContaining({ token: null, username: 'someone', password: 'secret' }),
			);
		});

		it('answers a key for a service whose row cannot be read with its secrets', async () => {
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(null);

			await expect(manager.probe('ghost')).rejects.toThrow(NotFoundException);
		});
	});

	describe('listing libraries', () => {
		it('hands back what the service holds', async () => {
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library({ name: 'Films' })]);

			const listed = await manager.libraries('service-1');

			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ name: 'Films', externalId: 'lib-1' });
		});

		it('answers a key for a service nobody registered', async () => {
			const { manager, fakes } = build();

			fakes.services.findOne.mockResolvedValue(null);

			await expect(manager.libraries('ghost')).rejects.toThrow(ErrorKey.SERVICE_NOT_FOUND);
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

		it('refuses to move a service onto an address the same peer already uses', async () => {
			const { manager, fakes } = build();

			fakes.services.findByBaseUrl.mockResolvedValue(service({ id: 'service-2' }));

			await expect(
				manager.update('service-1', { baseUrl: 'http://plex:32400' }),
			).rejects.toThrow(ConflictException);
		});

		it('allows an address that resolves back to the service being edited', async () => {
			// Re-saving the same URL with a trailing slash, or after a normalisation
			// change, finds the row itself. Refusing that would make a service editable
			// exactly once.
			const { manager, fakes } = build();

			fakes.services.findByBaseUrl.mockResolvedValue(service({ id: 'service-1' }));

			await expect(
				manager.update('service-1', { baseUrl: 'http://jellyfin:8096/' }),
			).resolves.toMatchObject({ id: 'service-1' });
		});
	});

	describe('a registration that stands for a peer', () => {
		it('refuses to be edited, rather than trusting a screen not to offer it', async () => {
			// Nothing this shape carries applies to a peer: their files are on their
			// machine, the link authenticates by fingerprint, and the address is a
			// `peer://` identifier. A root mapping stored for one would look configured
			// and never resolve, which is worse than being told no.
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ peerId: 'peer-1' }));

			await expect(
				manager.update('service-1', {
					rootMappings: [{ remoteRoot: '/media', localRoot: '/mnt/nas' }],
				}),
			).rejects.toThrow(ErrorKey.SERVICE_PEER_NOT_EDITABLE);
			expect(fakes.services.save).not.toHaveBeenCalled();
		});

		it('refuses a rename just the same, because the name follows the peer', async () => {
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ peerId: 'peer-1' }));

			await expect(manager.update('service-1', { name: 'Renamed' })).rejects.toThrow(
				ErrorKey.SERVICE_PEER_NOT_EDITABLE,
			);
		});
	});

	describe('the sharing switch', () => {
		it('registers a service shared when the request says nothing', async () => {
			// The same reasoning as the gateway's default visibility being a real level
			// rather than silence: a service registered and quietly invisible shows a
			// friend an empty shelf, and they read that as a link that failed.
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
			});

			expect((fakes.services.create.mock.calls[0][0] as MediaService).shared).toBe(true);
		});

		it('registers it private when the request says so', async () => {
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				shared: false,
				baseUrl: 'http://jellyfin:8096',
			});

			expect((fakes.services.create.mock.calls[0][0] as MediaService).shared).toBe(false);
		});

		it('never re-defaults it on an edit that does not mention it', async () => {
			// An edit made to correct a port must not start sharing something somebody
			// deliberately turned off — the one way a default can do real harm.
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ shared: false }));

			await manager.update('service-1', { name: 'Renamed' });

			expect((fakes.services.save.mock.calls[0][0] as MediaService).shared).toBe(false);
		});

		it('turns it on when somebody flips it', async () => {
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ shared: false }));

			await manager.update('service-1', { shared: true });

			expect((fakes.services.save.mock.calls[0][0] as MediaService).shared).toBe(true);
		});
	});

	describe('the root mappings', () => {
		const films = { remoteRoot: '/data/movies', localRoot: '/mnt/nas1/movies' };
		const shows = { remoteRoot: '/srv/shows', localRoot: '/mnt/nas2/shows' };

		it('stores every pair a service is registered with, in one spelling', async () => {
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
				rootMappings: [
					{ remoteRoot: ' /data/movies/ ', localRoot: '/mnt//nas1/movies' },
					shows,
				],
			});

			const saved = fakes.services.save.mock.calls[0][0] as MediaService;

			// Trailing and doubled slashes go: they say nothing about the directory, and
			// `/data/` beside `/data` must read as the one prefix it is.
			expect(saved.rootMappings).toEqual([films, shows]);
		});

		it('stores only the two sides of each pair, whatever else an entry carried', async () => {
			// The list lands in a JSON column; anything else on an entry would be kept
			// and returned forever.
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
				rootMappings: [{ ...films, role: 'admin' } as typeof films],
			});

			expect((fakes.services.save.mock.calls[0][0] as MediaService).rootMappings).toEqual([films]);
		});

		it('registers a service with no mapping as one with an empty list', async () => {
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
			});

			expect((fakes.services.save.mock.calls[0][0] as MediaService).rootMappings).toEqual([]);
		});

		it('applies the mappings to the libraries a probe just reported', async () => {
			const { manager, fakes } = build();

			await manager.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin:8096',
				rootMappings: [films, shows],
			});

			expect(fakes.libraryManager.applyRootMapping).toHaveBeenCalledWith(
				expect.objectContaining({ rootMappings: [films, shows] }),
			);
		});

		it('re-derives every library when the list changes', async () => {
			// A corrected mapping is worthless until something re-reads it, and the next
			// thing that would is a scan nobody may run for a day.
			const { manager, fakes } = build();

			await manager.update('service-1', { rootMappings: [films, shows] });

			expect(fakes.libraryManager.applyRootMapping).toHaveBeenCalledWith(
				expect.objectContaining({ rootMappings: [films, shows] }),
			);
		});

		it('re-derives when one pair of several is removed, so its libraries lose the path', async () => {
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ rootMappings: [films, shows] }));

			await manager.update('service-1', { rootMappings: [films] });

			expect(fakes.libraryManager.applyRootMapping).toHaveBeenCalledWith(
				expect.objectContaining({ rootMappings: [films] }),
			);
		});

		it('withdraws every mapping on an empty list', async () => {
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ rootMappings: [films] }));

			await manager.update('service-1', { rootMappings: [] });

			expect((fakes.services.save.mock.calls[0][0] as MediaService).rootMappings).toEqual([]);
			expect(fakes.libraryManager.applyRootMapping).toHaveBeenCalled();
		});

		it('leaves the libraries alone when the list sent is the one stored', async () => {
			// Sent back unchanged by a form saved for another field; re-deriving would
			// re-probe every library directory for nothing.
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ rootMappings: [films] }));

			await manager.update('service-1', { rootMappings: [{ remoteRoot: '/data/movies/', localRoot: films.localRoot }] });

			expect(fakes.libraryManager.applyRootMapping).not.toHaveBeenCalled();
		});

		it('leaves the list and the libraries alone when the edit was about something else', async () => {
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockResolvedValue(service({ rootMappings: [films] }));

			await manager.update('service-1', { name: 'Renamed' });

			expect((fakes.services.save.mock.calls[0][0] as MediaService).rootMappings).toEqual([films]);
			expect(fakes.libraryManager.applyRootMapping).not.toHaveBeenCalled();
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

		/**
		 * What the service was feeding is found through its items, which cascade away
		 * with the row — so whoever holds work against it hears first, and is waited for.
		 */
		it('tells whoever holds work against the service before its rows go', async () => {
			const { manager, fakes } = build();
			const order: string[] = [];

			manager.onRemoving(async (serviceId) => {
				await Promise.resolve();
				order.push(`released ${serviceId}`);
			});
			fakes.services.delete.mockImplementation(() => {
				order.push('deleted');
				return Promise.resolve();
			});

			await manager.remove('service-1');

			expect(order).toEqual(['released service-1', 'deleted']);
		});

		it('still removes the service when a listener fails', async () => {
			const { manager, fakes } = build();

			manager.onRemoving(() => Promise.reject(new Error('queue unreachable')));

			await manager.remove('service-1');

			expect(fakes.services.delete).toHaveBeenCalledWith({ id: 'service-1' });
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

		it('lets the next scan run once the first has finished', async () => {
			// The entry is removed in a `finally`, and forgetting that would turn the
			// guard above into a service that can never be scanned twice — which only
			// shows up the second time somebody presses the button.
			const { manager, fakes } = build();

			await manager.scan('service-1');
			await settle(manager);
			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.services.findWithSecrets).toHaveBeenCalledTimes(2);
		});

		it('swallows a failing pass rather than rejecting the request that started it', async () => {
			// The walk is detached, so nothing is left to catch what it throws: an
			// unhandled rejection here takes the process down on a modern Node, for a
			// media server that simply went away mid-scan.
			const { manager, fakes } = build();

			fakes.services.findWithSecrets.mockRejectedValue(new Error('gone mid-scan'));

			await expect(manager.scan('service-1')).resolves.toBeUndefined();
			await settle(manager);

			// And the service is not left permanently locked out of being scanned.
			fakes.services.findWithSecrets.mockResolvedValue(service());
			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.libraries.findByService).toHaveBeenCalled();
		});

		it('settles the landings before correlation re-derives every state', async () => {
			/*
			 * The order is the feature. Correlation recomputes each item's state and
			 * reads the open landings while doing it, so a landing this pass resolved
			 * has to be gone by then — otherwise a scan that found the file would still
			 * report it as waiting, for a whole refresh interval.
			 */
			const { manager, fakes } = build();
			const order: string[] = [];

			fakes.landings.reconcile.mockImplementation(() => {
				order.push('reconcile');

				return Promise.resolve();
			});
			fakes.media.correlateService.mockImplementation(() => {
				order.push('correlate');

				return Promise.resolve(0);
			});

			await manager.scan('service-1');
			await settle(manager);

			expect(order).toEqual(['reconcile', 'correlate']);
		});

		it('re-reads a service when a file has just landed in one of its libraries', async () => {
			// Nothing in the application re-scanned after a transfer before this: `scan`
			// and `refresh` were reached from the buttons and from adopting a peer, and
			// from nowhere else, so a finished download waited out the periodic refresh.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			manager.onApplicationBootstrap();

			const [listener] = fakes.landings.onRescan.mock.calls[0] as [(id: string) => void];

			listener('service-1');
			await settle(manager);

			expect(fakes.services.findWithSecrets).toHaveBeenCalledWith('service-1');
			// A refresh and not a full scan: a season arriving would otherwise be one
			// full walk of a large library per episode.
			expect(fakes.handler.refreshLibrary).toHaveBeenCalled();
			expect(fakes.handler.scanLibrary).not.toHaveBeenCalled();
		});

		it('refuses to scan a service nobody registered', async () => {
			const { manager, fakes } = build();

			fakes.services.findOne.mockResolvedValue(null);

			await expect(manager.scan('ghost')).rejects.toThrow(ErrorKey.SERVICE_NOT_FOUND);
			await expect(manager.refresh('ghost')).rejects.toThrow(ErrorKey.SERVICE_NOT_FOUND);
		});

		it('writes what a full scan reported into the index', async () => {
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({ externalId: 'a', title: 'Arrival' }),
					reported({ externalId: 'b', title: 'Blade Runner 2049' }),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows.map((item) => item.title)).toEqual([
				'Arrival',
				'Blade Runner 2049',
			]);
			expect(fakes.items.rows[0].libraryId).toBe('library-1');
		});

		it('resolves a child onto the parent the same walk just wrote', async () => {
			// The cheap path: the parent is already in the index when the child is
			// written, so the link is made there and then and the reconciliation finds
			// nothing left to do.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({ externalId: 'series', kind: MediaKind.SERIES, title: 'The Expanse' }),
					reported({
						externalId: 'season',
						parentExternalId: 'series',
						kind: MediaKind.SEASON,
						title: 'Season 1',
					}),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			const [series, season] = fakes.items.rows;

			expect(season.parentId).toBe(series.id);
		});

		it('keeps the parent identifier a service reported, linked or not', async () => {
			// The column is the whole repair: without it a child written before its
			// parent carries nothing that names what it should hang from, and no later
			// pass can tell it apart from a film.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({
						externalId: 'season',
						parentExternalId: 'series',
						kind: MediaKind.SEASON,
						title: 'Season 1',
					}),
					reported({ externalId: 'series', kind: MediaKind.SERIES, title: 'The Expanse' }),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			const season = fakes.items.rows.find((item) => item.externalId === 'season');

			expect(season?.parentExternalId).toBe('series');
		});

		it('links a child that was written before its parent', async () => {
			// The bug this pass exists for. Jellyfin pages by `SortName` because index
			// paging is only stable under a stable sort, and `Season 1` sorts before
			// `The Expanse` — so the season was written while its series did not exist
			// yet and appeared at the root of the library screen beside the show.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({
						externalId: 'season',
						parentExternalId: 'series',
						kind: MediaKind.SEASON,
						title: 'Season 1',
					}),
					reported({ externalId: 'series', kind: MediaKind.SERIES, title: 'The Expanse' }),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			const season = fakes.items.rows.find((item) => item.externalId === 'season');
			const series = fakes.items.rows.find((item) => item.externalId === 'series');

			expect(season?.parentId).toBe(series?.id);
			// And the series is still the only thing at the root, which is what the
			// library screen renders.
			expect(fakes.items.rows.filter((item) => item.parentId === null)).toHaveLength(1);
		});

		it('reconciles the whole service in a fixed number of queries', async () => {
			// One query per service, never one per item: a library of forty thousand
			// episodes would otherwise turn every scan into forty thousand round trips
			// for a repair that concerns a handful of rows.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					...Array.from({ length: 50 }, (_ignored, index) =>
						reported({
							externalId: `episode-${index}`,
							parentExternalId: 'series',
							kind: MediaKind.EPISODE,
							title: `Episode ${index}`,
						}),
					),
					reported({ externalId: 'series', kind: MediaKind.SERIES, title: 'The Expanse' }),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows.filter((item) => item.parentId === null)).toHaveLength(1);
			expect(fakes.items.linkKnownParents).toHaveBeenCalledTimes(1);
			expect(fakes.items.findUnresolvedParents).toHaveBeenCalledTimes(1);
		});

		it('leaves a row that is already linked alone', async () => {
			// The statement filters on a null parent, and it matters twice over: a
			// correction that reassigned a season by hand must not be undone by a pass
			// that re-derives the link from what the service said.
			const { manager, fakes } = build([
				row({ id: 'row-child', externalId: 'child', parentId: 'row-kept', parentExternalId: 'series' }),
				row({ id: 'row-series', externalId: 'series', kind: MediaKind.SERIES }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.rows.find((item) => item.id === 'row-child')?.parentId).toBe('row-kept');
		});

		it('keeps an episode rather than dropping it when nobody can produce its series', async () => {
			// A refresh reporting one new episode of a series we have never seen is the
			// ordinary case. Asked for it, the service answers that it holds no such
			// item — so the row stays where it is, unlinked and present. Failing the
			// scan instead would lose the episode entirely.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.refreshLibrary.mockResolvedValue({
				items: [reported({ externalId: 'orphan', parentExternalId: 'never-seen' })],
				cursor: '42',
			});

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.rows).toHaveLength(1);
			expect(fakes.items.rows[0].parentId).toBeNull();
			expect(fakes.items.rows[0].parentExternalId).toBe('never-seen');
		});

		it('carries on when asking for a missing parent fails', async () => {
			// A media server that has gone slow, or that deleted the series after
			// listing its episodes, must not take the scan down with it.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.getItem.mockRejectedValue(new Error('gateway timeout'));
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({
						externalId: 'season',
						parentExternalId: 'series',
						kind: MediaKind.SEASON,
						title: 'Season 1',
					}),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows).toHaveLength(1);
			expect(fakes.items.rows[0].parentId).toBeNull();
			// The rest of the pass still ran, which is what tells us the failure was
			// swallowed where it happens rather than aborting the walk.
			expect(fakes.media.correlateService).toHaveBeenCalledWith('service-1');
		});

		it('fetches a parent the service never enumerated, once for all its children', async () => {
			// The other half of the fix. A series absent from the enumeration cannot be
			// linked to anything, and inventing one from what the children say would
			// leave a made-up row to recognise and merge the day the real one appears —
			// so the service is asked for it instead, and answers with the real title.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.getItem.mockImplementation((_connection: unknown, externalId: string) =>
				Promise.resolve(
					externalId === 'series'
						? reported({
							externalId: 'series',
							kind: MediaKind.SERIES,
							title: 'The Expanse',
							normalizedTitle: 'expanse',
						})
						: null,
				),
			);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({
						externalId: 'season-1',
						parentExternalId: 'series',
						kind: MediaKind.SEASON,
						title: 'Season 1',
					}),
					reported({
						externalId: 'season-3',
						parentExternalId: 'series',
						kind: MediaKind.SEASON,
						title: 'Season 3',
					}),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			const series = fakes.items.rows.find((item) => item.externalId === 'series');

			expect(series?.title).toBe('The Expanse');
			expect(series?.libraryId).toBe('library-1');
			expect(
				fakes.items.rows
					.filter((item) => item.kind === MediaKind.SEASON)
					.map((item) => item.parentId),
			).toEqual([series?.id, series?.id]);
			// Once for the parent, not once per child holding it.
			expect(fakes.handler.getItem).toHaveBeenCalledTimes(1);
		});

		it('climbs to a grandparent the service did not enumerate either', async () => {
			// Fetching the season reveals that its series is missing too, which is only
			// visible once the season has a row. One hop would leave the season at the
			// root and the episode under it, which looks fixed and is not.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.getItem.mockImplementation((_connection: unknown, externalId: string) =>
				Promise.resolve(
					externalId === 'season'
						? reported({
							externalId: 'season',
							parentExternalId: 'series',
							kind: MediaKind.SEASON,
							title: 'Season 1',
						})
						: reported({
							externalId: 'series',
							kind: MediaKind.SERIES,
							title: 'The Expanse',
						}),
				),
			);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({
						externalId: 'episode',
						parentExternalId: 'season',
						kind: MediaKind.EPISODE,
						title: 'Dulcinea',
					}),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			const roots = fakes.items.rows.filter((item) => item.parentId === null);

			expect(roots.map((item) => item.externalId)).toEqual(['series']);
		});

		it('does not orphan an item when a later pass reports it without its parent', async () => {
			const { manager, fakes } = build([
				row({ id: 'row-child', externalId: 'child', parentId: 'row-parent' }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.refreshLibrary.mockResolvedValue({
				items: [reported({ externalId: 'child', parentExternalId: null })],
				cursor: null,
			});

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.rows[0].parentId).toBe('row-parent');
		});

		it('re-applies a hand correction that the rescan would otherwise undo', async () => {
			// This is what makes a correction stick. Everything above the override has
			// just written what the service said — which is exactly what a rescan is for,
			// and exactly what erases a reassigned season number.
			const { manager, fakes } = build([
				row({
					id: 'row-fixed',
					externalId: 'episode',
					kind: MediaKind.EPISODE,
					title: 'Dulcinea',
					seasonNumber: 2,
					episodeNumber: 14,
					overrides: { seasonNumber: 2, episodeNumber: 14 },
					reported: {
						libraryId: 'library-1',
						title: 'Dulcinea',
						seriesTitle: null,
						year: 2015,
						seasonNumber: 1,
						episodeNumber: 1,
						overview: null,
						externalIds: {},
					},
				}),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({
						externalId: 'episode',
						kind: MediaKind.EPISODE,
						title: 'Dulcinea',
						seasonNumber: 1,
						episodeNumber: 1,
					}),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			const saved = fakes.items.rows[0];

			expect(saved.seasonNumber).toBe(2);
			expect(saved.episodeNumber).toBe(14);
			// And the service's own answer is what the correction is measured against,
			// taken fresh from this scan rather than from the snapshot of the last one.
			expect(saved.reported?.seasonNumber).toBe(1);
		});

		it('keeps the date a service reported, and tolerates one it did not', async () => {
			// `addedAt` is what "recently added" sorts on, and it arrives as a string
			// from one service and not at all from another.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({ externalId: 'dated', addedAt: '2026-03-04T05:06:07.000Z' }),
					reported({ externalId: 'undated', addedAt: null }),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows[0].addedAt).toEqual(new Date('2026-03-04T05:06:07.000Z'));
			expect(fakes.items.rows[1].addedAt).toBeNull();
		});

		it('leaves an uncorrected row exactly as the service reports it', async () => {
			const { manager, fakes } = build([
				row({ id: 'row-plain', externalId: 'movie', title: 'Old title', year: 1999 }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([reported({ externalId: 'movie', title: 'Arrival', year: 2016 })]),
			);

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows[0]).toMatchObject({ title: 'Arrival', year: 2016 });
			expect(fakes.items.rows[0].reported).toBeNull();
		});

		it('drops what a full scan no longer saw, and the matches naming it', async () => {
			const { manager, fakes } = build([
				row({ id: 'row-kept', externalId: 'kept' }),
				row({ id: 'row-gone', externalId: 'gone' }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(yielding([reported({ externalId: 'kept' })]));

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows.map((item) => item.externalId)).toEqual(['kept']);
			// A match names services on both sides and only one of them cascades, so the
			// rows a deletion cannot reach have to be removed by hand.
			expect(fakes.matches.deleteForItems).toHaveBeenCalledWith(['row-gone']);
		});

		it('keeps a parent the walk never reported while its children are still there', async () => {
			// A service that lists seasons but not series has its series rows fetched by
			// identifier, so they are in no enumeration and the plain rule would delete
			// them at the very next scan — leaving the seasons pointing at nothing,
			// which is neither a root nor reachable under anything.
			const { manager, fakes } = build([
				row({ id: 'row-series', externalId: 'series', kind: MediaKind.SERIES }),
				row({
					id: 'row-season',
					externalId: 'season',
					kind: MediaKind.SEASON,
					parentId: 'row-series',
					parentExternalId: 'series',
				}),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding([
					reported({
						externalId: 'season',
						parentExternalId: 'series',
						kind: MediaKind.SEASON,
					}),
				]),
			);

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows.map((item) => item.externalId).sort()).toEqual([
				'season',
				'series',
			]);
			expect(fakes.matches.deleteForItems).not.toHaveBeenCalled();
		});

		it('drops a show whose children stopped being reported along with it', async () => {
			// The other side of the same rule: a series kept by a child that is itself
			// stale would never be deleted at all.
			const { manager, fakes } = build([
				row({ id: 'row-series', externalId: 'series', kind: MediaKind.SERIES }),
				row({
					id: 'row-season',
					externalId: 'season',
					kind: MediaKind.SEASON,
					parentId: 'row-series',
				}),
				row({ id: 'row-film', externalId: 'film' }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(yielding([reported({ externalId: 'film' })]));

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.items.rows.map((item) => item.externalId)).toEqual(['film']);
		});

		it('never lets a refresh delete the rows it did not ask about', async () => {
			// A refresh sees only what changed since the cursor. Comparing that against
			// the whole library would empty it on the first incremental pass.
			const { manager, fakes } = build([
				row({ id: 'row-a', externalId: 'a' }),
				row({ id: 'row-b', externalId: 'b' }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.refreshLibrary.mockResolvedValue({
				items: [reported({ externalId: 'a' })],
				cursor: '7',
			});

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.rows).toHaveLength(2);
			expect(fakes.items.remove).not.toHaveBeenCalled();
		});

		it('leaves the match rows alone when a full scan saw everything', async () => {
			const { manager, fakes } = build([row({ id: 'row-kept', externalId: 'kept' })]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(yielding([reported({ externalId: 'kept' })]));

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.matches.deleteForItems).not.toHaveBeenCalled();
			expect(fakes.items.remove).not.toHaveBeenCalled();
		});

		it('forgets the cursor after a full scan and advances it after a refresh', async () => {
			// The two directions are the whole difference between the passes: a full scan
			// that kept the cursor would go back to reading a fraction of the library,
			// and a refresh that cleared it would re-read all of it every few minutes.
			const full = build();
			const incremental = build();

			full.fakes.libraries.findByService.mockResolvedValue([library()]);
			incremental.fakes.libraries.findByService.mockResolvedValue([
				library({ scanCursor: 'from-here' }),
			]);
			incremental.fakes.handler.refreshLibrary.mockResolvedValue({
				items: [],
				cursor: 'to-here',
			});

			await full.manager.scan('service-1');
			await settle(full.manager);
			await incremental.manager.refresh('service-1');
			await settle(incremental.manager);

			expect(full.fakes.libraries.setScanCursor).toHaveBeenCalledWith('library-1', null);
			expect(incremental.fakes.handler.refreshLibrary).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ externalId: 'lib-1' }),
				'from-here',
			);
			expect(incremental.fakes.libraries.setScanCursor).toHaveBeenCalledWith(
				'library-1',
				'to-here',
			);
		});

		it('reports progress by the page rather than by the row', async () => {
			// A frame per episode on a library of forty thousand is thousands of frames
			// for a bar that moves by a pixel, and the stream is the same one the rest of
			// the interface listens on.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.handler.scanLibrary.mockReturnValue(
				yielding(
					Array.from({ length: 250 }, (_, index) =>
						reported({ externalId: `item-${index}` }),
					),
				),
			);

			await manager.scan('service-1');
			await settle(manager);

			const frames = fakes.events.emit.mock.calls
				.filter(([name]) => name === EventName.SCAN_PROGRESS)
				.map(([, payload]) => payload as { itemsSeen: number; done: boolean });

			expect(frames.filter((frame) => !frame.done).map((frame) => frame.itemsSeen)).toEqual([
				100, 200,
			]);
			expect(frames.at(-1)).toMatchObject({ done: true, libraryId: null });
		});

		it('correlates once the whole service has been walked, not once per library', async () => {
			// Correlation is quadratic in what it compares; running it per library would
			// do the same work as many times as the service has libraries, and the answer
			// would still depend on which library came last.
			const { manager, fakes } = build();

			fakes.libraries.findByService.mockResolvedValue([
				library({ id: 'library-1', externalId: 'lib-1' }),
				library({ id: 'library-2', externalId: 'lib-2' }),
			]);

			await manager.scan('service-1');
			await settle(manager);

			expect(fakes.media.correlateService).toHaveBeenCalledTimes(1);
			expect(fakes.media.correlateService).toHaveBeenCalledWith('service-1');
		});
	});

	describe('recomputing a library', () => {
	/*
	 * Driven through a refresh rather than a full scan, because the rows are seeded
	 * rather than reported: a full scan would see none of them and sweep the lot as
	 * stale before the recount ever ran. The pass itself is the same one either way.
	 */
		it('counts children and rolls quality up the tree', async () => {
			const { manager, fakes } = build([
				row({ id: 'series', externalId: 'series', kind: MediaKind.SERIES }),
				row({
					id: 'episode-1',
					externalId: 'episode-1',
					parentId: 'series',
					kind: MediaKind.EPISODE,
					file: fileInfo(),
				}),
				row({
					id: 'episode-2',
					externalId: 'episode-2',
					parentId: 'series',
					kind: MediaKind.EPISODE,
					file: fileInfo(),
				}),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);

			await manager.refresh('service-1');
			await settle(manager);

			const series = fakes.items.rows.find((item) => item.id === 'series') as MediaItem;

			expect(series.childCount).toBe(2);
			// The series holds no file of its own; its summary is what hangs below it.
			expect(series.quality?.fileCount).toBe(2);
			expect(fakes.libraries.setItemCount).toHaveBeenCalledWith('library-1', 3);
		});

		it('leaves a node with nothing under it without a quality summary', async () => {
			// A summary over zero files is not "unknown quality", it is an empty object
			// the interface would render as a chip saying nothing.
			const { manager, fakes } = build([
				row({ id: 'empty-series', externalId: 'empty', kind: MediaKind.SERIES }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.rows[0].quality).toBeNull();
		});

		it('writes nothing when nothing moved', async () => {
			// The pass runs after every scan of every library. Saving rows whose counts
			// and summaries are unchanged would be a write per item per refresh, every
			// few minutes, forever.
			const { manager, fakes } = build([
				row({ id: 'settled', externalId: 'settled', file: fileInfo(), quality: summary(1) }),
			]);

			fakes.libraries.findByService.mockResolvedValue([library()]);
			fakes.items.save.mockClear();

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.save).not.toHaveBeenCalled();
		});
	});

	describe('fingerprinting', () => {
	/* Through a refresh, for the reason given above the recount tests. */
		let directory: string;

		beforeAll(async () => {
			directory = await mkdtemp(join(tmpdir(), 'mcs-service-manager-'));

			await writeFile(join(directory, 'Arrival.mkv'), 'video');
			await writeFile(join(directory, 'Arrival.nfo'), 'description');
			await writeFile(join(directory, 'poster.jpg'), 'image');
		});

		afterAll(async () => {
			await rm(directory, { recursive: true, force: true });
		});

		it('reads nothing for a library nobody told us where to find', async () => {
			// Without a local path there is no file to open: every reported path belongs
			// to the service's own filesystem, not to ours.
			const { manager, fakes } = build([row({ id: 'row-1', file: fileInfo() })]);

			fakes.libraries.findByService.mockResolvedValue([library({ localPath: null })]);

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.findFingerprintable).not.toHaveBeenCalled();
			expect(fakes.fingerprints.fingerprint).not.toHaveBeenCalled();
		});

		it('identifies a file the gateway can read, and what sits beside it', async () => {
			const { manager, fakes } = build([
				row({ id: 'row-1', file: fileInfo({ path: '/media/shows/Arrival.mkv' }) }),
			]);

			fakes.libraries.findByService.mockResolvedValue([
				library({ paths: ['/media/shows'], localPath: directory }),
			]);

			await manager.refresh('service-1');
			await settle(manager);

			// The path is translated, never used as reported: the service says
			// `/media/shows` and the gateway sees a mount somewhere else entirely.
			expect(fakes.fingerprints.fingerprint).toHaveBeenCalledWith(
				join(directory, 'Arrival.mkv'),
			);
			expect(fakes.items.rows[0].file).toMatchObject({
				quickHash: 'hash',
				contentId: 'q1-hash',
			});
			expect(fakes.items.rows[0].companions).toMatchObject({ nfo: true, poster: true });
		});

		it('says nothing rather than "nothing there" when the directory cannot be read', async () => {
			// Null and an empty answer are different, and the interface acts on the
			// difference: one asks for a scan, the other offers to fetch the companions.
			const { manager, fakes } = build([
				row({ id: 'row-1', file: fileInfo({ path: '/media/shows/Missing.mkv' }) }),
			]);

			fakes.libraries.findByService.mockResolvedValue([
				library({ paths: ['/media/shows'], localPath: join(directory, 'no-such-mount') }),
			]);

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.rows[0].companions).toBeNull();
		});

		it('skips a file that sits outside every root the library declares', async () => {
			// A prefix guessed here is a read outside the library, which is the one thing
			// a path mapping must never do.
			const { manager, fakes } = build([
				row({ id: 'row-1', file: fileInfo({ path: '/elsewhere/Arrival.mkv' }) }),
			]);

			fakes.libraries.findByService.mockResolvedValue([
				library({ paths: ['/media/shows'], localPath: directory }),
			]);

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.fingerprints.fingerprint).not.toHaveBeenCalled();
			expect(fakes.items.rows[0].file?.quickHash).toBeNull();
		});

		it('carries on past a file it cannot read', async () => {
			// A library mounted read-only, half-mounted, or on a NAS that went to sleep
			// is the normal case, and none of it should fail a scan.
			const { manager, fakes } = build([
				row({ id: 'row-1', file: fileInfo({ path: '/media/shows/Unreadable.mkv' }) }),
				row({
					id: 'row-2',
					externalId: 'external-2',
					file: fileInfo({ path: '/media/shows/Arrival.mkv' }),
				}),
			]);

			fakes.libraries.findByService.mockResolvedValue([
				library({ paths: ['/media/shows'], localPath: directory }),
			]);
			fakes.fingerprints.fingerprint.mockImplementation((path: string) =>
				path.endsWith('Unreadable.mkv')
					? Promise.reject(new Error('EACCES'))
					: Promise.resolve({ quickHash: 'hash', size: 1_000 }),
			);

			await manager.refresh('service-1');
			await settle(manager);

			expect(fakes.items.rows[0].file?.quickHash).toBeNull();
			expect(fakes.items.rows[1].file?.quickHash).toBe('hash');
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
