import {
	ErrorKey,
	MediaKind,
	MediaRequestState,
	RequestSourceType,
	type MediaRequest,
	type RequestDetails,
	type RequestSourceSettings,
} from '@mcs/shared';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { MediaItem } from '@/entities';
import type { MediaItemRepository } from '@/repositories';
import type { SettingsService } from '@/services';
import type { RequestSourceRegistry } from '@/services/requests';
import { RequestManager } from './request.manager';

/**
 * What the household asked for, against what this gateway holds.
 *
 * The verdict is what is being pinned here, because it is the only thing on the screen
 * somebody acts on. Three answers have to stay distinguishable and each one has cost
 * somebody an evening elsewhere in this product: we hold every bit of this, we hold some
 * of it, we have never heard of it. Folding the middle one into either of the others is
 * how a request for seasons two and three gets closed on the strength of holding two.
 *
 * The other half is that nothing here fetches anything. A request is matched and the
 * search it implies is *suggested*; the suggestion is a sentence, and no test in this file
 * may ever be able to make bytes move.
 */

const SETTINGS: RequestSourceSettings = {
	type: RequestSourceType.SEERR,
	baseUrl: 'http://seerr:5055',
	apiKey: 'a-key',
	enabled: true,
};

const item = (over: Partial<MediaItem>): MediaItem =>
	({
		id: 'item-1',
		serviceId: 'service-1',
		libraryId: 'lib-1',
		parentId: null,
		kind: MediaKind.MOVIE,
		title: 'Untitled',
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		...over,
	}) as MediaItem;

/** A film of ours, which TMDB calls 200. */
const FILM = item({ id: 'item-film', kind: MediaKind.MOVIE, title: 'Dune', externalIds: { tmdb: '200' } });

/** A show of ours, known to Seerr by its TVDB identifier and to TMDB by another. */
const SHOW = item({
	id: 'item-show',
	kind: MediaKind.SERIES,
	title: 'Spartacus',
	externalIds: { tmdb: '100', tvdb: '20' },
});

/**
 * A film nothing ever identified, and a second copy of the show on another server.
 *
 * Both are here to be in the way: the first must not match a request that carries no
 * identifier either, and the second is what makes "we hold season three" true when only
 * one of the two copies has it.
 */
const UNIDENTIFIED = item({ id: 'item-mystery', kind: MediaKind.MOVIE, title: 'Mystery' });
const SHOW_ELSEWHERE = item({
	id: 'item-show-2',
	serviceId: 'service-2',
	kind: MediaKind.SERIES,
	title: 'Spartacus',
	externalIds: { tvdb: '20' },
});

const SEASON_TWO = item({
	id: 'item-season-2',
	kind: MediaKind.SEASON,
	parentId: SHOW.id,
	title: 'Season 2',
	seasonNumber: 2,
	externalIds: { tmdb: '555' },
});

/**
 * What sits under the shows we hold.
 *
 * The last two rows are deliberate rubbish a real catalogue holds: a season nothing could
 * number, and a row whose parent link was never written. Neither may count as a season we
 * hold, and neither may throw.
 */
const SEASON_ROWS = [
	SEASON_TWO,
	item({ id: 'item-season-3', kind: MediaKind.SEASON, parentId: SHOW.id, title: 'Season 3', seasonNumber: 3 }),
	item({ id: 'item-season-3b', kind: MediaKind.SEASON, parentId: SHOW_ELSEWHERE.id, title: 'Season 3', seasonNumber: 3 }),
	item({ id: 'item-season-x', kind: MediaKind.SEASON, parentId: SHOW.id, title: 'Specials', seasonNumber: null }),
	item({ id: 'item-season-y', kind: MediaKind.SEASON, parentId: null, title: 'Orphan', seasonNumber: 9 }),
];

const CATALOGUE = [FILM, SHOW, SHOW_ELSEWHERE, UNIDENTIFIED];

const request = (over: Partial<MediaRequest>): MediaRequest => ({
	id: 'request-1',
	mediaId: 'media-1',
	kind: MediaKind.MOVIE,
	title: null,
	tmdbId: null,
	tvdbId: null,
	state: MediaRequestState.APPROVED,
	seasons: [],
	requestedBy: 'Damien',
	requestedAt: '2026-01-01T00:00:00.000Z',
	...over,
});

/** The film we hold, asked for by TMDB identifier. */
const FILM_REQUEST = request({ id: '1', mediaId: '11', tmdbId: '200' });

/** Seasons two and three of the show we hold, which is every one of them. */
const SHOW_REQUEST = request({
	id: '2',
	mediaId: '12',
	kind: MediaKind.SERIES,
	tvdbId: '20',
	seasons: [
		{ seasonNumber: 2, state: MediaRequestState.AVAILABLE },
		{ seasonNumber: 3, state: MediaRequestState.AVAILABLE },
	],
});

/** Seasons two and four, and nothing here has ever held a fourth. */
const PARTIAL_REQUEST = request({
	id: '3',
	mediaId: '13',
	kind: MediaKind.SERIES,
	tvdbId: '20',
	seasons: [
		{ seasonNumber: 2, state: MediaRequestState.AVAILABLE },
		{ seasonNumber: 4, state: MediaRequestState.PROCESSING },
	],
});

/** Something nobody here has heard of, and which the source cannot even name. */
const STRANGER = request({ id: '4', mediaId: '14', tmdbId: '999', state: MediaRequestState.PENDING });

/** What Seerr can say about the show at TMDB 700, which no library of ours holds. */
const LOOKUP: RequestDetails = {
	title: 'Severance',
	year: 2022,
	overview: 'Memories, divided.',
	artworkUrl: 'https://image.tmdb.org/severance.jpg',
	seasonNumbers: [1, 2],
};

interface Fakes {
	items: { find: jest.Mock; findOne: jest.Mock };
	source: {
		list: jest.Mock;
		find: jest.Mock;
		markAvailable: jest.Mock;
		create: jest.Mock;
		probe: jest.Mock;
		details: jest.Mock;
	};
	sources: { get: jest.Mock };
	settings: { get: jest.Mock };
}

const build = (
	over: { requestSource?: RequestSourceSettings | null; requests?: MediaRequest[] } = {},
): { manager: RequestManager; fakes: Fakes } => {
	const requests = over.requests ?? [FILM_REQUEST, SHOW_REQUEST, PARTIAL_REQUEST, STRANGER];
	const fakes: Fakes = {
		items: {
			// One shelf, two questions: the films and shows we hold, and the seasons under
			// a set of them. A fake that answered the same rows to both would make every
			// film look like it had seasons.
			find: jest.fn((options: { where: Record<string, unknown> }) =>
				Promise.resolve('parentId' in options.where ? SEASON_ROWS : CATALOGUE),
			),
			findOne: jest.fn((options: { where: { id: string } }) =>
				Promise.resolve(
					[...CATALOGUE, ...SEASON_ROWS].find((one) => one.id === options.where.id) ?? null,
				),
			),
		},
		source: {
			list: jest.fn().mockResolvedValue(requests),
			find: jest.fn((_settings: unknown, id: string) =>
				Promise.resolve(requests.find((one) => one.id === id) ?? null),
			),
			markAvailable: jest.fn().mockResolvedValue(undefined),
			// Seerr answers the row it created, and answers nothing when it already had the
			// same ask open. Both are successes; this is the first.
			create: jest.fn((_settings: unknown) => Promise.resolve(request({ id: '9' }))),
			probe: jest.fn().mockResolvedValue(true),
			// A source that cannot name the thing by default, which is the honest default:
			// the lookup is somebody else's API over a version nobody pins, and a test
			// suite where it always answers would never see the row that stays unnamed.
			details: jest.fn().mockResolvedValue(null),
		},
		sources: { get: jest.fn() },
		settings: {
			get: jest.fn().mockResolvedValue({
				requestSource: over.requestSource === undefined ? SETTINGS : over.requestSource,
			}),
		},
	};

	fakes.sources.get.mockReturnValue(fakes.source);

	const manager = new RequestManager(
		fakes.items as unknown as MediaItemRepository,
		fakes.sources as unknown as RequestSourceRegistry,
		fakes.settings as unknown as SettingsService,
	);

	return { manager, fakes };
};

describe('RequestManager', () => {
	describe('nothing configured', () => {
		it('refuses to list, naming the screen that fixes it', async () => {
			const { manager, fakes } = build({ requestSource: null });

			await expect(manager.list()).rejects.toThrow(ErrorKey.REQUEST_SOURCE_NOT_CONFIGURED);
			expect(fakes.sources.get).not.toHaveBeenCalled();
		});

		it('refuses a source somebody configured and then switched off', async () => {
			const { manager } = build({ requestSource: { ...SETTINGS, enabled: false } });

			await expect(manager.list()).rejects.toThrow(ConflictException);
		});

		it('refuses to push an ask as well, rather than losing it silently', async () => {
			const { manager, fakes } = build({ requestSource: null });

			await expect(manager.create({ itemId: FILM.id })).rejects.toThrow(ConflictException);
			expect(fakes.source.create).not.toHaveBeenCalled();
		});
	});

	/**
	 * A request server that is down.
	 *
	 * It has to come out as a failure and never as an empty list: "nobody has asked for
	 * anything" and "your request server is not answering" are opposite sentences, and a
	 * screen showing the first for the second tells a household nothing is outstanding.
	 */
	describe('a source that will not answer', () => {
		it('fails the listing rather than answering nothing', async () => {
			const { manager, fakes } = build();

			fakes.source.list.mockRejectedValue(
				new ServiceUnavailableException(ErrorKey.REQUEST_SOURCE_UNREACHABLE),
			);

			await expect(manager.list()).rejects.toThrow(ErrorKey.REQUEST_SOURCE_UNREACHABLE);
			// And the catalogue is never read for a page there is nothing to say about.
			expect(fakes.items.find).not.toHaveBeenCalled();
		});
	});

	describe('list', () => {
		it('says we hold a film that was asked for, and that closing it would be honest', async () => {
			const { manager } = build();

			const [view] = await manager.list();

			expect(view.heldAlready).toBe(true);
			// Named by our own copy. A request row carries no title, so for anything we hold
			// the shelf is the only name there is — and it is the one the household already
			// sees everywhere else. Left unset, the row is a number even when we have it.
			expect(view.title).toBe('Dune');
			expect(view.holdings).toEqual([
				{ itemId: FILM.id, title: 'Dune', serviceId: 'service-1', seasonNumbers: [] },
			]);
			expect(view.fulfillable).toBe(true);
			expect(view.missingSeasons).toEqual([]);
			// Nothing left to look for, so nothing is suggested.
			expect(view.suggestion).toBeNull();
		});

		it('matches a show on its TVDB identifier and counts a season held on either copy', async () => {
			const { manager } = build();

			const view = (await manager.list()).find((one) => one.id === SHOW_REQUEST.id);

			expect(view?.holdings.map((holding) => holding.itemId)).toEqual([SHOW.id, SHOW_ELSEWHERE.id]);
			expect(view?.holdings[0]?.seasonNumbers).toEqual([2, 3]);
			expect(view?.missingSeasons).toEqual([]);
			expect(view?.fulfillable).toBe(true);
		});

		it('refuses to call a request fulfillable on the season it is short of', async () => {
			const { manager } = build();

			const view = (await manager.list()).find((one) => one.id === PARTIAL_REQUEST.id);

			expect(view?.heldAlready).toBe(true);
			expect(view?.missingSeasons).toEqual([4]);
			expect(view?.fulfillable).toBe(false);
			// And the search worth running is for that season alone, named from our own copy
			// because the request itself carries no title.
			expect(view?.suggestion).toEqual({
				term: 'Spartacus',
				kind: MediaKind.SERIES,
				seasonNumbers: [4],
			});
		});

		it('holds nothing for a work nobody here has ever heard of', async () => {
			const { manager } = build();

			const view = (await manager.list()).find((one) => one.id === STRANGER.id);

			expect(view?.holdings).toEqual([]);
			expect(view?.heldAlready).toBe(false);
			expect(view?.fulfillable).toBe(false);
			// Nothing to search *with*: Seerr's rows carry identifiers and no title, no copy
			// of ours can lend it one, and the source could not name it either.
			expect(view?.details).toBeNull();
			expect(view?.suggestion).toBeNull();
		});

		it('suggests a search when the source did name the work', async () => {
			const { manager } = build({
				requests: [request({ id: '5', tmdbId: '999', title: 'Arrival', kind: MediaKind.MOVIE })],
			});

			const [view] = await manager.list();

			expect(view.suggestion).toEqual({ term: 'Arrival', kind: MediaKind.MOVIE, seasonNumbers: [] });
		});

		/*
		 * The row somebody is actually looking at.
		 *
		 * A request is by definition for something the household does not have, so the
		 * rows with nothing of ours under them are most of the screen — and a request row
		 * carries no title, which left them as a column of numbers with no name and no
		 * words to search a tracker with. The source knows; it is asked.
		 */
		describe('a request no library of ours matches', () => {
			const UNHELD = request({
				id: '6',
				mediaId: '16',
				kind: MediaKind.SERIES,
				tmdbId: '700',
				seasons: [],
			});

			it('brings the work up from the source, and can then name a search', async () => {
				const { manager, fakes } = build({ requests: [UNHELD] });

				fakes.source.details.mockResolvedValue(LOOKUP);

				const [view] = await manager.list();

				expect(fakes.source.details).toHaveBeenCalledWith(SETTINGS, MediaKind.SERIES, '700');
				expect(view.title).toBe('Severance');
				expect(view.details).toEqual(LOOKUP);
				// Nothing of ours is under it, so nothing is "missing" in the sense the rest
				// of this uses — every season the source knows of is what to look for.
				expect(view.suggestion).toEqual({
					term: 'Severance',
					kind: MediaKind.SERIES,
					seasonNumbers: [1, 2],
				});
			});

			it('searches the seasons actually asked for rather than the whole show', async () => {
				const { manager, fakes } = build({
					requests: [
						{ ...UNHELD, seasons: [{ seasonNumber: 2, state: MediaRequestState.PENDING }] },
					],
				});

				fakes.source.details.mockResolvedValue(LOOKUP);

				const [view] = await manager.list();

				expect(view.suggestion?.seasonNumbers).toEqual([2]);
			});

			it('still loads the page when the source cannot name it', async () => {
				const { manager, fakes } = build({ requests: [UNHELD] });

				fakes.source.details.mockResolvedValue(null);

				const [view] = await manager.list();

				expect(view.title).toBeNull();
				expect(view.details).toBeNull();
				expect(view.suggestion).toBeNull();
			});

			/*
			 * A lookup that throws must not take the listing with it. `details` promises to
			 * answer null rather than raise, but it is a call over somebody else's HTTP API
			 * and a source outside this repository can break that promise — and a household
			 * losing its whole request screen because one metadata route answered 500 is a
			 * worse failure than one row with no name on it.
			 */
			it('survives a lookup that raises', async () => {
				const { manager, fakes } = build({ requests: [UNHELD] });

				fakes.source.details.mockRejectedValue(new Error('500'));

				const [view] = await manager.list();

				expect(view.details).toBeNull();
				expect(view.title).toBeNull();
			});

			it('never asks about a request we hold, nor about one with no identifier', async () => {
				const { manager, fakes } = build({
					requests: [FILM_REQUEST, SHOW_REQUEST, request({ id: '7', mediaId: '17' })],
				});

				await manager.list();

				// One round trip per open ask would be a listing that spends a request each
				// to re-learn titles our own rows already carry.
				expect(fakes.source.details).not.toHaveBeenCalled();
			});
		});

		it('reads the catalogue once for the whole page', async () => {
			const { manager, fakes } = build();

			await manager.list();

			// Once for the films and shows, once for the seasons under the ones that matched.
			expect(fakes.items.find).toHaveBeenCalledTimes(2);
		});

		it('passes the query through and answers nothing for an empty source', async () => {
			const { manager, fakes } = build({ requests: [] });

			await expect(manager.list({ state: MediaRequestState.PENDING, take: 5 })).resolves.toEqual([]);
			expect(fakes.source.list).toHaveBeenCalledWith(SETTINGS, {
				state: MediaRequestState.PENDING,
				take: 5,
			});
			// Nothing came back, so there is nothing to match and no reason to read a table.
			expect(fakes.items.find).not.toHaveBeenCalled();
		});
	});

	describe('marking one fulfilled', () => {
		it('marks the media and not the request, and says so without asking again', async () => {
			const { manager, fakes } = build();

			const view = await manager.markFulfilled(SHOW_REQUEST.id);

			expect(fakes.source.markAvailable).toHaveBeenCalledWith(SETTINGS, SHOW_REQUEST.mediaId);
			expect(view.state).toBe(MediaRequestState.AVAILABLE);
			expect(view.fulfillable).toBe(false);
			expect(view.suggestion).toBeNull();
			expect(view.heldAlready).toBe(true);
		});

		/*
		 * The refusal that keeps "answered" meaning something.
		 *
		 * Told an ask is complete, the household stops asking. So closing one that
		 * delivered nothing ends the asking and delivers nothing — and it leaves no trace,
		 * because telling Seerr succeeds and every screen agrees. Exactly the shape of
		 * defect this product keeps producing.
		 */
		it('refuses to close an ask nothing of ours answers', async () => {
			const { manager, fakes } = build();

			await expect(manager.markFulfilled(STRANGER.id)).rejects.toThrow(
				ErrorKey.REQUEST_NOT_HELD,
			);
			expect(fakes.source.markAvailable).not.toHaveBeenCalled();
		});

		it('refuses one we hold half of, rather than closing the ask on the other half', async () => {
			const { manager, fakes } = build();

			// Seasons two and four asked for, four held by nobody here.
			await expect(manager.markFulfilled(PARTIAL_REQUEST.id)).rejects.toThrow(
				ErrorKey.REQUEST_NOT_HELD,
			);
			expect(fakes.source.markAvailable).not.toHaveBeenCalled();
		});

		/*
		 * And the honest exception, said out loud.
		 *
		 * A shelf of discs holds plenty this catalogue was never told about, so somebody
		 * who knows the ask is answered has to be able to close it. `force` is never a
		 * default and the interface never sends it: it is how a caller says it meant to.
		 */
		it('closes one we hold nothing for when the caller says so deliberately', async () => {
			const { manager, fakes } = build();

			const view = await manager.markFulfilled(STRANGER.id, true);

			expect(fakes.source.markAvailable).toHaveBeenCalledWith(SETTINGS, STRANGER.mediaId);
			// Closed, and the view stays honest about what we actually hold.
			expect(view.state).toBe(MediaRequestState.AVAILABLE);
			expect(view.heldAlready).toBe(false);
		});

		it('does nothing at all to one the source already considers held', async () => {
			const { manager, fakes } = build({
				requests: [request({ id: '6', mediaId: '16', tmdbId: '200', state: MediaRequestState.AVAILABLE })],
			});

			const view = await manager.markFulfilled('6');

			expect(fakes.source.markAvailable).not.toHaveBeenCalled();
			expect(view.state).toBe(MediaRequestState.AVAILABLE);
			expect(view.fulfillable).toBe(false);
		});

		it('answers not-found for a request the source has no row for', async () => {
			const { manager, fakes } = build();

			await expect(manager.markFulfilled('nope')).rejects.toThrow(ErrorKey.REQUEST_NOT_FOUND);
			expect(fakes.source.markAvailable).not.toHaveBeenCalled();
		});
	});

	describe('pushing an ask the other way', () => {
		it('asks for a film of ours by the identifier the source addresses works by', async () => {
			const { manager, fakes } = build();

			await manager.create({ itemId: FILM.id });

			expect(fakes.source.create).toHaveBeenCalledWith(SETTINGS, {
				kind: MediaKind.MOVIE,
				tmdbId: '200',
				seasons: undefined,
			});
		});

		it('asks for the seasons that were named', async () => {
			const { manager, fakes } = build();

			await manager.create({ itemId: SHOW.id, seasons: [4, 5] });

			expect(fakes.source.create).toHaveBeenCalledWith(SETTINGS, {
				kind: MediaKind.SERIES,
				tmdbId: '100',
				seasons: [4, 5],
			});
		});

		it('follows the show and not the season when a season page is what was pressed', async () => {
			const { manager, fakes } = build();

			await manager.create({ itemId: SEASON_TWO.id });

			// The show's identifier, never the season's own 555: asking for that would have
			// the household following a different work and it would look like it worked.
			expect(fakes.source.create).toHaveBeenCalledWith(SETTINGS, {
				kind: MediaKind.SERIES,
				tmdbId: '100',
				seasons: [2],
			});
		});

		it('takes a bare identifier when no media of ours is named', async () => {
			const { manager, fakes } = build();

			await manager.create({ tmdbId: '777', kind: MediaKind.SERIES, seasons: [1] });

			expect(fakes.items.findOne).not.toHaveBeenCalled();
			expect(fakes.source.create).toHaveBeenCalledWith(SETTINGS, {
				kind: MediaKind.SERIES,
				tmdbId: '777',
				seasons: [1],
			});
		});

		it('refuses an identifier with no kind, which would ask for the wrong work', async () => {
			const { manager, fakes } = build();

			await expect(manager.create({ tmdbId: '777' })).rejects.toThrow(BadRequestException);
			expect(fakes.source.create).not.toHaveBeenCalled();
		});

		it('refuses a media nothing ever identified', async () => {
			const { manager, fakes } = build();

			await expect(manager.create({ itemId: UNIDENTIFIED.id })).rejects.toThrow(ConflictException);
			expect(fakes.source.create).not.toHaveBeenCalled();
		});

		it('refuses a media of ours that is gone', async () => {
			const { manager } = build();

			await expect(manager.create({ itemId: 'item-nope' })).rejects.toThrow(
				ErrorKey.MEDIA_NOT_FOUND,
			);
		});

		it('refuses a season whose show has gone rather than inventing one', async () => {
			const { manager, fakes } = build();

			fakes.items.findOne.mockImplementation((options: { where: { id: string } }) =>
				Promise.resolve(
					options.where.id === SEASON_TWO.id
						? item({ ...SEASON_TWO, parentId: 'item-vanished' })
						: null,
				),
			);

			await expect(manager.create({ itemId: SEASON_TWO.id })).rejects.toThrow(ConflictException);
		});

		it('refuses a season that hangs from nothing at all', async () => {
			const { manager, fakes } = build();

			// A row like this is ordinary in a half-imported library, and the walk upwards
			// has nowhere to go: there is no show to follow, and the season's own identifier
			// is not one.
			await expect(manager.create({ itemId: 'item-season-y' })).rejects.toThrow(ConflictException);
			expect(fakes.source.create).not.toHaveBeenCalled();
		});

		it('answers nothing when the source already had the same ask open', async () => {
			const { manager, fakes } = build();

			fakes.source.create.mockResolvedValue(null);

			await expect(manager.create({ itemId: FILM.id })).resolves.toBeNull();
		});
	});

	/** Nothing in this manager may reach a download client, now or by accident later. */
	it('never fetches anything for a request', async () => {
		const { manager, fakes } = build();

		const views = await manager.list();

		expect(views.some((view) => view.suggestion !== null)).toBe(true);
		// The whole surface, spelled out so that adding a grab, a download or a "fetch this"
		// to a request source has to be done here first, deliberately, by somebody reading
		// this sentence. Every entry is a read or a status write; none of them moves bytes.
		expect(Object.keys(fakes.source)).toEqual([
			'list',
			'find',
			'markAvailable',
			'create',
			'probe',
			'details',
		]);
	});

	it('does not make a request found by identifier throw for a missing season row', async () => {
		const { manager, fakes } = build();

		fakes.items.find.mockResolvedValue([]);

		const views = await manager.list();

		expect(views.every((view) => view.holdings.length === 0)).toBe(true);
		expect(views.every((view) => view.suggestion === null || view.suggestion.term.length > 0)).toBe(
			true,
		);
	});
});
