import type { MediaItem } from '@mcs/shared';
import { MediaKind, ReleasePreferenceDimension, SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useMediaOverride, withoutReleasePreference } from '@/composables/useMediaOverride';

/**
 * The distinction the whole correction feature rests on.
 *
 * The API reads an absent field as "leave it to the service" and an explicit
 * `null` as "cleared", and a form has one empty box for both. Everything below
 * asserts that the two never get collapsed on the way out — in particular that an
 * emptied box does not delete a title, and that an erased year really does travel
 * as `null`.
 */
function item (overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 'm1',
		serviceId: 's1',
		libraryId: 'l1',
		parentId: null,
		kind: MediaKind.EPISODE,
		title: 'Pilot',
		normalizedTitle: 'pilot',
		year: 2001,
		seasonNumber: 1,
		episodeNumber: 2,
		externalIds: { tvdb: '1234' },
		overview: 'An overview.',
		artworkUrl: null,
		file: null,
		quality: null,
		companions: null,
		overrides: null,
		reported: null,
		addedAt: null,
		sync: SyncState.IN_SYNC,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	} as MediaItem;
}

describe('composables/useMediaOverride', () => {
	it('sends nothing at all when nobody changed anything', () => {
		const { payload } = useMediaOverride(ref(item()));

		expect(payload()).toEqual({});
	});

	it('sends only the field that was actually corrected', () => {
		const { draft, payload } = useMediaOverride(ref(item()));

		draft.values.title = 'Pilot, part one';

		expect(payload()).toEqual({ title: 'Pilot, part one' });
	});

	it('does not read an emptied box as a cleared field', () => {
		// This is the one that deletes somebody's title if it goes wrong: emptying a
		// box means "I am not correcting this", and the service keeps deciding it.
		const { draft, payload } = useMediaOverride(ref(item()));

		draft.values.title = '';

		expect(payload()).toEqual({});
		expect('title' in payload()).toBe(false);
	});

	it('sends an explicit null for a field somebody erased', () => {
		const { draft, payload } = useMediaOverride(ref(item()));

		draft.cleared.year = true;
		const body = payload();

		expect('year' in body).toBe(true);
		expect(body.year).toBeNull();
	});

	it('sends numbers as numbers', () => {
		const { draft, payload } = useMediaOverride(ref(item()));

		draft.values.seasonNumber = '3';
		draft.values.episodeNumber = '12';

		expect(payload()).toEqual({ seasonNumber: 3, episodeNumber: 12 });
	});

	it('leaves out a value that is simply what the service already said', () => {
		const { draft, payload } = useMediaOverride(ref(item()));

		draft.values.title = 'Pilot';
		draft.values.year = '2001';

		expect(payload()).toEqual({});
	});

	it('reads what the service said from `reported` once a correction exists', () => {
		const corrected = item({
			title: 'Cosmos',
			overrides: { title: 'Cosmos' },
			reported: {
				libraryId: 'l1',
				title: 'cosmos.1980.s01e01',
				seriesTitle: null,
				year: 2001,
				seasonNumber: 1,
				episodeNumber: 2,
				overview: 'An overview.',
				externalIds: { tvdb: '1234' },
			},
		});
		const { draft, reportedValue, payload } = useMediaOverride(ref(corrected));

		expect(draft.values.title).toBe('Cosmos');
		expect(reportedValue('title')).toBe('cosmos.1980.s01e01');
		// Re-saving an untouched dialog keeps the correction rather than dropping it.
		expect(payload()).toEqual({ title: 'Cosmos' });
	});

	it('shows a field that was cleared as cleared, not as untouched', () => {
		const corrected = item({
			year: null,
			overrides: { year: null },
			reported: {
				libraryId: 'l1',
				title: 'Pilot',
				seriesTitle: null,
				year: 1999,
				seasonNumber: 1,
				episodeNumber: 2,
				overview: 'An overview.',
				externalIds: {},
			},
		});
		const { draft, payload } = useMediaOverride(ref(corrected));

		expect(draft.cleared.year).toBe(true);
		expect(draft.values.year).toBe('');
		expect(payload().year).toBeNull();
	});

	it('sends an identifier only when it differs from the one reported', () => {
		const { draft, payload } = useMediaOverride(ref(item()));

		expect(draft.externalIds.tvdb).toBe('1234');
		expect(payload().externalIds).toBeUndefined();

		draft.externalIds.imdb = 'tt0903747';

		expect(payload().externalIds).toEqual({ imdb: 'tt0903747' });
	});

	it('reclassifies only when another library was chosen', () => {
		const { draft, payload, libraryChanged } = useMediaOverride(ref(item()));

		expect(libraryChanged.value).toBe(false);
		expect(payload().libraryId).toBeUndefined();

		draft.libraryId = 'l2';

		expect(libraryChanged.value).toBe(true);
		expect(payload().libraryId).toBe('l2');
	});

	it('counts what changed, which is what the dialog puts next to its button', () => {
		const { draft, correctedFields } = useMediaOverride(ref(item()));

		draft.values.title = 'Something else';
		draft.cleared.year = true;

		expect(correctedFields.value).toEqual(['title', 'year']);
	});

	it('fills the form from what the service reports, and leaves nothing to send', () => {
		// The reset button, from the inside. What comes out has to be an *empty* body:
		// a body repeating the reported values would be stored as a correction, and the
		// item would never again take a value the service fixes.
		const corrected = item({
			title: 'Cosmos',
			year: 1999,
			overrides: { title: 'Cosmos', year: 1999 },
			reported: {
				libraryId: 'l1',
				title: 'cosmos.1980.1080p',
				seriesTitle: null,
				year: 1980,
				seasonNumber: 1,
				episodeNumber: 2,
				overview: 'An overview.',
				externalIds: { tvdb: '1234' },
			},
		});
		const { draft, fillFromReported, payload, correctedFields } = useMediaOverride(ref(corrected));

		expect(correctedFields.value).toEqual(['title', 'year']);

		fillFromReported();

		expect(draft.values.title).toBe('cosmos.1980.1080p');
		expect(draft.values.year).toBe('1980');
		expect(draft.cleared.year).toBe(false);
		expect(correctedFields.value).toEqual([]);
		expect(payload()).toEqual({});
	});

	it('un-erases a field the reset put back, rather than leaving it cleared', () => {
		const corrected = item({
			year: null,
			overrides: { year: null },
			reported: {
				libraryId: 'l1',
				title: 'Pilot',
				seriesTitle: null,
				year: 2001,
				seasonNumber: 1,
				episodeNumber: 2,
				overview: 'An overview.',
				externalIds: { tvdb: '1234' },
			},
		});
		const { draft, fillFromReported, payload } = useMediaOverride(ref(corrected));

		expect(draft.cleared.year).toBe(true);

		fillFromReported();

		expect(draft.cleared.year).toBe(false);
		expect(draft.values.year).toBe('2001');
		expect(payload()).toEqual({});
	});

	/**
	 * The two fields with nothing of the service's to compare against.
	 *
	 * A `PUT` replaces the whole instruction rather than patching it, so a field this
	 * form does not send is a field it withdraws. `ignored` and the search order have no
	 * reported counterpart — no media server has an opinion about whether an episode
	 * counts or about which copy the house prefers — so "unchanged" means "still in
	 * force", and leaving them out is how correcting a title silently un-ignores a
	 * special or cancels an order set from another screen.
	 */
	describe('the fields the service has no answer for', () => {
		const ordered = () => item({
			overrides: {
				releasePreference: {
					ranks: [{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p', '2160p'] }],
				},
			},
		});

		it('says nothing about an order on a media that has none', () => {
			const { payload } = useMediaOverride(ref(item()));

			expect('releasePreference' in payload()).toBe(false);
		});

		it('re-sends the order in force when the correction was about something else', () => {
			const { draft, payload } = useMediaOverride(ref(ordered()));

			draft.values.title = 'Pilot, part one';

			expect(payload()).toEqual({
				title: 'Pilot, part one',
				releasePreference: {
					ranks: [{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p', '2160p'] }],
				},
			});
		});

		it('sends an explicit null when the order is dropped in the form', () => {
			const { draft, payload, preferenceChanged } = useMediaOverride(ref(ordered()));

			expect(preferenceChanged.value).toBe(false);

			draft.releasePreference = null;

			expect(preferenceChanged.value).toBe(true);
			expect(payload()).toEqual({ releasePreference: null });
		});

		it('keeps an order that separates nothing, because that is a decision too', () => {
			// Empty is not absent: "order by nothing, on purpose" is how one series opts
			// out of a household order that is wrong for it, and collapsing the two would
			// make it unsayable.
			const { draft, payload } = useMediaOverride(ref(item()));

			draft.releasePreference = { ranks: [] };

			expect(payload()).toEqual({ releasePreference: { ranks: [] } });
		});

		it('edits a copy, so the form does not change what the page still shows', () => {
			// The note above the media reads the item's own order. A draft sharing that
			// object would rewrite the note as somebody reordered the boxes, before
			// anything was saved and including if they cancelled.
			const source = ordered();
			const { draft, releasePreference } = useMediaOverride(ref(source));

			draft.releasePreference!.ranks[0].values.push('720p');

			expect(releasePreference.value?.ranks[0].values).toEqual(['1080p', '2160p']);
		});

		it('carries an ignored item’s flag through a correction of its title', () => {
			const { draft, payload } = useMediaOverride(ref(item({ overrides: { ignored: true } })));

			draft.values.title = 'Convention panel';

			expect(payload()).toEqual({ title: 'Convention panel', ignored: true });
		});

		it('cancels both when everything goes back to what the service reported', () => {
			// No media server has either opinion, so their baseline is "none" — and the
			// button that undoes everything must not be the one that quietly keeps a
			// setting the boxes no longer show. The order travels as an explicit null
			// rather than by omission, which is the instruction the API reads as "cancel
			// this level" and what leaves the item with no correction at all.
			const { fillFromReported, payload } = useMediaOverride(ref(ordered()));

			fillFromReported();

			expect(payload()).toEqual({ releasePreference: null });
		});
	});

	/**
	 * Cancelling from the media page, where there is no form to read the rest from.
	 *
	 * The press sends the whole instruction with the order nulled. Sending only the null
	 * would withdraw the title, the year and the reclassification along with it — one
	 * press undoing four corrections nobody mentioned.
	 */
	it('cancels an order without withdrawing the corrections beside it', () => {
		expect(withoutReleasePreference({
			title: 'Cosmos',
			releasePreference: { ranks: [] },
		})).toEqual({ title: 'Cosmos', releasePreference: null });

		expect(withoutReleasePreference(null)).toEqual({ releasePreference: null });
	});
});
