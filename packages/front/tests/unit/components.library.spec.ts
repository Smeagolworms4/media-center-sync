import type { MediaGroup, MediaGroupSource, Peer } from '@mcs/shared';
import {
	LibraryKind,
	MediaKind,
	MediaServiceScope,
	MediaServiceType,
	PeerStatus,
	PeerTrust,
	SyncState,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
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
		fingerprint: 'AB',
		status: PeerStatus.LINKED,
		direction: null,
		trust: PeerTrust.FRIEND,
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
		scope: MediaServiceScope.LOCAL,
		peerId: null,
		peerName: null,
		quality: null,
		companions: null,
		bytes: 1024,
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

	/** The two states people scan a wall for cannot depend on telling two hues apart. */
	it.each([SyncState.MISSING, SyncState.OUTDATED])('spells %s out in words too', state => {
		const { wrapper } = mountWithApp(SyncStateBadge, {
			props: { state },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('.sync-state-badge_label').exists()).toBe(true);
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
