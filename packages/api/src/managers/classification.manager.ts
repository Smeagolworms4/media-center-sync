import {
	ClassificationBlocker,
	DetectedCategory,
	ErrorKey,
	type CategoryProposal,
	type ClassificationCandidate,
	type ClassificationProposal,
	type MediaCategory,
} from '@mcs/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { MediaItem as MediaItemEntity } from '@/entities';
import { MediaItemRepository } from '@/repositories';
import {
	basename,
	classify,
	fold,
	SettingsService,
	stripExtension,
	type ClassificationFacts,
	type PlacementLibrary,
} from '@/services';
import { LibraryManager } from './library.manager';

/**
 * Names that read as each of the four shelves, folded.
 *
 * This is how a *detected* category becomes a shelf that exists here, and it has to be
 * done by name because a category has no row of its own: it is derived from the library
 * names the services report, so there is nowhere to record that `Animés` is the anime
 * shelf. The alternative — a settings table mapping the four onto category keys — was
 * rejected for the reason `CategoryKeyword` gives about anchoring on a key: a category key
 * changes the day somebody renames the library it was named after, and a stored mapping
 * would be orphaned by exactly that rename.
 *
 * The lists are short and literal on purpose. A household whose anime shelf is called
 * `Japon` gets no proposal rather than a wrong one, and the `NO_SUCH_CATEGORY` blocker is
 * what tells them why — which is a sentence they can act on, unlike a near-match that
 * filed their films somewhere.
 *
 * Longer phrases win over shorter ones wherever a name matches two of these, which is the
 * one rule that makes the lists safe to extend: `Animés - Films` contains both `animes`
 * and `animes films`, and without the length rule the household's animated-films shelf
 * would answer for anime as well. Equal lengths across two categories fall back to the
 * order the keys are written here, and there are deliberately no such pairs.
 */
const CATEGORY_PHRASES: Record<DetectedCategory, readonly string[]> = {
	[DetectedCategory.ANIMATED_FILMS]: [
		'films d animation',
		'film d animation',
		'animated films',
		'animated film',
		'animation films',
		'films animation',
		'films animes',
		'animes films',
		'anime films',
		'animes film',
		'dessins animes films',
	],
	[DetectedCategory.ANIME]: ['anime', 'animes', 'japanimation', 'japanim', 'animation japonaise'],
	[DetectedCategory.CARTOONS]: [
		'cartoon',
		'cartoons',
		'dessin anime',
		'dessins animes',
		'animation',
		'animations',
	],
	[DetectedCategory.CONCERTS]: [
		'concert',
		'concerts',
		'konzert',
		'konzerte',
		'spectacle',
		'spectacles',
		'live',
	],
};

/** Which of the four a category's name reads as, and how strongly. */
interface ShelfMatch {
	category: DetectedCategory;
	length: number;
}

const shelfMatch = (name: string): ShelfMatch | null => {
	const folded = fold(name);
	let best: ShelfMatch | null = null;

	for (const [category, phrases] of Object.entries(CATEGORY_PHRASES)) {
		for (const phrase of phrases) {
			if (!` ${folded} `.includes(` ${phrase} `)) {
				continue;
			}

			if (best === null || phrase.length > best.length) {
				best = { category: category as DetectedCategory, length: phrase.length };
			}
		}
	}

	return best;
};

/**
 * Proposing where a media might belong, and never putting it there.
 *
 * The whole manager is one read. It resolves a media to candidate categories, maps each
 * onto a library that actually exists here, and answers. It holds no repository write, no
 * event, no job and no scheduler entry, and the test file asserts that — because the
 * guarantee the household was promised is not "the detector is accurate", it is "nothing
 * moves unless somebody says so".
 *
 * Agreeing is a separate, existing write: `PUT /media/:id/override` with the `libraryId`
 * this answer names. Deliberately not a second mechanism. A dedicated "apply the
 * suggestion" route would be a way to re-file that behaves differently from re-filing by
 * hand — different rescan behaviour, different audit, and two places to look when
 * something ends up on the wrong shelf.
 */
@Injectable()
export class ClassificationManager {
	public constructor(
		private readonly _items: MediaItemRepository,
		/**
		 * Asked which shelves exist and which of them a file can land on.
		 *
		 * A manager reaching for another manager, for the reason `SettingsManager` does:
		 * a category is a merge of library names, and a second reading of that merge here
		 * would name a different shelf than the rest of the gateway does the moment
		 * somebody aliases a library.
		 */
		private readonly _libraries: LibraryManager,
		/**
		 * Read only to prefer the library the household already chose for this shelf.
		 *
		 * `categoryTargets` is where a *new pull* of that category lands, and naming a
		 * different library here would mean a re-file and a pull disagreeing about which
		 * of two `Animes` disks is the one — with the files ending up split across both.
		 */
		private readonly _settings: SettingsService,
	) {}

	/**
	 * What the gateway would suggest for one media, with the evidence for each suggestion.
	 *
	 * Ordered proposals first, then the categories it considered and withheld. Both halves
	 * are answered even when there is nothing to propose: a route that returns an empty
	 * object when it declined to guess is indistinguishable from one that is broken, and
	 * "it succeeded and did nothing visible" is the defect class this project keeps
	 * paying for.
	 */
	public async propose(itemId: string): Promise<ClassificationProposal> {
		const item = await this._items.findOneBy({ id: itemId });

		if (item === null) {
			throw new NotFoundException(ErrorKey.MEDIA_NOT_FOUND);
		}

		const [categories, libraries, settings] = await Promise.all([
			this._libraries.categories(),
			this._libraries.placementLibraries(),
			this._settings.get(),
		]);
		const current = categories.find((category) => category.libraryIds.includes(item.libraryId));
		const candidates = classify(factsOf(item));
		const proposals: CategoryProposal[] = [];
		const withheld: ClassificationCandidate[] = [];

		for (const candidate of candidates) {
			if (candidate.withheld !== null) {
				withheld.push(candidate);

				continue;
			}

			proposals.push(
				this._resolve(candidate, categories, libraries, settings.categoryTargets, current),
			);
		}

		return {
			itemId: item.id,
			title: item.title,
			currentLibraryId: item.libraryId,
			currentCategoryKey: current?.key ?? null,
			currentCategoryName: current?.name ?? null,
			// Actionable first. A blocked proposal is worth reading and is not worth being
			// the first thing on the screen.
			proposals: proposals.sort(
				(left, right) =>
					Number(left.blocker !== null) - Number(right.blocker !== null)
					|| right.confidence - left.confidence,
			),
			withheld,
			requiresConfirmation: true,
		};
	}

	/**
	 * One candidate, against the shelves this gateway has.
	 *
	 * Every failure to find one is reported rather than dropped, and `libraryId` stays null
	 * in each case — which is the invariant that stops an unactionable proposal being
	 * turned into an override request that would reclassify a row into a library nothing
	 * can write to.
	 */
	private _resolve(
		candidate: ClassificationCandidate,
		categories: readonly MediaCategory[],
		libraries: readonly PlacementLibrary[],
		targets: Record<string, string>,
		current: MediaCategory | undefined,
	): CategoryProposal {
		const base = {
			category: candidate.category,
			confidence: candidate.confidence,
			evidence: candidate.evidence,
			libraryId: null,
			libraryName: null,
		};
		// Already in position order, so the first match is the shelf whose band comes first
		// — the same answer the library screen would give for "which of these two is the
		// Animes shelf".
		const matching = categories.filter(
			(category) => shelfMatch(category.name)?.category === candidate.category,
		);
		const shelf = matching[0];

		if (shelf === undefined) {
			return {
				...base,
				categoryKey: null,
				categoryName: null,
				blocker: ClassificationBlocker.NO_SUCH_CATEGORY,
			};
		}

		const named = { ...base, categoryKey: shelf.key, categoryName: shelf.name };

		if (current !== undefined && matching.some((category) => category.key === current.key)) {
			// It is already where this would put it. Said rather than hidden: somebody who
			// opened the dialog expecting a suggestion has been answered.
			return { ...named, blocker: ClassificationBlocker.ALREADY_FILED };
		}

		const library = this._pick(matching, libraries, targets);

		if (library === undefined) {
			return { ...named, blocker: ClassificationBlocker.NO_WRITABLE_LIBRARY };
		}

		return {
			...named,
			// The shelf reported is the one the chosen library sits on, not the first
			// match: with two anime libraries and only the second one writable, naming the
			// first would put a category key in the question that the button does not act
			// on.
			categoryKey: library.categoryKey ?? shelf.key,
			categoryName:
				categories.find((category) => category.key === library.categoryKey)?.name ?? shelf.name,
			libraryId: library.id,
			libraryName: library.name,
			blocker: null,
		};
	}

	/**
	 * Which library of a shelf a re-file should name.
	 *
	 * Three answers in order, and the order is the same one placement already uses so that
	 * a suggestion and a pull cannot send the same series to two different disks: the
	 * library the household named for this category, then one marked as a default target,
	 * then whichever is left. The last is sorted by name rather than taken as it comes,
	 * because an unordered answer means the same media is suggested a different library on
	 * a second look — and a suggestion that changes on refresh is one nobody trusts.
	 */
	private _pick(
		matching: readonly MediaCategory[],
		libraries: readonly PlacementLibrary[],
		targets: Record<string, string>,
	): PlacementLibrary | undefined {
		const ids = new Set(matching.flatMap((category) => category.libraryIds));
		const writable = libraries
			.filter((library) => ids.has(library.id) && library.writable)
			.sort((left, right) => left.name.localeCompare(right.name));
		const chosen = matching
			.map((category) => targets[category.key])
			.find((id) => writable.some((library) => library.id === id));

		return (
			writable.find((library) => library.id === chosen)
			?? writable.find((library) => library.isDefaultTarget)
			?? writable[0]
		);
	}
}

/**
 * What the detector is given about a catalogue row.
 *
 * The honest shape of what the index actually holds, and two of the fields are empty for a
 * reason worth stating where somebody will wonder: **the index carries no genres and no
 * studios.** `NormalisedMediaItem` does not collect them, the `media_items` table has no
 * column for them, and the strongest signal the detector knows how to read is therefore
 * unavailable from here. Adding them means the handler interface, the entity, a migration
 * and the mappers — a change well outside this feature — and until it happens the detector
 * leans on the release name and the path, which is why those two are read carefully and
 * why the abstention rules matter as much as they do.
 *
 * The release name is the file's own basename. A file is named after the release it came
 * from far more often than not, and it is the one place a fansub group survives into the
 * catalogue — which is what keeps this route from abstaining on every anime in the house.
 */
const factsOf = (item: MediaItemEntity): ClassificationFacts => {
	const path = item.file?.path ?? null;

	return {
		kind: item.kind,
		title: item.title,
		originalTitle: null,
		year: item.year,
		genres: [],
		studios: [],
		originalLanguage: null,
		countries: [],
		path,
		releaseName: path === null ? null : stripExtension(basename(path)),
	};
};
