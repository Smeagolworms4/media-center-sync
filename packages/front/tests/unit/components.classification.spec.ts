import type { CategoryProposal, ClassificationProposal, Library, MediaItem, MediaService } from '@mcs/shared';
import {
	ClassificationBlocker,
	ClassificationSignal,
	ClassificationSource,
	ClassificationWithheld,
	DetectedCategory,
	LibraryKind,
	MediaKind,
	MediaServiceMode,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import CategoryProposalBlock from '@/components/media/CategoryProposal.vue';
import OverrideDialog from '@/components/media/OverrideDialog.vue';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/**
 * A pre-filing the gateway proposes, and never one it performs.
 *
 * Two things are asserted here and they are the whole safety of the feature. The
 * evidence is on the screen rather than behind a fold, because a suggestion nobody can
 * check is one people learn to accept without reading — and at that point the filing is
 * automatic again, by a route nobody chose. And agreeing performs exactly the override
 * the dialog already owns, so a media that moved moved for a reason that is on the record
 * in one place.
 */
async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

const library: Library = {
	id: 'l1',
	serviceId: 's1',
	externalId: 'x',
	name: 'Films',
	alias: null,
	position: 0,
	kind: LibraryKind.MOVIES,
	paths: ['/data/films'],
	localPath: '/media/films',
	writable: true,
	isDefaultTarget: true,
	itemCount: 10,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const animes: Library = {
	...library,
	id: 'l2',
	name: 'Animes',
	localPath: '/media/animes',
	isDefaultTarget: false,
};

const service: MediaService = {
	id: 's1',
	name: 'Living room',
	type: MediaServiceType.JELLYFIN,
	mode: MediaServiceMode.LOCAL,
	shared: true,
	filesMounted: true,
	baseUrl: 'http://jellyfin:8096',
	status: MediaServiceStatus.ONLINE,
	version: '10.9',
	authProvider: false,
	priority: 5,
	peerId: null,
	lastProbeAt: null,
	lastScanAt: null,
	libraryCount: 2,
	itemCount: 10,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
} as MediaService;

function item (overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 'm1',
		serviceId: 's1',
		libraryId: 'l1',
		parentId: null,
		kind: MediaKind.SERIES,
		title: 'Frieren',
		normalizedTitle: 'frieren',
		year: 2023,
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
		addedAt: null,
		sync: SyncState.IN_SYNC,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	} as MediaItem;
}

function candidate (overrides: Partial<CategoryProposal> = {}): CategoryProposal {
	return {
		category: DetectedCategory.ANIME,
		confidence: 0.92,
		evidence: [
			{
				signal: ClassificationSignal.ANIME_GENRE,
				source: ClassificationSource.GENRE,
				value: 'Shounen',
				weight: 0.6,
			},
			{
				signal: ClassificationSignal.ANIMATION_PATH_KEYWORD,
				source: ClassificationSource.PATH,
				value: 'Animes',
				weight: 0.1,
			},
			{
				signal: ClassificationSignal.DOCUMENTARY_GENRE,
				source: ClassificationSource.GENRE,
				value: 'Documentary',
				weight: -0.3,
			},
		],
		categoryKey: 'animes',
		categoryName: 'Animes',
		libraryId: 'l2',
		libraryName: 'Animes',
		blocker: null,
		...overrides,
	};
}

function proposal (overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
	return {
		itemId: 'm1',
		title: 'Frieren',
		currentLibraryId: 'l1',
		currentCategoryKey: 'films',
		currentCategoryName: 'Films',
		proposals: [candidate()],
		withheld: [],
		requiresConfirmation: true,
		...overrides,
	};
}

describe('components/media/CategoryProposal', () => {
	function mountBlock (value: ClassificationProposal | null, extra: Record<string, unknown> = {}) {
		return mountWithApp(CategoryProposalBlock, {
			props: { proposal: value, ...extra },
			global: { stubs: { ...tooltipStub } },
		});
	}

	/**
	 * The one assertion this feature cannot do without.
	 *
	 * Evidence behind a disclosure triangle is evidence people stop opening, and a
	 * suggestion accepted unread is an automatic move by another name — which is the one
	 * thing the household ruled out. So every signal is in the document from the start,
	 * with nothing pressed.
	 */
	it('shows every signal without anything being opened first', async () => {
		const { wrapper } = mountBlock(proposal());
		await nextTick();

		expect(wrapper.find('[data-test="category-proposal-signal-anime-anime_genre"]').exists())
			.toBe(true);
		expect(wrapper
			.find('[data-test="category-proposal-signal-anime-animation_path_keyword"]').exists())
			.toBe(true);
		// Counter-evidence too, and marked as such: a reason not to agree read as a reason
		// to agree is what files a documentary about anime as an anime.
		expect(wrapper.find('[data-test="category-proposal-signal-anime-documentary_genre"]')
			.classes()).toContain('category-proposal_against');
	});

	it('puts the question as a move from the shelf it is on', async () => {
		const { wrapper } = mountBlock(proposal());
		await nextTick();

		expect(wrapper.find('[data-test="category-proposal-item-anime"]').text())
			.toContain('Films → Animes');
		expect(wrapper.find('[data-test="category-proposal-confidence-anime"]').text())
			.toContain('92');
	});

	it('emits the candidate it was asked to agree with, and writes nothing itself', async () => {
		const { wrapper } = mountBlock(proposal());
		await nextTick();

		await wrapper.find('[data-test="category-proposal-accept-anime"]').trigger('click');

		expect(wrapper.emitted('accept')).toHaveLength(1);
		expect((wrapper.emitted('accept')?.[0][0] as CategoryProposal).libraryId).toBe('l2');
	});

	/**
	 * A suggestion naming a shelf this gateway does not have.
	 *
	 * Still shown, because "this looks like a concert and you have no concerts library" is
	 * the one sentence that tells somebody what to create — and with no button rather than
	 * a disabled one, because `libraryId` is null and there is nothing to write.
	 */
	it('offers no button on a blocked suggestion, and says what is in the way', async () => {
		const { wrapper } = mountBlock(proposal({
			proposals: [candidate({
				category: DetectedCategory.CONCERTS,
				categoryKey: null,
				categoryName: null,
				libraryId: null,
				libraryName: null,
				blocker: ClassificationBlocker.NO_SUCH_CATEGORY,
			})],
		}));
		await nextTick();

		expect(wrapper.find('[data-test="category-proposal-accept-concerts"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="category-proposal-blocker-concerts"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="category-proposal-item-concerts"]').classes())
			.toContain('category-proposal_item--blocked');
	});

	/**
	 * Nothing to suggest is an answer, and it has to be distinguishable from a failure.
	 *
	 * What was considered and dropped is the one thing legitimately behind a disclosure:
	 * it answers "why is there nothing here", which is a question somebody asks rather
	 * than a fact they have to weigh before agreeing to anything.
	 */
	it('says there is nothing to suggest, and explains what was considered', async () => {
		const { wrapper } = mountBlock(proposal({
			proposals: [],
			withheld: [{
				category: DetectedCategory.CARTOONS,
				confidence: 0.4,
				evidence: [{
					signal: ClassificationSignal.ANIMATION_GENRE,
					source: ClassificationSource.GENRE,
					value: 'Animation',
					weight: 0.4,
				}],
				withheld: ClassificationWithheld.AMBIGUOUS_ORIGIN,
			}],
		}));
		await nextTick();

		expect(wrapper.find('[data-test="category-proposal-none"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="category-proposal-withheld"]').exists()).toBe(false);

		await wrapper.find('[data-test="category-proposal-withheld-toggle"]').trigger('click');
		await nextTick();

		expect(wrapper.find('[data-test="category-proposal-withheld-cartoons"]').exists()).toBe(true);
	});

	it('reports its own failure and offers to look again, without taking the form down', async () => {
		const { wrapper } = mountBlock(null, { failed: true });
		await nextTick();

		expect(wrapper.find('[data-test="category-proposal-failed"]').exists()).toBe(true);

		await wrapper.find('[data-test="category-proposal-retry"]').trigger('click');

		expect(wrapper.emitted('retry')).toHaveLength(1);
	});
});

/**
 * Agreeing, which is the override the dialog already owns and nothing else.
 *
 * There is no apply route and no job: the classification route is a GET, and the only
 * write anywhere near this feature is the one a person re-filing by hand uses. That is
 * what keeps a media that moved having moved for a reason that is on the record in one
 * place.
 */
describe('components/media/OverrideDialog and the category suggestion', () => {
	function mountDialog (node: MediaItem = item(), answer = proposal()) {
		const stub = stubFetchRoutes({
			'/api/classification/media/m1': { body: answer },
			'/api/media/m1/override': { body: { ...node, libraryId: 'l2' } },
			'/api/media/m1': { body: node },
			'/api/libraries': { body: [library, animes] },
			'/api/services': { body: [service] },
		});
		const mounted = mountWithApp(OverrideDialog, {
			props: { modelValue: true, itemId: 'm1' },
			global: { stubs: { ...tooltipStub, ...dialogStub } },
		});

		return { ...mounted, stub };
	}

	it('reads the suggestion once when it opens, and never posts to that route', async () => {
		const { wrapper, stub } = mountDialog();
		await settle();

		const reads = stub.mock.calls
			.filter(call => String(call[0]).includes('/api/classification/media/m1'));

		expect(reads).toHaveLength(1);
		expect(reads.every(call => (call[1]?.method ?? 'GET').toUpperCase() === 'GET')).toBe(true);
		expect(wrapper.find('[data-test="category-proposal-item-anime"]').exists()).toBe(true);
	});

	it('performs the override the suggestion names, and nothing else', async () => {
		const { wrapper, stub } = mountDialog();
		await settle();

		await wrapper.find('[data-test="category-proposal-accept-anime"]').trigger('click');
		await settle();

		const writes = stub.mock.calls
			.filter(call => String(call[1]?.method ?? 'GET').toUpperCase() !== 'GET');

		expect(writes).toHaveLength(1);
		expect(writes[0][0]).toBe('/api/media/m1/override');
		expect(JSON.parse(String(writes[0][1].body))).toEqual({ libraryId: 'l2' });
	});

	/**
	 * The reason agreeing goes through the form rather than posting `{ libraryId }`.
	 *
	 * A `PUT` replaces the whole instruction rather than patching it, so the short version
	 * of this would have withdrawn the corrected title on its way to moving the shelf —
	 * silently, and only for the people who had corrected something first.
	 */
	it('carries the corrections already in force along with the move', async () => {
		const { wrapper, stub } = mountDialog(item({
			title: 'Frieren: Beyond Journey’s End',
			overrides: { title: 'Frieren: Beyond Journey’s End' },
			reported: {
				libraryId: 'l1',
				title: 'frieren.2023.1080p',
				seriesTitle: null,
				year: 2023,
				seasonNumber: null,
				episodeNumber: null,
				overview: null,
				externalIds: {},
			},
		}));
		await settle();

		await wrapper.find('[data-test="category-proposal-accept-anime"]').trigger('click');
		await settle();

		const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');

		expect(JSON.parse(String(put?.[1].body))).toEqual({
			libraryId: 'l2',
			title: 'Frieren: Beyond Journey’s End',
		});
	});
});
