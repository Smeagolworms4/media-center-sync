import {
	ErrorKey,
	MediaKind,
	MediaRequestState,
	type MediaRequest,
	type MediaRequestView,
	type RequestCreate,
	type RequestDetails,
	type RequestHolding,
	type RequestOrder,
	type RequestQuery,
	type RequestSourceSettings,
	type RequestSuggestion,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { In } from 'typeorm';
import type { MediaItem } from '@/entities';
import { MediaItemRepository } from '@/repositories';
import { SettingsService } from '@/services';
import { RequestSourceRegistry, type RequestSource } from '@/services/requests';

/**
 * How far up the catalogue a walk to the film or the show may go.
 *
 * An episode sits under a season under a series, so two hops is as deep as the tree goes
 * and this is slack. The bound is here for the shape the data can take rather than the
 * shape it should: a `parentId` cycle written by a bad import would otherwise spin inside
 * an HTTP request, and a gateway that stops answering is a worse bug than a media that
 * cannot be pushed.
 */
const MAX_DEPTH = 4;

/**
 * What the household asked for, against what this gateway holds.
 *
 * The request source reads the asks and knows nothing else; every sentence worth putting
 * on the screen is made here, because every one of them is about the catalogue: whether
 * we hold it, which copies answer it, which seasons are still missing, whether marking it
 * complete would be telling the truth. That division is the same one `ReleaseManager`
 * keeps with an indexer, and for the same reason — a source that matched things to our
 * media would be a second, invisible correlation rule.
 *
 * It fetches nothing, ever. A request is read, matched and *suggested*: the search it
 * implies is worked out and handed to the interface, and a person presses it. Wiring the
 * two together would let anybody with an account on somebody else's Seerr spend this
 * gateway's disk, which is why the loop stops here and not for want of the plumbing.
 */
@Injectable()
export class RequestManager {
	public constructor(
		private readonly _items: MediaItemRepository,
		private readonly _sources: RequestSourceRegistry,
		private readonly _settings: SettingsService,
	) {}

	/** Every ask worth looking at, with what we can say about each. */
	public async list(query: RequestQuery = {}): Promise<MediaRequestView[]> {
		const { source, settings } = await this._configured();

		return this._views(await source.list(settings, query));
	}

	/**
	 * Say the ask is answered, which is what closes it in the place the household looks.
	 *
	 * It is not refused for a request we hold nothing for, and that is deliberate: the
	 * catalogue is what this gateway has been told about, and a household that keeps a
	 * shelf of discs or a library nobody indexed here holds plenty this knows nothing of.
	 * `fulfillable` on the view is how the screen says whether pressing it would be
	 * honest; the press itself belongs to the person who can see both.
	 *
	 * Pressing it on a request the source already considers available does nothing rather
	 * than failing, because two people looking at the same list will press it twice.
	 */
	public async markFulfilled(requestId: string, force = false): Promise<MediaRequestView> {
		const { source, settings } = await this._configured();
		const request = await source.find(settings, requestId);

		if (request === null) {
			throw new NotFoundException(ErrorKey.REQUEST_NOT_FOUND);
		}

		const [view] = await this._views([request]);

		if (request.state === MediaRequestState.AVAILABLE) {
			return view;
		}

		/*
		 * The same rule the interface draws its button from, enforced where it counts.
		 *
		 * `fulfillable` is false for two reasons and both are refused by default: we hold
		 * nothing that answers this, or we hold some of a show and not the seasons asked
		 * for. Marked complete anyway, the household is told its ask is answered and stops
		 * asking — and nothing anywhere reports a fault, because telling Seerr succeeds.
		 * That is the shape of every defect this product keeps producing.
		 *
		 * `force` is how the honest exception gets said out loud: a shelf of discs holds
		 * plenty this catalogue was never told about, and somebody who knows that has to
		 * be able to close the ask. It is a deliberate flag on the call and never a
		 * default, so the interface can only ever press the honest one, and a script that
		 * closes an unanswered ask had to say it meant to.
		 *
		 * The view is computed from the request as it is *now*, re-read above, not from
		 * whatever the list said when the page was drawn.
		 */
		if (!view.fulfillable && !force) {
			throw new ConflictException(ErrorKey.REQUEST_NOT_HELD);
		}

		// The media identifier and never the request's: two rows, two sequences, both
		// small integers on a fresh install, so the wrong one completes somebody else's
		// ask and looks like it worked.
		await source.markAvailable(settings, request.mediaId);

		// Answered from here rather than read back. Seerr writes the media row and then
		// recomputes the request's own status, so a listing taken immediately after still
		// shows the old one — and a screen that redisplayed it would look like the press
		// had failed.
		return {
			...view,
			state: MediaRequestState.AVAILABLE,
			fulfillable: false,
			suggestion: null,
		};
	}

	/**
	 * Ask for something over there, which is how "we are following this here" gets said.
	 *
	 * Either one of our media or a bare TMDB identifier. Naming one of ours is the
	 * ordinary case — it is pressed from a media page — and resolving it to an identifier
	 * is this layer's job, because it is the only one that has ever heard of our rows.
	 */
	public async create(body: RequestCreate): Promise<MediaRequest | null> {
		const { source, settings } = await this._configured();

		return source.create(settings, await this._order(body));
	}

	/**
	 * The configured source, or a refusal naming the screen that fixes it.
	 *
	 * Read on every call rather than at boot, so that configuring Seerr takes effect
	 * without restarting the gateway.
	 */
	private async _configured(): Promise<{
		source: RequestSource;
		settings: RequestSourceSettings;
	}> {
		const settings = (await this._settings.get()).requestSource ?? null;

		if (settings === null || !settings.enabled) {
			throw new ConflictException(ErrorKey.REQUEST_SOURCE_NOT_CONFIGURED);
		}

		return { source: this._sources.get(settings.type), settings };
	}

	private async _order(body: RequestCreate): Promise<RequestOrder> {
		if (body.itemId === undefined) {
			// Nothing of ours named, so the body has to carry both halves itself: an
			// identifier with no kind cannot be asked for, because a film and a show are
			// two different numbering schemes at TMDB and guessing picks the wrong work.
			if (!body.tmdbId || body.kind === undefined) {
				throw new BadRequestException(this._unnameable('no media and no identified work named'));
			}

			return { kind: body.kind, tmdbId: body.tmdbId, seasons: body.seasons };
		}

		const item = await this._items.findOne({ where: { id: body.itemId } });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		const { root, seasons } = await this._anchor(item);
		const tmdbId = root.externalIds?.tmdb;

		// One refusal for the two ways a media of ours cannot be pushed — it is not a film
		// or a show, or nothing ever gave it a TMDB identifier — because from the screen
		// they are the same sentence: there is nothing here the request source could be
		// told to follow.
		if ((root.kind !== MediaKind.MOVIE && root.kind !== MediaKind.SERIES) || !tmdbId) {
			throw new ConflictException(
				this._unnameable(`media ${root.id} has no TMDB identifier to ask for`),
			);
		}

		return {
			kind: root.kind,
			tmdbId,
			// What the body says, or the coordinate the walk came up through — which is
			// what following a season from its own page means.
			seasons: body.seasons ?? (seasons.length > 0 ? seasons : undefined),
		};
	}

	/**
	 * "There is nothing here a request source could be told to follow."
	 *
	 * `GENERAL` is a gap rather than a choice: no `ErrorKey` says "this work cannot be
	 * named to a metadata provider", and spelling a literal key here would put a message
	 * outside the enum both catalogues are written from. The detail names the real reason
	 * for whoever reads the log.
	 */
	private _unnameable(detail: string): { key: string; detail: string } {
		return { key: ErrorKey.GENERAL, detail };
	}

	/**
	 * The film or the show above a media, and the seasons passed on the way up.
	 *
	 * A season and an episode each carry their *own* TMDB identifier, which is not the
	 * show's: pushing one as the ask would have the household following a different work
	 * entirely, and it would look like it had worked. So the walk goes up to something a
	 * request source can name, and the coordinate it climbed through is not thrown away —
	 * it is the seasons asked for.
	 */
	private async _anchor(item: MediaItem): Promise<{ root: MediaItem; seasons: number[] }> {
		const seasons = new Set<number>();
		let current = item;

		for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
			if (current.kind === MediaKind.MOVIE || current.kind === MediaKind.SERIES) {
				break;
			}

			if (current.seasonNumber !== null) {
				seasons.add(current.seasonNumber);
			}

			if (current.parentId === null) {
				break;
			}

			const parent = await this._items.findOne({ where: { id: current.parentId } });

			// A child whose parent has gone is left where it is. It cannot be pushed, and
			// the refusal above says so; inventing an ancestor would ask for the wrong work.
			if (parent === null) {
				break;
			}

			current = parent;
		}

		return { root: current, seasons: [...seasons].sort((first, second) => first - second) };
	}

	/**
	 * The verdict on each request, which is the point of the whole screen.
	 *
	 * The catalogue is read once for the page rather than once per request: a household
	 * with forty open asks would otherwise be forty scans of the same table.
	 */
	private async _views(requests: MediaRequest[]): Promise<MediaRequestView[]> {
		if (requests.length === 0) {
			return [];
		}

		const { byTmdb, byTvdb } = await this._index();
		const named = await this._named(requests, byTmdb, byTvdb);
		const matches = new Map<string, MediaItem[]>();
		const seriesIds: string[] = [];

		for (const request of requests) {
			const found = new Map<string, MediaItem>();

			for (const item of [
				...(request.tmdbId === null ? [] : byTmdb.get(request.tmdbId) ?? []),
				...(request.tvdbId === null ? [] : byTvdb.get(request.tvdbId) ?? []),
			]) {
				found.set(item.id, item);
			}

			matches.set(request.id, [...found.values()]);

			for (const item of found.values()) {
				if (item.kind === MediaKind.SERIES) {
					seriesIds.push(item.id);
				}
			}
		}

		// The seasons under every show that matched, in one read. An episode is not asked
		// for by a request source, so nothing below a season is of any interest here.
		const rows =
			seriesIds.length === 0
				? []
				: await this._items.find({
					where: { parentId: In(seriesIds), kind: MediaKind.SEASON },
				});
		const heldSeasons = new Map<string, number[]>();

		for (const row of rows) {
			if (row.parentId === null || row.seasonNumber === null) {
				continue;
			}

			heldSeasons.set(row.parentId, [...(heldSeasons.get(row.parentId) ?? []), row.seasonNumber]);
		}

		return requests.map((request) =>
			this._view(request, matches.get(request.id) ?? [], heldSeasons, named.get(request.id) ?? null),
		);
	}

	private _view(
		request: MediaRequest,
		items: MediaItem[],
		heldSeasons: Map<string, number[]>,
		details: RequestDetails | null,
	): MediaRequestView {
		const holdings: RequestHolding[] = items.map((item) => ({
			itemId: item.id,
			title: item.title,
			serviceId: item.serviceId,
			seasonNumbers: [...(heldSeasons.get(item.id) ?? [])].sort((first, second) => first - second),
		}));

		// A season is held when *any* copy of ours holds it. Reading one server's rows
		// would call a season missing because the Plex row has none of it, while it sits on
		// the Jellyfin next to it.
		const held = new Set(holdings.flatMap((holding) => holding.seasonNumbers));
		const asked = [...new Set(request.seasons.map((season) => season.seasonNumber))];
		const missingSeasons = asked
			.filter((number) => !held.has(number))
			.sort((first, second) => first - second);

		return {
			...request,
			holdings,
			heldAlready: holdings.length > 0,
			// Every season asked for, not merely one: closing a request for seasons two and
			// three because we hold two would close the ask on half of it.
			fulfillable:
				holdings.length > 0
				&& missingSeasons.length === 0
				&& request.state !== MediaRequestState.AVAILABLE,
			missingSeasons,
			/*
			 * A name, from whichever of the three can give one.
			 *
			 * Ours first: a request row carries no title at all, so for anything we hold
			 * the copy on our own shelf is the only name there is — and it is the name the
			 * household already sees everywhere else in this product. Then the source's
			 * lookup, which is the row nobody here holds. A listing left with the request's
			 * own `title` is a column of numbers, held or not.
			 */
			title: request.title ?? holdings[0]?.title ?? details?.title ?? null,
			details,
			suggestion: this._suggestion(request, holdings, missingSeasons, details),
		};
	}

	/**
	 * What a search for this request would ask for — worked out, and not run.
	 *
	 * Nothing to look for when we hold the work and every season asked for. Nothing to
	 * look *with* when nobody can name it: a request source hands over metadata
	 * identifiers, and Seerr's rows carry no title at all, so a request for something no
	 * library of ours holds leaves nothing to spell into a tracker search. The interface
	 * takes it from here — it is the layer that can ask a metadata provider for a name,
	 * and the only one allowed to decide that bytes should move.
	 */
	private _suggestion(
		request: MediaRequest,
		holdings: RequestHolding[],
		missingSeasons: number[],
		details: RequestDetails | null,
	): RequestSuggestion | null {
		if (holdings.length > 0 && missingSeasons.length === 0) {
			return null;
		}

		// Ours first, then the source's. Our own copy's title is the one a tracker search
		// has the best chance with, because it is the spelling a media server already
		// matched — but for the thing nobody holds, which is what a request usually is,
		// the source's name is the only one there is.
		const term = request.title ?? holdings[0]?.title ?? details?.title ?? null;

		if (term === null) {
			return null;
		}

		/*
		 * A show asked for whole has no missing seasons to name.
		 *
		 * `missingSeasons` is the seasons *asked for* that nothing here holds, so it is
		 * empty in two quite different situations: we hold everything asked for — which
		 * returned null above — and nothing was asked for by season at all, which is what a
		 * request for a whole show looks like. In that second case what the source says
		 * the show consists of is the only answer there is, and it is the one a search
		 * needs.
		 */
		return {
			term,
			kind: request.kind,
			seasonNumbers: missingSeasons.length > 0 ? missingSeasons : (details?.seasonNumbers ?? []),
		};
	}

	/**
	 * Ask the source to name what our own catalogue cannot.
	 *
	 * Only for the requests nothing of ours matches, and one call each: a household's
	 * open asks are a handful, and a listing that asked about every one of them would
	 * spend a round trip per row to re-learn titles it already has.
	 *
	 * A source that cannot name one answers null and the row stays unnamed rather than
	 * the listing failing — see `details`.
	 */
	private async _named(
		requests: MediaRequest[],
		byTmdb: Map<string, MediaItem[]>,
		byTvdb: Map<string, MediaItem[]>,
	): Promise<Map<string, RequestDetails | null>> {
		const { source, settings } = await this._configured();
		const named = new Map<string, RequestDetails | null>();

		for (const request of requests) {
			const holds =
				(request.tmdbId !== null && (byTmdb.get(request.tmdbId)?.length ?? 0) > 0)
				|| (request.tvdbId !== null && (byTvdb.get(request.tvdbId)?.length ?? 0) > 0);

			if (holds || request.tmdbId === null) {
				continue;
			}

			try {
				named.set(request.id, await source.details(settings, request.kind, request.tmdbId));
			} catch {
				// `details` promises null rather than a throw, but it is a call over somebody
				// else's HTTP API and a source outside this repository can break that promise.
				// A household losing its entire request screen because one metadata route
				// answered 500 is a worse failure than one row with no name on it.
				named.set(request.id, null);
			}
		}

		return named;
	}

	/**
	 * Every film and show we hold, indexed by the identifiers a request can be matched on.
	 *
	 * The whole set rather than a query per request, and in memory rather than in SQL:
	 * `externalIds` is a `simple-json` column, so there is no portable indexed way to ask
	 * either database for one identifier inside it, and a `LIKE` over the serialised text
	 * matches a TMDB number that happens to appear in some other field. What is scanned is
	 * films and shows — not episodes, which is where the rows actually are.
	 */
	private async _index(): Promise<{
		byTmdb: Map<string, MediaItem[]>;
		byTvdb: Map<string, MediaItem[]>;
	}> {
		const roots = await this._items.find({
			where: { kind: In([MediaKind.MOVIE, MediaKind.SERIES]) },
		});
		const byTmdb = new Map<string, MediaItem[]>();
		const byTvdb = new Map<string, MediaItem[]>();

		for (const item of roots) {
			this._add(byTmdb, item.externalIds?.tmdb, item);
			this._add(byTvdb, item.externalIds?.tvdb, item);
		}

		return { byTmdb, byTvdb };
	}

	private _add(index: Map<string, MediaItem[]>, key: string | undefined, item: MediaItem): void {
		if (key === undefined || key === '') {
			return;
		}

		const held = index.get(key);

		if (held === undefined) {
			index.set(key, [item]);

			return;
		}

		held.push(item);
	}
}
