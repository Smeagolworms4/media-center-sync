import {
	ClassificationBlocker,
	DetectedCategory,
	ErrorKey,
	LibraryKind,
	MediaKind,
	type MediaCategory,
	type Settings,
} from '@mcs/shared';
import { NotFoundException } from '@nestjs/common';
import type { MediaItem } from '@/entities';
import type { MediaItemRepository } from '@/repositories';
import type { SettingsService, PlacementLibrary } from '@/services';
import type { LibraryManager } from './library.manager';
import { ClassificationManager } from './classification.manager';

const item = (overrides: Partial<MediaItem> = {}): MediaItem =>
	({
		id: 'item-1',
		serviceId: 'service-1',
		libraryId: 'films',
		parentId: null,
		kind: MediaKind.MOVIE,
		title: 'Spirited Away',
		normalizedTitle: 'spirited away',
		year: 2001,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: null,
		artworkUrl: null,
		file: { path: '/media/Films/Spirited Away (2001).mkv' },
		quality: null,
		companions: null,
		overrides: null,
		reported: null,
		...overrides,
	}) as MediaItem;

const category = (overrides: Partial<MediaCategory> = {}): MediaCategory => ({
	key: 'films',
	name: 'Films',
	kind: LibraryKind.MOVIES,
	position: 0,
	libraryIds: ['films'],
	serviceIds: ['service-1'],
	itemCount: 10,
	local: true,
	...overrides,
});

const library = (overrides: Partial<PlacementLibrary> = {}): PlacementLibrary => ({
	id: 'films',
	name: 'Films',
	kind: LibraryKind.MOVIES,
	localPath: '/media/Films',
	writable: true,
	isDefaultTarget: false,
	categoryKey: 'films',
	...overrides,
});

interface Fakes {
	items: { findOneBy: jest.Mock; save: jest.Mock; update: jest.Mock; delete: jest.Mock };
	libraries: {
		categories: jest.Mock;
		placementLibraries: jest.Mock;
		update: jest.Mock;
		addKeyword: jest.Mock;
	};
	settings: { get: jest.Mock; update: jest.Mock };
}

const build = (options: {
	row?: MediaItem | null;
	categories?: MediaCategory[];
	libraries?: PlacementLibrary[];
	targets?: Record<string, string>;
} = {}): { manager: ClassificationManager; fakes: Fakes } => {
	const fakes: Fakes = {
		items: {
			findOneBy: jest.fn().mockResolvedValue(options.row === undefined ? item() : options.row),
			save: jest.fn(),
			update: jest.fn(),
			delete: jest.fn(),
		},
		libraries: {
			categories: jest.fn().mockResolvedValue(options.categories ?? [category()]),
			placementLibraries: jest.fn().mockResolvedValue(options.libraries ?? [library()]),
			update: jest.fn(),
			addKeyword: jest.fn(),
		},
		settings: {
			get: jest.fn().mockResolvedValue({ categoryTargets: options.targets ?? {} } as Settings),
			update: jest.fn(),
		},
	};

	return {
		manager: new ClassificationManager(
			fakes.items as unknown as MediaItemRepository,
			fakes.libraries as unknown as LibraryManager,
			fakes.settings as unknown as SettingsService,
		),
		fakes,
	};
};

const animeShelf = () =>
	category({ key: 'animes', name: 'Animés', libraryIds: ['animes'], position: 1 });

const animeLibrary = (overrides: Partial<PlacementLibrary> = {}) =>
	library({ id: 'animes', name: 'Animés', localPath: '/media/Animes', categoryKey: 'animes', ...overrides });

describe('reading one media', () => {
	it('refuses an item nothing knows about', async () => {
		const { manager } = build({ row: null });

		await expect(manager.propose('missing')).rejects.toThrow(
			new NotFoundException(ErrorKey.MEDIA_NOT_FOUND),
		);
	});

	it('answers where the media sits now, so a screen can put the question as from and to', async () => {
		const { manager } = build();

		const answer = await manager.propose('item-1');

		expect(answer.itemId).toBe('item-1');
		expect(answer.currentLibraryId).toBe('films');
		expect(answer.currentCategoryKey).toBe('films');
		expect(answer.currentCategoryName).toBe('Films');
	});

	it('answers both halves even when it has nothing to propose', async () => {
		// An empty object would be indistinguishable from a broken route, which is the
		// defect class this whole feature is careful about.
		const { manager } = build({ row: item({ title: 'Heat', file: null }) });

		const answer = await manager.propose('item-1');

		expect(answer.proposals).toEqual([]);
		expect(answer.withheld).toEqual([]);
		expect(answer.requiresConfirmation).toBe(true);
	});
});

describe('nothing is written, ever', () => {
	/*
	 * The guarantee the household actually cares about, asserted rather than trusted. A
	 * later change that made this manager helpful — filing the obvious cases, queueing a
	 * job, remembering a dismissal — would break this test, and that is the review it
	 * deserves to get.
	 */
	it('touches no repository, no library and no setting beyond reading them', async () => {
		const { manager, fakes } = build({
			row: item({ file: { path: '/media/Films/Spirited Away.mkv' } } as Partial<MediaItem>),
			categories: [category(), animeShelf()],
			libraries: [library(), animeLibrary()],
		});

		await manager.propose('item-1');

		expect(fakes.items.save).not.toHaveBeenCalled();
		expect(fakes.items.update).not.toHaveBeenCalled();
		expect(fakes.items.delete).not.toHaveBeenCalled();
		expect(fakes.libraries.update).not.toHaveBeenCalled();
		expect(fakes.libraries.addKeyword).not.toHaveBeenCalled();
		expect(fakes.settings.update).not.toHaveBeenCalled();
	});

	it('exposes no way to accept its own suggestion', () => {
		// The accepting write is `PUT /media/:id/override`, deliberately the same one a
		// person re-filing by hand has always used. A second mechanism here would be a way
		// to re-file that behaves differently from re-filing by hand.
		const { manager } = build();
		const surface = Object.getOwnPropertyNames(ClassificationManager.prototype).filter(
			(name) => name !== 'constructor' && !name.startsWith('_'),
		);

		expect(surface).toEqual(['propose']);
		expect(manager).toBeInstanceOf(ClassificationManager);
	});
});

describe('mapping a detected category onto a shelf that exists', () => {
	it('proposes nothing for a film the index knows only the title of', async () => {
		/*
		 * The honest state of the index, pinned so nobody is surprised by it. *Spirited
		 * Away* is an anime film and the catalogue carries no genre and no studio for it, so
		 * the detector has a title, a year and a path — and a title says nothing about
		 * animation. The route abstains, which is correct and is also the measure of what
		 * indexing genres would buy.
		 */
		const { manager } = build({
			row: item({ title: 'Spirited Away', kind: MediaKind.MOVIE }),
			categories: [category(), animeShelf()],
			libraries: [library(), animeLibrary()],
		});

		const answer = await manager.propose('item-1');

		expect(answer.proposals).toEqual([]);
	});

	it('proposes the anime shelf for a fansub release, with the library to write', async () => {
		const { manager } = build({
			row: item({
				kind: MediaKind.SERIES,
				libraryId: 'films',
				title: 'Frieren',
				file: { path: '/media/SeriesTV/[SubsPlease] Frieren - 01 (1080p).mkv' } as never,
			}),
			categories: [category(), animeShelf()],
			libraries: [library(), animeLibrary()],
		});

		const answer = await manager.propose('item-1');

		expect(answer.proposals).toHaveLength(1);
		expect(answer.proposals[0]).toMatchObject({
			category: DetectedCategory.ANIME,
			categoryKey: 'animes',
			categoryName: 'Animés',
			libraryId: 'animes',
			libraryName: 'Animés',
			blocker: null,
		});
		expect(answer.proposals[0].evidence.length).toBeGreaterThan(1);
	});

	it('reports a shelf this gateway does not have rather than offering it', async () => {
		const { manager } = build({
			row: item({
				kind: MediaKind.SERIES,
				title: 'Frieren',
				file: { path: '/media/SeriesTV/[SubsPlease] Frieren - 01.mkv' } as never,
			}),
			categories: [category()],
			libraries: [library()],
		});

		const answer = await manager.propose('item-1');

		expect(answer.proposals[0]).toMatchObject({
			category: DetectedCategory.ANIME,
			blocker: ClassificationBlocker.NO_SUCH_CATEGORY,
			categoryKey: null,
			libraryId: null,
		});
	});

	it('reports a shelf that exists only on a server it cannot write to', async () => {
		const { manager } = build({
			row: item({
				kind: MediaKind.SERIES,
				title: 'Frieren',
				file: { path: '/media/SeriesTV/[SubsPlease] Frieren - 01.mkv' } as never,
			}),
			categories: [category(), animeShelf()],
			libraries: [library(), animeLibrary({ writable: false })],
		});

		const answer = await manager.propose('item-1');

		expect(answer.proposals[0]).toMatchObject({
			category: DetectedCategory.ANIME,
			blocker: ClassificationBlocker.NO_WRITABLE_LIBRARY,
			// Named anyway, because "you have no writable anime library" is the sentence
			// that tells somebody what to fix.
			categoryKey: 'animes',
			categoryName: 'Animés',
			libraryId: null,
		});
	});

	it('says so when the media is already on the shelf it would propose', async () => {
		const { manager } = build({
			row: item({
				kind: MediaKind.SERIES,
				libraryId: 'animes',
				title: 'Frieren',
				file: { path: '/media/Animes/[SubsPlease] Frieren - 01.mkv' } as never,
			}),
			categories: [category(), animeShelf()],
			libraries: [library(), animeLibrary()],
		});

		const answer = await manager.propose('item-1');

		expect(answer.proposals[0]).toMatchObject({
			blocker: ClassificationBlocker.ALREADY_FILED,
			libraryId: null,
		});
	});

	it('tells an animated films shelf apart from an anime one', async () => {
		/*
		 * `Animés - Films` contains the word `animes`, so without the longest-phrase rule
		 * the household's animated-films shelf would answer for anime as well — and an
		 * anime series would be proposed for the films shelf.
		 */
		const { manager } = build({
			row: item({
				kind: MediaKind.SERIES,
				title: 'Frieren',
				file: { path: '/media/SeriesTV/[SubsPlease] Frieren - 01.mkv' } as never,
			}),
			categories: [
				category(),
				category({
					key: 'animes-films',
					name: 'Animés - Films',
					libraryIds: ['animes-films'],
					position: 1,
				}),
				animeShelf(),
			],
			libraries: [
				library(),
				library({ id: 'animes-films', name: 'Animés - Films', categoryKey: 'animes-films' }),
				animeLibrary(),
			],
		});

		const answer = await manager.propose('item-1');

		expect(answer.proposals[0]).toMatchObject({
			category: DetectedCategory.ANIME,
			categoryKey: 'animes',
			libraryId: 'animes',
		});
	});
});

describe('which library of a shelf to name', () => {
	const twoAnimeDisks = {
		categories: [
			category(),
			category({ key: 'animes', name: 'Animés', libraryIds: ['animes-1', 'animes-2'], position: 1 }),
		],
		libraries: [
			library(),
			animeLibrary({ id: 'animes-1', name: 'Animés A' }),
			animeLibrary({ id: 'animes-2', name: 'Animés B' }),
		],
		row: item({
			kind: MediaKind.SERIES,
			title: 'Frieren',
			file: { path: '/media/SeriesTV/[SubsPlease] Frieren - 01.mkv' } as never,
		}),
	};

	it('prefers the library the household already named for that category', async () => {
		// The same library a new pull of that category would land in, so a suggestion and a
		// pull cannot send one series to two disks.
		const { manager } = build({ ...twoAnimeDisks, targets: { animes: 'animes-2' } });

		expect((await manager.propose('item-1')).proposals[0].libraryId).toBe('animes-2');
	});

	it('falls back to a library marked as a default target', async () => {
		const { manager } = build({
			...twoAnimeDisks,
			libraries: [
				library(),
				animeLibrary({ id: 'animes-1', name: 'Animés A' }),
				animeLibrary({ id: 'animes-2', name: 'Animés B', isDefaultTarget: true }),
			],
		});

		expect((await manager.propose('item-1')).proposals[0].libraryId).toBe('animes-2');
	});

	it('is stable across calls when nothing says which', async () => {
		// A suggestion that changes on a refresh is one nobody trusts.
		const { manager } = build(twoAnimeDisks);

		const first = await manager.propose('item-1');
		const second = await manager.propose('item-1');

		expect(first.proposals[0].libraryId).toBe('animes-1');
		expect(second.proposals[0].libraryId).toBe(first.proposals[0].libraryId);
	});

	it('ignores a named target that is not writable', async () => {
		const { manager } = build({
			...twoAnimeDisks,
			libraries: [
				library(),
				animeLibrary({ id: 'animes-1', name: 'Animés A' }),
				animeLibrary({ id: 'animes-2', name: 'Animés B', writable: false }),
			],
			targets: { animes: 'animes-2' },
		});

		expect((await manager.propose('item-1')).proposals[0].libraryId).toBe('animes-1');
	});
});

describe('ordering and the edges', () => {
	it('puts the actionable proposal before the blocked one', async () => {
		// An anime film is both an anime and an animated film. When only one of the two
		// shelves can actually be written to, that is the one with a button beside it and it
		// belongs first.
		const { manager } = build({
			row: item({
				kind: MediaKind.MOVIE,
				title: 'Suzume',
				file: { path: '/media/Films/[SubsPlease] Suzume (1080p).mkv' } as never,
			}),
			categories: [
				category(),
				animeShelf(),
				category({
					key: 'films-d-animation',
					name: "Films d'animation",
					libraryIds: ['animated'],
					position: 2,
				}),
			],
			libraries: [
				library(),
				animeLibrary({ writable: false }),
				library({
					id: 'animated',
					name: "Films d'animation",
					categoryKey: 'films-d-animation',
				}),
			],
		});

		const answer = await manager.propose('item-1');

		expect(answer.proposals.map((one) => one.category)).toEqual([
			DetectedCategory.ANIMATED_FILMS,
			DetectedCategory.ANIME,
		]);
		expect(answer.proposals[0].blocker).toBeNull();
		expect(answer.proposals[1].blocker).toBe(ClassificationBlocker.NO_WRITABLE_LIBRARY);
	});

	it('answers a null current category for a library no category claims', async () => {
		// Categories come from library names, so one disappears the moment its service goes
		// offline. The question is still answerable and must not throw.
		const { manager } = build({ row: item({ libraryId: 'orphan' }) });

		const answer = await manager.propose('item-1');

		expect(answer.currentLibraryId).toBe('orphan');
		expect(answer.currentCategoryKey).toBeNull();
		expect(answer.currentCategoryName).toBeNull();
	});
});

describe('withheld candidates reach the answer', () => {
	it('carries what it considered and did not propose', async () => {
		const { manager } = build({
			row: item({
				kind: MediaKind.SERIES,
				title: 'Some Show',
				file: { path: '/media/Animes/Some Show/S01E01.mkv' } as never,
			}),
			categories: [category(), animeShelf()],
			libraries: [library(), animeLibrary()],
		});

		const answer = await manager.propose('item-1');

		// A folder keyword alone is not a reason, and the answer says which category it was
		// not a reason for.
		expect(answer.proposals).toEqual([]);
		expect(answer.withheld.map((one) => one.category)).toEqual([DetectedCategory.CARTOONS]);
		expect(answer.withheld[0].withheld).not.toBeNull();
	});
});
