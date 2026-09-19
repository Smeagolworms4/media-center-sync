import type { MediaItem } from '@mcs/shared';
import { MediaKind, SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useMediaOverride } from '@/composables/useMediaOverride';

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
});
