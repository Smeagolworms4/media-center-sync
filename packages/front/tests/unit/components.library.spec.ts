import type { LibraryHint, MediaGroup, MediaGroupSource, Peer } from '@mcs/shared';
import {
	LibraryHintKind,
	LibraryKind,
	LibraryLayoutSignal,
	MediaKind,
	MediaServiceType,
	PeerStatus,
	PeerTrust,
	SyncState,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import LibraryHints from '@/components/library/LibraryHints.vue';
import CompanionMarks from '@/components/media/CompanionMarks.vue';
import LibrarySection from '@/components/media/LibrarySection.vue';
import MediaBreadcrumb from '@/components/media/MediaBreadcrumb.vue';
import MediaCard from '@/components/media/MediaCard.vue';
import MediaPoster from '@/components/media/MediaPoster.vue';
import SourceMarks from '@/components/media/SourceMarks.vue';
import SyncStateBadge from '@/components/media/SyncStateBadge.vue';
import { usePeersStore } from '@/stores/peers';
import { mountWithApp, tooltipStub } from './helpers';

function peer (overrides: Partial<Peer> = {}): Peer {
	return {
		id: 'p1',
		name: 'Bob',
		nodeId: null,
		protocol: 1,
		capabilities: [],
		fingerprint: 'AB',
		status: PeerStatus.LINKED,
		direction: null,
		trust: PeerTrust.FRIEND,
		depth: 1,
		maxDepth: null,
		readingForbidden: false,
		discovered: false,
		linkMode: null,
		address: null,
		viaPeerId: null,
		viaPeerName: null,
		serviceCount: 1,
		sharedItemCount: 0,
		lastSeenAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function source (overrides: Partial<MediaGroupSource> = {}): MediaGroupSource {
	return {
		itemId: 'i1',
		serviceId: 's1',
		serviceName: 'Living room',
		serviceType: MediaServiceType.JELLYFIN,
		peerId: null,
		peerName: null,
		quality: null,
		companions: null,
		bytes: 1024,
		versionId: null,
		edition: null,
		local: true,
		sync: SyncState.IN_SYNC,
		...overrides,
	};
}

function group (overrides: Partial<MediaGroup> = {}): MediaGroup {
	return {
		id: 'g1',
		kind: MediaKind.SERIES,
		title: 'The Expanse',
		normalizedTitle: 'expanse',
		year: 2015,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: null,
		artworkItemId: 'a1',
		sync: SyncState.IN_SYNC,
		quality: null,
		sources: [source()],
		versions: [],
		childCount: 6,
		missingCount: 0,
		libraryId: 'l1',
		parentId: null,
		addedAt: null,
		...overrides,
	};
}

describe('components/media/MediaPoster', () => {
	/**
	 * The placeholder is not the edge case on a self-hosted library: most of it has
	 * no artwork at all, so this is what the wall is mostly made of.
	 */
	it('draws initials rather than a broken image when there is no artwork', () => {
		const { wrapper } = mountWithApp(MediaPoster, { props: { title: 'The Expanse' } });

		expect(wrapper.find('img').exists()).toBe(false);
		expect(wrapper.find('[data-test="media-poster-placeholder"]').text()).toBe('EX');
	});

	it('shows the artwork when there is one, lazily', () => {
		const { wrapper } = mountWithApp(MediaPoster, {
			props: { title: 'The Expanse', src: '/api/media/a1/artwork?token=t' },
		});

		const image = wrapper.find('img');
		expect(image.attributes('src')).toBe('/api/media/a1/artwork?token=t');
		expect(image.attributes('loading')).toBe('lazy');
	});

	/** A poster the gateway answers 404 for must not leave a broken-image icon. */
	it('falls back to the placeholder when the artwork does not load', async () => {
		const { wrapper } = mountWithApp(MediaPoster, {
			props: { title: 'Arrival', src: '/api/media/a1/artwork' },
		});

		await wrapper.find('img').trigger('error');

		expect(wrapper.find('img').exists()).toBe(false);
		expect(wrapper.find('[data-test="media-poster-placeholder"]').text()).toBe('AR');
	});
});

describe('components/media/SyncStateBadge', () => {
	it.each(Object.values(SyncState))('renders the vocabulary for %s', state => {
		const { wrapper } = mountWithApp(SyncStateBadge, {
			props: { state },
			global: { stubs: tooltipStub },
		});

		const badge = wrapper.find('[data-test="sync-state"]');
		expect(badge.exists()).toBe(true);
		expect(badge.attributes('data-state')).toBe(state);
		expect(badge.find('.v-icon').exists()).toBe(true);
	});

	it('falls back to "unknown" for a state this build has never heard of', () => {
		const { wrapper } = mountWithApp(SyncStateBadge, {
			props: { state: 'invented' as never },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="sync-state"]').attributes('data-state'))
			.toBe(SyncState.UNKNOWN);
	});

	/**
	 * The states a wall is scanned for cannot depend on telling two hues apart.
	 *
	 * The two landed ones are labelled for a second reason: they sit exactly where a
	 * `missing` badge sat a moment earlier, and an unlabelled icon there reads as
	 * "still missing, different colour" — the misreading the state exists to prevent.
	 */
	it.each([
		SyncState.MISSING,
		SyncState.OUTDATED,
		SyncState.AWAITING_INDEX,
		SyncState.NOT_INDEXED,
	])('spells %s out in words too', state => {
		const { wrapper } = mountWithApp(SyncStateBadge, {
			props: { state },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('.sync-state-badge_label').exists()).toBe(true);
	});

	it('says in words that a downloaded file is waiting to be indexed', () => {
		const { wrapper } = mountWithApp(SyncStateBadge, {
			props: { state: SyncState.AWAITING_INDEX },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('.sync-state-badge_label').text()).toBe('Downloaded — resyncing');
		// And the tooltip says why it cannot be played yet, which the badge cannot.
		expect(wrapper.text()).toContain('has not indexed it yet');
	});

	it('leaves a library that is in sync unlabelled, so the odd one stands out', () => {
		const { wrapper } = mountWithApp(SyncStateBadge, {
			props: { state: SyncState.IN_SYNC },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('.sync-state-badge_label').exists()).toBe(false);
	});
});

describe('components/media/SourceMarks', () => {
	it('marks a media one of our own services holds', () => {
		const { wrapper } = mountWithApp(SourceMarks, {
			props: { sources: [source({ local: true })] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="source-mark-local"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="source-mark-remote"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="source-marks"]').attributes('data-local')).toBe('true');
	});

	/** A media only a friend has must not look like one we hold. */
	it('marks a media only somebody else holds', () => {
		const { wrapper } = mountWithApp(SourceMarks, {
			props: { sources: [source({ local: false, serviceName: 'Bob’s Plex' })] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="source-mark-local"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="source-mark-remote"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="source-marks"]').attributes('data-local')).toBe('false');
	});

	it('counts the servers when several hold it, ours included', () => {
		const { wrapper } = mountWithApp(SourceMarks, {
			props: {
				sources: [
					source({ itemId: 'i1', local: true }),
					source({ itemId: 'i2', serviceId: 's2', local: false }),
					source({ itemId: 'i3', serviceId: 's3', local: false }),
				],
			},
			global: { stubs: tooltipStub },
		});

		const marks = wrapper.find('[data-test="source-marks"]');
		expect(marks.attributes('data-count')).toBe('3');
		expect(marks.attributes('data-remote')).toBe('2');
		expect(wrapper.find('[data-test="source-mark-remote"]').text()).toContain('2');
	});

	it('says so rather than showing nothing when no source is known', () => {
		const { wrapper } = mountWithApp(SourceMarks, {
			props: { sources: [] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="source-mark-none"]').exists()).toBe(true);
	});

	/**
	 * The distinction the whole origin vocabulary exists for: a friend is somebody
	 * this house linked to, and a friend of a friend is somebody it never agreed to.
	 * One hollow pill for both makes that invisible at exactly the size it matters.
	 */
	it('tells a friend of a friend apart from a friend, on the tile', async () => {
		const { wrapper, pinia } = mountWithApp(SourceMarks, {
			props: {
				sources: [
					source({ itemId: 'i1', serviceId: 's1', local: false, peerId: 'p1' }),
					source({ itemId: 'i2', serviceId: 's2', local: false, peerId: 'p2' }),
					source({ itemId: 'i3', serviceId: 's3', local: false, peerId: null }),
				],
			},
			global: { stubs: tooltipStub },
		});

		usePeersStore(pinia).peers = [
			peer({ id: 'p1', trust: PeerTrust.FRIEND }),
			peer({ id: 'p2', name: 'Carol', trust: PeerTrust.FRIEND_OF_FRIEND }),
		];
		await nextTick();

		const origins = wrapper.findAll('[data-test="source-mark-remote"]')
			.map(one => one.attributes('data-origin'));
		expect(origins).toEqual(['direct', 'friend', 'friend_of_friend']);
		expect(wrapper.find('[data-test="source-marks"]').attributes('data-origins'))
			.toBe('direct friend friend_of_friend');
	});

	/** A peer this browser has not loaded is not a friend, and must not claim to be. */
	it('refuses to guess how close an unknown peer is', () => {
		const { wrapper } = mountWithApp(SourceMarks, {
			props: { sources: [source({ local: false, peerId: 'p9' })] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="source-mark-remote"]').attributes('data-origin'))
			.toBe('unknown');
	});
});

describe('components/media/MediaBreadcrumb', () => {
	it('links every step but the one somebody is on', () => {
		const { wrapper } = mountWithApp(MediaBreadcrumb, {
			props: {
				steps: [
					{ key: 'root', label: 'Library', to: { name: 'library' } },
					{ key: 'c', label: 'Animes', to: { name: 'library', query: { category: 'animes' } } },
					{ key: 'm1', label: 'Season 1', to: null },
				],
			},
		});

		expect(wrapper.findAll('[data-test="media-breadcrumb-step"]')).toHaveLength(2);
		expect(wrapper.find('[data-test="media-breadcrumb-current"]').text()).toBe('Season 1');
	});

	/** A trail of one step is where you already are, and says nothing worth a line. */
	it('stays out of the way when there is nowhere to go back to', () => {
		const { wrapper } = mountWithApp(MediaBreadcrumb, {
			props: { steps: [{ key: 'root', label: 'Library', to: { name: 'library' } }] },
		});

		expect(wrapper.find('[data-test="media-breadcrumb"]').exists()).toBe(false);
	});
});

describe('components/media/MediaCard', () => {
	it('carries the state, the sources and the artwork on one tile', () => {
		const { wrapper } = mountWithApp(MediaCard, {
			props: {
				group: group({ sync: SyncState.MISSING, year: 2015 }),
				artwork: '/api/media/a1/artwork?token=t',
			},
			global: { stubs: tooltipStub },
		});

		const card = wrapper.find('[data-test="media-card"]');
		expect(card.attributes('data-state')).toBe(SyncState.MISSING);
		expect(card.classes()).toContain('media-card--missing');
		expect(card.find('[data-test="sync-state"]').attributes('data-state')).toBe(SyncState.MISSING);
		expect(card.find('[data-test="source-marks"]').exists()).toBe(true);
		expect(card.find('img').attributes('src')).toBe('/api/media/a1/artwork?token=t');
		expect(card.text()).toContain('The Expanse');
		expect(card.text()).toContain('2015');
	});

	/** The number people open a series page to find, on the tile itself. */
	it('shows how many children are missing under it', () => {
		const { wrapper } = mountWithApp(MediaCard, {
			props: { group: group({ missingCount: 4 }) },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-missing-count"]').text()).toContain('4 missing');
	});

	it('reports a pick, so the wall can offer to sync it', async () => {
		const { wrapper } = mountWithApp(MediaCard, {
			props: { group: group() },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="media-select"] input').setValue(true);

		expect(wrapper.emitted('update:selected')?.[0]).toEqual([true]);
	});

	/**
	 * A tile stays a link, and a click only picks it while the wall is selecting —
	 * otherwise every second pick would open a page and lose the first.
	 */
	it('picks the tile instead of opening it while the wall is selecting', async () => {
		const { wrapper } = mountWithApp(MediaCard, {
			props: { group: group(), selecting: true },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('.media-card_link').trigger('click');

		expect(wrapper.emitted('update:selected')?.[0]).toEqual([true]);
	});

	it('opens the media when nothing is being selected', async () => {
		const { wrapper } = mountWithApp(MediaCard, {
			props: { group: group() },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('.media-card_link').trigger('click');

		expect(wrapper.emitted('update:selected')).toBeUndefined();
		expect(wrapper.find('.media-card_link').attributes('href')).toContain('/library/g1');
	});
});

describe('components/media/LibrarySection', () => {
	it('says a band is empty rather than rendering an empty strip', () => {
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', libraryId: 'l1', libraryKind: LibraryKind.SHOWS, groups: [], total: 0 },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="library-section-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="media-list"]').exists()).toBe(false);
	});

	/** The heading is the name the media server gave it, never our enum. */
	it('heads the band with the library name and keeps the kind to itself', () => {
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', libraryId: 'l1', libraryKind: LibraryKind.SHOWS, groups: [group()], total: 137 },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('.library-section_title').text()).toBe('Animes');
		expect(wrapper.text()).not.toContain('shows');
		expect(wrapper.find('[data-test="library-section"]').attributes('data-kind'))
			.toBe(LibraryKind.SHOWS);
	});

	/**
	 * A library whose server never said what it holds is not a library of unknowns.
	 *
	 * It is the ordinary Jellyfin library — every one of the seven on the gateway this
	 * was measured against — and the folder icon it used to get said the opposite of
	 * what is true: not "we have no idea", but "films and shows, both".
	 */
	it('gives a band that may hold either its own icon rather than the unknown one', () => {
		const mixed = mountWithApp(LibrarySection, {
			props: { title: 'Video', libraryId: 'l1', libraryKind: LibraryKind.MIXED, groups: [group()], total: 3 },
			global: { stubs: tooltipStub },
		}).wrapper;
		const other = mountWithApp(LibrarySection, {
			props: { title: 'Photos', libraryId: 'l2', libraryKind: LibraryKind.OTHER, groups: [group()], total: 3 },
			global: { stubs: tooltipStub },
		}).wrapper;

		expect(mixed.find('[data-test="library-section"]').attributes('data-kind'))
			.toBe(LibraryKind.MIXED);
		expect(mixed.html()).not.toBe(other.html());
	});

	it('counts what the band holds, not what fits on the screen', () => {
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', libraryKind: LibraryKind.SHOWS, groups: [group()], total: 137 },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="library-section-count"]').text()).toContain('137');
		expect(wrapper.findAll('[data-test="media-card"]')).toHaveLength(1);
	});

	it('offers to open the band on its own when it shows less than it holds', async () => {
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', libraryKind: LibraryKind.SHOWS, groups: [group()], total: 137, truncated: true },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="library-section-all"]').trigger('click');

		expect(wrapper.emitted('see-all')).toHaveLength(1);
	});

	it('opens the band from its heading even when nothing is hidden', async () => {
		/*
		 * The regression this replaced: the only way into a category was the "see all"
		 * button, which renders only when the band shows less than it holds. A
		 * category of two films therefore could not be opened at all — the one thing
		 * somebody looking at a band wants to do.
		 */
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', libraryKind: LibraryKind.SHOWS, groups: [group()], total: 1, openable: true },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="library-section-all"]').exists()).toBe(false);

		await wrapper.find('[data-test="library-section-open"]').trigger('click');

		expect(wrapper.emitted('see-all')).toHaveLength(1);
	});

	it('opens the band from the keyboard as well as the pointer', async () => {
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', groups: [group()], total: 1, openable: true },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="library-section-open"]').trigger('keydown.enter');

		expect(wrapper.emitted('see-all')).toHaveLength(1);
	});

	it('leaves the heading inert on the screen already showing that category', () => {
		// A link to where you are is a broken link.
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', groups: [group()], total: 1 },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="library-section-open"]').exists()).toBe(false);
		expect(wrapper.find('.library-section_title').text()).toBe('Animes');
	});

	/** Structure, not taxonomy: a record sleeve is square and a film is a poster. */
	it('squares the artwork of a music library and leaves the rest as posters', () => {
		const music = mountWithApp(LibrarySection, {
			props: { title: 'Concerts', libraryKind: LibraryKind.MUSIC, groups: [group()], total: 1 },
			global: { stubs: tooltipStub },
		});
		const films = mountWithApp(LibrarySection, {
			props: { title: 'FilmsHD', libraryKind: LibraryKind.MOVIES, groups: [group()], total: 1 },
			global: { stubs: tooltipStub },
		});

		expect(music.wrapper.find('[data-test="media-poster"]').classes()).toContain('media-poster--square');
		expect(films.wrapper.find('[data-test="media-poster"]').classes()).not.toContain('media-poster--square');
	});

	/**
	 * A count of four hundred above twenty-four posters reads as a broken wall unless
	 * the band says these are the newest of them.
	 */
	it('says a capped band is the latest of its category, and whether any of it is ours', () => {
		const { wrapper } = mountWithApp(LibrarySection, {
			props: {
				title: 'Animes',
				categoryKey: 'animes',
				libraryKind: LibraryKind.SHOWS,
				groups: [group()],
				total: 400,
				latest: true,
				local: true,
			},
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="library-section"]').attributes('data-category')).toBe('animes');
		expect(wrapper.find('[data-test="library-section-latest"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="library-section-local"]').exists()).toBe(true);
	});

	it('renders rows instead of tiles for somebody who wants the dense view', () => {
		const { wrapper } = mountWithApp(LibrarySection, {
			props: { title: 'Animes', libraryKind: LibraryKind.SHOWS, groups: [group()], total: 1, view: 'list' },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.findAll('[data-test="media-row"]')).toHaveLength(1);
		expect(wrapper.find('[data-test="media-card"]').exists()).toBe(false);
	});
});

describe('components/media/CompanionMarks', () => {
	/**
	 * The distinction the whole component exists for: never inspected is not the
	 * same as inspected and empty, and reading one as the other reports a complete
	 * library as an empty one.
	 */
	it('says a copy was never inspected rather than claiming nothing is there', () => {
		const { wrapper } = mountWithApp(CompanionMarks, {
			props: { companions: null, detailed: true },
			global: { stubs: tooltipStub },
		});

		const marks = wrapper.find('[data-test="companion-marks"]');
		expect(marks.attributes('data-state')).toBe('unknown');
		expect(wrapper.text()).toContain('Never inspected');
		expect(wrapper.find('[data-companion="nfo"]').exists()).toBe(false);
	});

	it('shows each companion as present or absent once it has been read', () => {
		const { wrapper } = mountWithApp(CompanionMarks, {
			props: {
				companions: {
					nfo: true,
					poster: true,
					fanart: false,
					subtitles: 2,
					missing: [],
					checkedAt: '2026-02-01T00:00:00.000Z',
				},
			},
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="companion-marks"]').attributes('data-state')).toBe('known');
		expect(wrapper.find('[data-companion="nfo"]').attributes('data-present')).toBe('true');
		expect(wrapper.find('[data-companion="fanart"]').attributes('data-present')).toBe('false');
		expect(wrapper.find('[data-companion="subtitles"]').text()).toContain('2');
	});

	it('names what a source has and we do not', () => {
		const { wrapper } = mountWithApp(CompanionMarks, {
			props: {
				companions: {
					nfo: false,
					poster: false,
					fanart: false,
					subtitles: 0,
					missing: ['show.nfo', 'poster.jpg'],
					checkedAt: '2026-02-01T00:00:00.000Z',
				},
				detailed: true,
			},
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="companion-marks"]').attributes('data-state')).toBe('incomplete');
		expect(wrapper.text()).toContain('show.nfo');
		expect(wrapper.text()).toContain('poster.jpg');
	});

	/** An empty `missing` is not a promise of completeness, and must not read as one. */
	it('claims nothing more than "nothing known to be missing"', () => {
		const { wrapper } = mountWithApp(CompanionMarks, {
			props: {
				companions: { nfo: true, poster: true, fanart: true, subtitles: 1, missing: [], checkedAt: null },
				detailed: true,
			},
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('Nothing known to be missing');
	});
});
/**
 * The two lines that explain a screen nothing else explains.
 *
 * Both exist only to be seen, which is why they are pinned here as well as in a
 * journey: a hint that renders nothing, or renders a verdict where a suspicion was
 * meant, is the whole feature gone.
 */
describe('LibraryHints', () => {
	const hint = (overrides: Partial<LibraryHint> = {}): LibraryHint => ({
		key: 'misread-folder:series-1',
		kind: LibraryHintKind.MISREAD_FOLDER,
		itemId: 'series-1',
		title: 'Scream',
		libraryName: 'Series TV',
		serviceName: 'Jellyfin',
		signals: [LibraryLayoutSignal.NAMED_SEASONS],
		examples: ['Agatha All Along', 'Agent Carter'],
		seasonCount: 24,
		...overrides,
	});

	const mounted = (hints: LibraryHint[], dismissable = true) =>
		mountWithApp(LibraryHints, { props: { hints, dismissable }, global: { stubs: tooltipStub } });

	it('draws nothing at all when there is nothing to say', () => {
		expect(mounted([]).wrapper.find('[data-test="library-hints"]').exists()).toBe(false);
	});

	it('says in one line that no server has its folders declared', () => {
		const { wrapper } = mounted([
			hint({ kind: LibraryHintKind.NOTHING_MOUNTED, title: null, itemId: null, signals: [], examples: [], key: 'nothing-mounted' }),
		]);

		expect(wrapper.find('[data-test="library-hint-text"]').text())
			.toContain('nothing counts as held here');
	});

	it('never offers to dismiss the mount line', () => {
		// It goes on its own the moment one mapping exists, and a dismissal would
		// silence the one sentence that explains thirty thousand rows.
		const { wrapper } = mounted([
			hint({ kind: LibraryHintKind.NOTHING_MOUNTED, key: 'nothing-mounted', signals: [], examples: [] }),
		]);

		expect(wrapper.find('[data-test="library-hint-dismiss"]').exists()).toBe(false);
	});

	it('names the series, quotes the seasons, and says what to change on the server', () => {
		const { wrapper } = mounted([hint()]);

		expect(wrapper.find('[data-test="library-hint-text"]').text()).toContain('Scream');
		expect(wrapper.find('[data-test="library-hint-text"]').text()).toContain('24 seasons');
		expect(wrapper.find('[data-test="library-hint-examples"]').text()).toContain('Agent Carter');
		expect(wrapper.text()).toContain('Add the deeper folder as a library root');
	});

	it('words it as a suspicion rather than a verdict', () => {
		// Some real shows do name their seasons. A line that said this was wrong would
		// be wrong itself, on somebody's anthology, with no way to argue with it.
		expect(mounted([hint()]).wrapper.text()).toContain('worth checking');
	});

	it('says which of the two things looks odd', () => {
		const many = mounted([
			hint({ signals: [LibraryLayoutSignal.TOO_MANY_SEASONS], examples: [], seasonCount: 62 }),
		]);

		expect(many.wrapper.find('[data-test="library-hint-text"]').text())
			.toContain('more than a show usually runs for');
		expect(mounted([hint()]).wrapper.find('[data-test="library-hint-text"]').text())
			.toContain('named like separate shows');
	});

	it('hands back the key when the line is dismissed', async () => {
		const { wrapper } = mounted([hint()]);

		await wrapper.find('[data-test="library-hint-dismiss"]').trigger('click');

		expect(wrapper.emitted('dismiss')).toEqual([['misread-folder:series-1']]);
	});

	it('offers no dismissal to somebody who cannot change a setting', () => {
		expect(mounted([hint()], false).wrapper.find('[data-test="library-hint-dismiss"]').exists())
			.toBe(false);
	});

	it('puts the gateway-wide line above the one about a single show', () => {
		// Told that a show looks odd while nothing at all is mounted, somebody would go
		// and investigate the show.
		const { wrapper } = mounted([
			hint(),
			hint({ kind: LibraryHintKind.NOTHING_MOUNTED, key: 'nothing-mounted', signals: [], examples: [] }),
		]);
		const kinds = wrapper.findAll('[data-test="library-hint"]')
			.map(one => one.attributes('data-kind'));

		expect(kinds).toEqual([LibraryHintKind.NOTHING_MOUNTED, LibraryHintKind.MISREAD_FOLDER]);
	});

	it('draws nothing for a kind this version has no sentence for', () => {
		// A gateway one version ahead answers a kind with no wording here, and a row
		// rendered blank is a warning nobody can act on.
		const { wrapper } = mounted([hint({ kind: 'something_new' as LibraryHintKind })]);

		expect(wrapper.find('[data-test="library-hints"]').exists()).toBe(false);
	});
});
