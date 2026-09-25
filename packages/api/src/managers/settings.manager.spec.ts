import { DownloadClientType, ErrorKey, IndexerType, RequestSourceType } from '@mcs/shared';
import {
	DEFAULT_SETTINGS,
	type BandwidthService,
	type SchedulerService,
	type SettingsService,
	type TransferEngineService,
} from '@/services';
import type { LibraryManager } from './library.manager';
import { SettingsManager } from './settings.manager';

interface Fakes {
	settings: { get: jest.Mock; view: jest.Mock; update: jest.Mock };
	scheduler: { reload: jest.Mock };
	engine: { applyRateLimits: jest.Mock };
	bandwidth: { apply: jest.Mock };
	libraries: { probe: jest.Mock; mergeCategoryInto: jest.Mock; categories: jest.Mock };
}

const build = (): { manager: SettingsManager; fakes: Fakes } => {
	const fakes: Fakes = {
		settings: {
			get: jest.fn().mockResolvedValue(DEFAULT_SETTINGS),
			view: jest.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, pinned: [] }),
			update: jest.fn((patch: Record<string, unknown>) =>
				Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }),
			),
		},
		scheduler: { reload: jest.fn().mockResolvedValue(undefined) },
		engine: { applyRateLimits: jest.fn() },
		bandwidth: { apply: jest.fn() },
		libraries: {
			mergeCategoryInto: jest.fn().mockResolvedValue('Shows'),
			// Enough for the stale-entry warning to have something to compare against:
			// the tests that care about which keys are live declare their own.
			categories: jest.fn().mockResolvedValue([{ key: 'shows' }, { key: 'animes' }]),
			probe: jest.fn().mockResolvedValue({
				exists: true,
				readable: true,
				writable: true,
				freeBytes: 1_000,
				error: null,
			}),
		},
	};

	return {
		manager: new SettingsManager(
			fakes.settings as unknown as SettingsService,
			fakes.scheduler as unknown as SchedulerService,
			fakes.engine as unknown as TransferEngineService,
			fakes.bandwidth as unknown as BandwidthService,
			fakes.libraries as unknown as LibraryManager,
		),
		fakes,
	};
};

describe('SettingsManager', () => {
	it('writes only what was sent, so two screens cannot overwrite each other', async () => {
		const { manager, fakes } = build();

		await manager.write({ maxParallelTransfers: 8 });

		expect(fakes.settings.update).toHaveBeenCalledWith({ maxParallelTransfers: 8 });
	});

	it('reloads the schedules when the refresh interval moves', async () => {
		const { manager, fakes } = build();

		await manager.write({ refreshIntervalMinutes: 30 });

		expect(fakes.scheduler.reload).toHaveBeenCalled();
	});

	it('reloads them when the full-scan expression moves, emptied included', async () => {
		const { manager, fakes } = build();

		await manager.write({ fullScanCron: null });

		expect(fakes.scheduler.reload).toHaveBeenCalled();
	});

	it('leaves the clock alone for a setting that has nothing to do with it', async () => {
		const { manager, fakes } = build();

		await manager.write({ downloadRateLimit: 1_000_000 });

		expect(fakes.scheduler.reload).not.toHaveBeenCalled();
	});

	it('pushes a new bandwidth cap into the transfers already running', async () => {
		const { manager, fakes } = build();

		await manager.write({ downloadRateLimit: 1_000_000 });

		// The whole settings object, not the patch: the engine holds one number, and a
		// caller who only sent one of the two caps must not blank the other.
		expect(fakes.engine.applyRateLimits).toHaveBeenCalledWith(
			expect.objectContaining({ downloadRateLimit: 1_000_000 }),
		);
	});

	it('pushes it for an upload cap too, since both live in the same engine', async () => {
		const { manager, fakes } = build();

		await manager.write({ uploadRateLimit: 500_000 });

		expect(fakes.engine.applyRateLimits).toHaveBeenCalled();
	});

	it('leaves the engine alone for a setting that has nothing to do with bandwidth', async () => {
		const { manager, fakes } = build();

		await manager.write({ maxParallelTransfers: 8 });

		expect(fakes.engine.applyRateLimits).not.toHaveBeenCalled();
	});

	it('probes the fallback target before believing it', async () => {
		const { manager, fakes } = build();

		await manager.write({ defaultTargetPath: '/media/incoming/' });

		// The normalised path, not what was typed: the probe and the row have to be
		// asking about the same directory.
		expect(fakes.libraries.probe).toHaveBeenCalledWith('/media/incoming');
	});

	it('refuses a fallback target it cannot write into, and writes nothing', async () => {
		const { manager, fakes } = build();

		fakes.libraries.probe.mockResolvedValue({
			exists: true,
			readable: true,
			writable: false,
			freeBytes: null,
			error: ErrorKey.LIBRARY_PATH_NOT_WRITABLE,
		});

		await expect(manager.write({ defaultTargetPath: '/media/incoming' })).rejects.toMatchObject({
			response: {
				key: ErrorKey.SETTINGS_TARGET_PATH_NOT_WRITABLE,
				field: 'defaultTargetPath',
			},
		});
		expect(fakes.settings.update).not.toHaveBeenCalled();
	});

	it('probes nothing when the fallback target is being cleared', async () => {
		const { manager, fakes } = build();

		await manager.write({ defaultTargetPath: '' });

		expect(fakes.libraries.probe).not.toHaveBeenCalled();
		expect(fakes.settings.update).toHaveBeenCalledWith({ defaultTargetPath: '' });
	});

	it('leaves the filesystem alone for a setting that is not a path', async () => {
		const { manager, fakes } = build();

		await manager.write({ publicUrl: 'https://mcs.example.org' });

		expect(fakes.libraries.probe).not.toHaveBeenCalled();
	});

	describe('a destination that also names the category', () => {
		/*
		 * The report this exists for: `Séries` was pointed at the `Shows` library, the
		 * screen kept showing two categories, and the fourteen episodes stayed in the
		 * first. Placement and grouping are two mechanisms and the table only drove one.
		 */
		const withTargets = (current: Record<string, string> = {}) => {
			const made = build();

			made.fakes.settings.get.mockResolvedValue({
				...DEFAULT_SETTINGS,
				categoryTargets: current,
			});

			return made;
		};

		it('makes the mapped category read as its destination', async () => {
			const { manager, fakes } = withTargets();

			await manager.write({ categoryTargets: { series: 'library-shows' } });

			expect(fakes.libraries.mergeCategoryInto).toHaveBeenCalledWith('series', 'library-shows');
		});

		it('acts on every entry the save moved, not only the first', async () => {
			const { manager, fakes } = withTargets({ series: 'library-shows' });

			await manager.write({
				categoryTargets: { series: 'library-shows', animes: 'library-shows' },
			});

			expect(fakes.libraries.mergeCategoryInto).toHaveBeenCalledTimes(1);
			expect(fakes.libraries.mergeCategoryInto).toHaveBeenCalledWith('animes', 'library-shows');
		});

		it('leaves the names alone when an unrelated setting is saved', async () => {
			const { manager, fakes } = withTargets({ series: 'library-shows' });

			await manager.write({ maxParallelTransfers: 8 });

			expect(fakes.libraries.mergeCategoryInto).not.toHaveBeenCalled();
		});

		it('does not rewrite a name that a save left exactly as it was', async () => {
			// Re-applying the whole table would put back an alias somebody removed on the
			// libraries screen, on the strength of an unrelated field being saved.
			const { manager, fakes } = withTargets({ series: 'library-shows' });

			await manager.write({ categoryTargets: { series: 'library-shows' } });

			expect(fakes.libraries.mergeCategoryInto).not.toHaveBeenCalled();
		});

		it('keeps the name when the destination is cleared, which is the decision', async () => {
			// Clearing says nothing new lands there. It does not say the category was
			// never that name — and the alias a mapping wrote is indistinguishable from
			// one somebody typed, so undoing it here would destroy a name somebody chose.
			const { manager, fakes } = withTargets({ series: 'library-shows' });

			await manager.write({ categoryTargets: {} });

			expect(fakes.libraries.mergeCategoryInto).not.toHaveBeenCalled();
			expect(fakes.settings.update).toHaveBeenCalledWith({ categoryTargets: {} });
		});

		it('keeps it when the whole table is replaced by one about another category', async () => {
			const { manager, fakes } = withTargets({ series: 'library-shows' });

			await manager.write({ categoryTargets: { animes: 'library-animes' } });

			expect(fakes.libraries.mergeCategoryInto).toHaveBeenCalledTimes(1);
			expect(fakes.libraries.mergeCategoryInto).toHaveBeenCalledWith('animes', 'library-animes');
		});

		it('moves the stored destination to the key the rename produced', async () => {
			/*
			 * The defect: saving `series -> the Shows library` renames the libraries of
			 * `series` to `Shows`, and a category key is folded from the name people
			 * read — so the category that entry was saved against no longer exists one
			 * line later. Placement looked `series` up, found nothing, fell back to the
			 * default library and filed the episode in a folder nobody chose, with no
			 * error and nothing on screen. "Where the files land is not reliable at all"
			 * is what that looks like from outside.
			 */
			const { manager, fakes } = withTargets();

			const settings = await manager.write({ categoryTargets: { series: 'library-shows' } });

			expect(settings.categoryTargets).toEqual({ shows: 'library-shows' });
			expect(fakes.settings.update).toHaveBeenLastCalledWith({
				categoryTargets: { shows: 'library-shows' },
			});
		});

		it('leaves an entry already standing at the merged key exactly where it is', async () => {
			// It is either the same answer or a choice made in this very patch, and a
			// side effect must not overwrite either of them.
			const { manager } = withTargets();

			const settings = await manager.write({
				categoryTargets: { series: 'library-shows', shows: 'library-chosen' },
			});

			expect(settings.categoryTargets).toEqual({ shows: 'library-chosen' });
		});

		it('writes the table once when no rename moved a key', async () => {
			// The second write is the correction, and a correction that fires when
			// nothing moved is an extra row rewritten on every unrelated save.
			const { manager, fakes } = withTargets();

			fakes.libraries.mergeCategoryInto.mockResolvedValue('Séries');

			const settings = await manager.write({ categoryTargets: { series: 'library-series' } });

			expect(settings.categoryTargets).toEqual({ series: 'library-series' });
			expect(fakes.settings.update).toHaveBeenCalledTimes(1);
		});

		it('saves the setting even when nothing was renamed', async () => {
			// Every guard in the manager below answers null, and a destination is still a
			// destination: the file has to land there whether or not a name moved.
			const { manager, fakes } = withTargets();

			fakes.libraries.mergeCategoryInto.mockResolvedValue(null);

			const settings = await manager.write({ categoryTargets: { series: 'library-theirs' } });

			expect(settings.categoryTargets).toEqual({ series: 'library-theirs' });
		});
	});

	it('reads through to the service that owns the defaults', async () => {
		const { manager } = build();

		await expect(manager.read()).resolves.toEqual({ ...DEFAULT_SETTINGS, pinned: [] });
	});

	it('carries which fields the deployment pinned, so a form can lock them', async () => {
		// A screen that rendered before this arrived would offer an editable control
		// for a locked field and then take it away — and somebody will have typed in it.
		const { manager, fakes } = build();

		fakes.settings.view.mockResolvedValue({ ...DEFAULT_SETTINGS, pinned: ['peerMaxDepth'] });

		await expect(manager.read()).resolves.toMatchObject({ pinned: ['peerMaxDepth'] });
	});

	/*
	 * The request source's key, which is the third secret on that screen.
	 *
	 * The indexer's and the client's were handled and this one was added later, so it is
	 * pinned down here rather than left to the fact that the code currently reads the
	 * same. Both halves matter and each fails silently on its own: a key sent back would
	 * be a key readable by anybody who can open the screen, and a blank box taken
	 * literally would unauthenticate a working Seerr the first time somebody corrects its
	 * address — the only symptom being a request list that goes empty.
	 */
	describe('the request source’s key', () => {
		const withSource = () => {
			const made = build();
			const source = {
				...DEFAULT_SETTINGS,
				requestSource: {
					type: RequestSourceType.SEERR,
					baseUrl: 'http://jellyseerr:5055',
					apiKey: 'stored',
					enabled: true,
				},
			};

			made.fakes.settings.get.mockResolvedValue(source);
			made.fakes.settings.view.mockResolvedValue({ ...source, pinned: [] });

			return made;
		};

		it('is never sent back, and the screen is told only that one is set', async () => {
			const { manager } = withSource();

			await expect(manager.read()).resolves.toMatchObject({
				requestSource: { apiKey: null, hasApiKey: true },
			});
		});

		it('survives a save that carries no key, because blank means "keep it"', async () => {
			const { manager, fakes } = withSource();

			await manager.write({
				requestSource: {
					type: RequestSourceType.SEERR,
					baseUrl: 'http://seerr.local',
					enabled: true,
				},
			});

			expect(fakes.settings.update).toHaveBeenCalledWith({
				requestSource: expect.objectContaining({
					baseUrl: 'http://seerr.local',
					apiKey: 'stored',
				}),
			});
		});

		it('is replaced when one was actually typed', async () => {
			const { manager, fakes } = withSource();

			await manager.write({
				requestSource: {
					type: RequestSourceType.SEERR,
					baseUrl: 'http://seerr.local',
					apiKey: 'typed',
					enabled: true,
				},
			});

			expect(fakes.settings.update).toHaveBeenCalledWith({
				requestSource: expect.objectContaining({ apiKey: 'typed' }),
			});
		});
	});

	/*
	 * The first save, when there is nothing to keep.
	 *
	 * "Blank means keep what you have" has a second half that only shows up on a gateway
	 * nobody has configured yet: there is nothing stored, so what gets written is the
	 * absence — and it has to be written as `null` rather than left undefined, because an
	 * undefined key is dropped on the way into a JSON column and the row would then carry
	 * no `apiKey` field at all. Everything downstream reads that as "a key I cannot see"
	 * instead of "no key", and the screen that says whether one is set would lie.
	 */
	describe('a secret left blank with nothing stored yet', () => {
		it('writes the indexer’s absent key as null and not as nothing', async () => {
			const { manager, fakes } = build();

			await manager.write({
				indexer: {
					type: IndexerType.PROWLARR,
					baseUrl: 'http://prowlarr:9696',
					enabled: true,
				},
			});

			expect(fakes.settings.update).toHaveBeenCalledWith({
				indexer: expect.objectContaining({ apiKey: null }),
			});
		});

		it('does the same for the download client’s password', async () => {
			const { manager, fakes } = build();

			await manager.write({
				downloadClient: {
					type: DownloadClientType.QBITTORRENT,
					baseUrl: 'http://qbittorrent:8080',
					username: 'admin',
					rootMappings: [],
					enabled: true,
				},
			});

			expect(fakes.settings.update).toHaveBeenCalledWith({
				downloadClient: expect.objectContaining({ password: null }),
			});
		});

		it('and for the request source’s key', async () => {
			const { manager, fakes } = build();

			await manager.write({
				requestSource: {
					type: RequestSourceType.SEERR,
					baseUrl: 'http://seerr:5055',
					enabled: true,
				},
			});

			expect(fakes.settings.update).toHaveBeenCalledWith({
				requestSource: expect.objectContaining({ apiKey: null }),
			});
		});
	});
});
