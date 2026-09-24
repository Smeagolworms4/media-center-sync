import type { CatalogueEntry, Library, MediaGroup, MediaGroupSource, MediaService } from '@mcs/shared';
import {
	LibraryKind,
	MediaKind,
	MediaOrigin,
	MediaResolution,
	MediaServiceMode,
	MediaServiceStatus,
	MediaServiceType,
	SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import GroupSources from '@/components/media/GroupSources.vue';
import MediaFilters from '@/components/media/MediaFilters.vue';
import MediaGroupRow from '@/components/media/MediaGroupRow.vue';
import CatalogueList from '@/components/peer/CatalogueList.vue';
import LibraryPage from '@/pages/Library.vue';
import { mountWithApp, mountWithAppAt, stubFetchRoutes, tooltipStub } from './helpers';

async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
		id: 's1',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		shared: true,
		filesMounted: true,
		mode: MediaServiceMode.LOCAL,
		baseUrl: 'http://10.0.0.2:8096',
		status: MediaServiceStatus.ONLINE,
		version: null,
		rootMappings: [],
		authProvider: false,
		priority: 10,
		peerId: null,
		serverIdentifier: null,
		connectionRoute: null,
		lastProbeAt: null,
		lastScanAt: null,
		libraryCount: 1,
		itemCount: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function library (overrides: Partial<Library> = {}): Library {
	return {
		id: 'l1',
		serviceId: 's1',
		externalId: 'x',
		name: 'Shows',
		alias: null,
		position: 0,
		kind: LibraryKind.SHOWS,
		paths: [],
		localPath: null,
		writable: false,
		isDefaultTarget: false,
		itemCount: 0,
		lastScanAt: null,
		lastRefreshAt: null,
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
		path: null,
		localPath: null,
		sync: SyncState.IN_SYNC,
		...overrides,
	};
}

function group (overrides: Partial<MediaGroup> = {}): MediaGroup {
	return {
		id: 'g1',
		kind: MediaKind.EPISODE,
		title: 'Pilot',
		normalizedTitle: 'pilot',
		year: 2019,
		seasonNumber: 1,
		episodeNumber: 1,
		externalIds: {},
		overview: null,
		artworkItemId: null,
		sync: SyncState.IN_SYNC,
		quality: null,
		sources: [source()],
		versions: [],
		childCount: 0,
		missingCount: 0,
		libraryId: 'l1',
		parentId: null,
		addedAt: null,
		...overrides,
	};
}

describe('components/media/MediaFilters', () => {
	const libraries = [library({ id: 'l1', serviceId: 's1' }), library({ id: 'l2', serviceId: 's2' })];
	/*
	 * Shelves rather than libraries, which is what the wall is built from and what the
	 * filter now offers. Two libraries of one name are one shelf, so a household with
	 * `Films` on two servers reads one line here instead of two identical ones with
	 * nothing to tell them apart.
	 */
	const categories = [
		{
			key: 'films', name: 'Films', kind: LibraryKind.MOVIES, position: 0,
			libraryIds: ['l1'], serviceIds: ['s1'], itemCount: 2, local: true,
		},
		{
			key: 'shows', name: 'Shows', kind: LibraryKind.SHOWS, position: 1,
			libraryIds: ['l2'], serviceIds: ['s2'], itemCount: 4, local: false,
		},
	];

	it('offers only the shelves the services being looked at hold something on', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], categories, serviceIds: ['s1'] },
		});

		expect((wrapper.vm as any).categoryItems.map((one: { key: string }) => one.key))
			.toEqual(['films']);
	});

	/** Comparing two friends' shelves is the ordinary case, not the exotic one. */
	it('takes several services at once', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], categories, serviceIds: ['s1', 's2'] },
		});

		expect((wrapper.vm as any).categoryItems).toHaveLength(2);
	});

	/**
	 * The four origins are the filter people actually reach for, and they are on the
	 * screen rather than behind a menu: telling a friend from a friend of a friend is
	 * the distinction the whole thing exists for.
	 */
	it('offers the four origins as something to read, not a select to open', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], categories },
			global: { stubs: tooltipStub },
		});

		for (const origin of Object.values(MediaOrigin)) {
			expect(wrapper.find(`[data-test="media-origin-${origin}"]`).exists()).toBe(true);
		}
		expect(wrapper.find('[data-test="media-origin-friend_of_friend"]').text())
			.toContain('Friends of friends');
	});

	it('reports the origins it was given, and nothing rather than an empty list', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [], libraries, origins: [MediaOrigin.FRIEND] },
			global: { stubs: tooltipStub },
		});

		(wrapper.vm as any).originModel = [MediaOrigin.FRIEND, MediaOrigin.FRIEND_OF_FRIEND];
		expect(wrapper.emitted('update:origins')?.at(-1))
			.toEqual([[MediaOrigin.FRIEND, MediaOrigin.FRIEND_OF_FRIEND]]);

		(wrapper.vm as any).originModel = [];
		expect(wrapper.emitted('update:origins')?.at(-1)).toEqual([null]);
	});

	it('offers every shelf when no service is chosen', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], categories },
		});

		expect((wrapper.vm as any).categoryItems).toHaveLength(2);
	});

	it('drops the shelf filter when the services change, or it would filter everything out', async () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], categories, serviceIds: ['s2'], categoryKey: 'films' },
		});

		(wrapper.vm as any).onServicesChange();

		expect(wrapper.emitted('update:categoryKey')?.at(-1)).toEqual([null]);
	});

	/** A shelf still offered by the narrowed list is a filter worth keeping. */
	it('keeps a shelf the chosen services still offer', async () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], categories, serviceIds: ['s1'], categoryKey: 'films' },
		});

		(wrapper.vm as any).onServicesChange();

		expect(wrapper.emitted('update:categoryKey')).toBeUndefined();
	});

	/**
	 * On the overview every band is already the latest additions of its category, and
	 * a sort control there would offer an order the screen ignores.
	 */
	it('says the order is fixed instead of offering one the wall ignores', () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [], libraries, sortable: false },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-sort"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="media-sort-fixed"]').exists()).toBe(true);
	});

	it('clears every filter at once, and says so only while there is one', async () => {
		const { wrapper } = mountWithApp(MediaFilters, {
			props: { services: [service()], libraries, search: 'expanse', states: [SyncState.MISSING] },
		});

		expect(wrapper.find('[data-test="media-clear"]').exists()).toBe(true);
		(wrapper.vm as any).clear();

		expect(wrapper.emitted('update:search')?.at(-1)).toEqual([null]);
		expect(wrapper.emitted('update:states')?.at(-1)).toEqual([null]);
	});

	it('flips the sort direction rather than offering two controls', () => {
		const { wrapper } = mountWithApp(MediaFilters, { props: { direction: 'asc' } });

		(wrapper.vm as any).toggleDirection();

		expect(wrapper.emitted('update:direction')?.at(-1)).toEqual(['desc']);
	});

	/**
	 * What the files actually are, which is the question the filter bar could not ask.
	 *
	 * Two controls rather than one, because "anything in 4K" and "anything still in x264"
	 * are independent questions and usually asked separately.
	 */
	describe('resolution and codec', () => {
		it('offers both controls, and every band the gateway derives', () => {
			const { wrapper } = mountWithApp(MediaFilters, {
				props: { services: [service()], categories },
			});

			expect(wrapper.find('[data-test="media-resolutions"]').exists()).toBe(true);
			expect(wrapper.find('[data-test="media-codecs"]').exists()).toBe(true);
			expect((wrapper.vm as any).resolutionItems.map((one: { value: string }) => one.value))
				.toEqual(['2160p', '1080p', '720p', '576p', '480p']);
		});

		/**
		 * The label carries both spellings and the value carries one.
		 *
		 * Somebody hunting for HEVC has no reason to know this gateway writes it `x265`,
		 * and the API only ever matches the folded spelling — so the pairing has to be on
		 * the label and never on the value.
		 */
		it('names a codec by both spellings while sending only the folded one', () => {
			const { wrapper } = mountWithApp(MediaFilters, { props: { services: [service()] } });

			const items = (wrapper.vm as any).codecItems as { value: string; title: string }[];
			const hevc = items.find(one => one.value === 'x265');

			expect(hevc?.title).toBe('x265 / HEVC');
			expect(items.map(one => one.value)).toContain('x264');
			// Never an alias as a value: the index holds no row spelled `hevc`.
			expect(items.map(one => one.value)).not.toContain('hevc');
		});

		it('reports the bands and the codecs it was given', () => {
			const { wrapper } = mountWithApp(MediaFilters, {
				props: { services: [service()], categories },
			});

			(wrapper.vm as any).resolutions = [MediaResolution.UHD];
			(wrapper.vm as any).videoCodecs = ['x265'];

			expect(wrapper.emitted('update:resolutions')?.at(-1)).toEqual([['2160p']]);
			expect(wrapper.emitted('update:videoCodecs')?.at(-1)).toEqual([['x265']]);
		});

		it('counts as a filter on its own, and is cleared with the rest', () => {
			const { wrapper } = mountWithApp(MediaFilters, {
				props: {
					services: [service()],
					resolutions: [MediaResolution.FULL_HD],
					videoCodecs: ['x264'],
				},
			});

			// Offering "clear" only for the older filters would leave somebody stuck on a
			// wall narrowed by a control that said nothing about being on.
			expect(wrapper.find('[data-test="media-clear"]').exists()).toBe(true);

			(wrapper.vm as any).clear();

			expect(wrapper.emitted('update:resolutions')?.at(-1)).toEqual([null]);
			expect(wrapper.emitted('update:videoCodecs')?.at(-1)).toEqual([null]);
		});
	});
});

/**
 * The followed tab: the same wall, pre-filtered.
 *
 * Proving it is the same listing is most of the point — a second screen would be a
 * second place for the bands, the pager and the selection bar to drift apart — so these
 * assert on the requests the page makes and on the address it keeps.
 */
describe('pages/Library the followed tab', () => {
	const CATEGORY = {
		key: 'films',
		name: 'Films',
		kind: LibraryKind.MOVIES,
		position: 0,
		libraryIds: ['l1'],
		serviceIds: ['s1'],
		itemCount: 2,
		local: true,
	};

	const page = (items: MediaGroup[]): unknown => ({
		items,
		pagination: { page: 1, limit: 24, total: items.length, pages: items.length > 0 ? 1 : 0 },
	});

	const ROUTES = (groups: MediaGroup[]): Record<string, { body: unknown }> => ({
		'/api/services': { body: [] },
		'/api/peers': { body: [] },
		'/api/libraries/categories': { body: [CATEGORY] },
		'/api/libraries': { body: [] },
		'/api/media/groups': { body: page(groups) },
	});

	const askedFor = (stub: ReturnType<typeof stubFetchRoutes>): string[] =>
		stub.mock.calls.map(call => String(call[0])).filter(url => url.includes('/media/groups'));

	it('asks for what a plan follows and what there is something to do about', async () => {
		const stub = stubFetchRoutes(ROUTES([group()]));
		await mountWithAppAt(LibraryPage, '/library?tab=followed', { global: { stubs: tooltipStub } });
		await settle();

		const asked = askedFor(stub);

		expect(asked.length).toBeGreaterThan(0);
		expect(asked.every(url => url.includes('followed=true'))).toBe(true);
		expect(asked.every(url => url.includes('actionable=true'))).toBe(true);
		// Still the same wall: the band is still a category, asked for the same way.
		expect(asked.every(url => url.includes('categoryKey=films'))).toBe(true);
		expect(asked.every(url => url.includes('rootsOnly=true'))).toBe(true);
	});

	it('asks for neither of them on the library tab', async () => {
		const stub = stubFetchRoutes(ROUTES([group()]));
		await mountWithAppAt(LibraryPage, '/library', { global: { stubs: tooltipStub } });
		await settle();

		const asked = askedFor(stub);

		expect(asked.length).toBeGreaterThan(0);
		expect(asked.some(url => url.includes('followed='))).toBe(false);
		expect(asked.some(url => url.includes('actionable='))).toBe(false);
	});

	/** A pre-filtered wall is only worth anything if it is a link somebody can send. */
	it('puts the tab in the address rather than in component state', async () => {
		stubFetchRoutes(ROUTES([group()]));
		const { wrapper, router } = await mountWithAppAt(LibraryPage, '/library', {
			global: { stubs: tooltipStub },
		});
		await settle();

		await wrapper.find('[data-test="library-tab-followed"]').trigger('click');
		await settle();

		expect(router.currentRoute.value.query.tab).toBe('followed');
	});

	it('reads the tab back out of a link that was sent', async () => {
		stubFetchRoutes(ROUTES([group()]));
		const { wrapper } = await mountWithAppAt(LibraryPage, '/library?tab=followed', {
			global: { stubs: tooltipStub },
		});
		await settle();

		expect(wrapper.find('[data-test="library-tab-followed"]').classes())
			.toContain('v-tab--selected');
	});

	it('carries the resolution and the codec into every band it asks for', async () => {
		const stub = stubFetchRoutes(ROUTES([group()]));
		await mountWithAppAt(LibraryPage, '/library?resolutions=2160p&videoCodecs=x265', {
			global: { stubs: tooltipStub },
		});
		await settle();

		const asked = askedFor(stub);

		expect(asked.length).toBeGreaterThan(0);
		expect(asked.every(url => url.includes('resolutions=2160p'))).toBe(true);
		expect(asked.every(url => url.includes('videoCodecs=x265'))).toBe(true);
	});

	/** A band with nothing to act on is good news, and must not read as a broken library. */
	it('says everything followed is up to date rather than that there is no library', async () => {
		stubFetchRoutes(ROUTES([]));
		const { wrapper } = await mountWithAppAt(LibraryPage, '/library?tab=followed', {
			global: { stubs: tooltipStub },
		});
		await settle();

		const empty = wrapper.find('[data-test="empty-state"]');

		expect(empty.exists()).toBe(true);
		expect(empty.find('.mdi-check-circle-outline').exists()).toBe(true);
	});

	it('shows the ordinary empty state on the library tab', async () => {
		stubFetchRoutes(ROUTES([]));
		const { wrapper } = await mountWithAppAt(LibraryPage, '/library', {
			global: { stubs: tooltipStub },
		});
		await settle();

		const empty = wrapper.find('[data-test="empty-state"]');

		expect(empty.exists()).toBe(true);
		expect(empty.find('.mdi-check-circle-outline').exists()).toBe(false);
	});
});

describe('components/media/GroupSources', () => {
	it('lists the copies in the order the gateway would consult them', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: {
				sources: [
					source({ itemId: 'i-slow', serviceId: 'slow', serviceName: 'Slow' }),
					source({ itemId: 'i-fast', serviceId: 'fast', serviceName: 'Fast' }),
				],
				services: [
					service({ id: 'slow', name: 'Slow', priority: 50 }),
					service({ id: 'fast', name: 'Fast', priority: 1 }),
				],
			},
			global: { stubs: tooltipStub },
		});

		const rows = wrapper.findAll('[data-test="group-source"]');
		expect(rows.map(row => row.find('.group-sources_name').text())).toEqual(['Fast', 'Slow']);
	});

	/** An empty choice is a decision — follow the configured priority — and says so. */
	it('defaults to the configured priority and names what that means', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: {
				sources: [source({ serviceId: 'fast', serviceName: 'Fast' })],
				services: [service({ id: 'fast', name: 'Fast', priority: 1 })],
			},
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="source-default"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Follow the configured priority');
		expect(wrapper.text()).toContain('Fast');
	});

	it('marks our own copy, so it is not read as one more stranger', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: {
				sources: [
					source({ itemId: 'i-mine', local: true }),
					source({ itemId: 'i-bob', serviceId: 's2', serviceName: 'Bob’s Plex', local: false, peerId: 'p1' }),
				],
				peerNames: { p1: 'Bob' },
			},
			global: { stubs: tooltipStub },
		});

		const rows = wrapper.findAll('[data-test="group-source"]');
		expect(rows.map(row => row.attributes('data-local'))).toEqual(['true', 'false']);
		expect(wrapper.find('[data-test="group-source-ours"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('through Bob');
	});

	it('says nothing holds the item rather than showing an empty list', () => {
		const { wrapper } = mountWithApp(GroupSources, {
			props: { sources: [] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('No service holds this item');
	});

	/**
	 * Several versions, chosen together.
	 *
	 * The picker used to be a radio group over servers, which could express exactly one
	 * answer to a question that has several: a theatrical cut and an extended one are
	 * two things to hold, and being able to tick only one of them is the bug.
	 */
	describe('versions', () => {
		const versioned = (): Record<string, unknown> => ({
			sources: [
				source({
					itemId: 'i-ours',
					serviceId: 'ours',
					serviceName: 'Living room',
					versionId: 'q1-theatrical',
					local: true,
					path: null,
				}),
				source({
					itemId: 'i-theirs',
					serviceId: 'theirs',
					serviceName: 'Cabin',
					versionId: 'q1-theatrical',
					local: false,
					path: null,
				}),
				source({
					itemId: 'i-extended',
					serviceId: 'theirs',
					serviceName: 'Cabin',
					versionId: 'q1-extended',
					edition: 'Extended Cut',
					local: false,
					path: null,
				}),
			],
			versions: [
				{
					versionId: 'q1-theatrical',
					edition: null,
					quality: null,
					bytes: 1024,
					heldLocally: true,
					sourceItemIds: ['i-ours', 'i-theirs'],
				},
				{
					versionId: 'q1-extended',
					edition: 'Extended Cut',
					quality: null,
					bytes: 2048,
					heldLocally: false,
					sourceItemIds: ['i-extended'],
				},
			],
			services: [service({ id: 'ours', priority: 1 }), service({ id: 'theirs', priority: 2 })],
		});

		it('lists one row per version rather than one per server', () => {
			// Two servers holding the same file is one thing to pull, not two.
			const { wrapper } = mountWithApp(GroupSources, {
				props: versioned(),
				global: { stubs: tooltipStub },
			});

			const rows = wrapper.findAll('[data-test="group-source"]');

			expect(rows).toHaveLength(2);
			expect(rows.map(row => row.attributes('data-held'))).toEqual(['true', 'false']);
			expect(wrapper.find('[data-test="group-source-edition"]').text()).toBe('Extended Cut');
		});

		it('asks for the copy the row names, never for its service', async () => {
			// One server holds both cuts here, so a service identifier could not say
			// which of them was asked for — which is why the button sits on a row.
			const { wrapper } = mountWithApp(GroupSources, {
				props: versioned(),
				global: { stubs: tooltipStub },
			});

			/*
			 * One button, not two: the theatrical cut is already on our disk, and
			 * fetching a version we hold would write a second copy of bytes we have.
			 * Only the extended cut is missing, and it is the one offered.
			 */
			const buttons = wrapper.findAll('[data-test="group-source-download"]');

			expect(buttons).toHaveLength(1);

			await buttons[0].trigger('click');

			expect(wrapper.emitted('download')?.at(-1)).toEqual(['i-extended']);
		});

		it('says how much of it is already here', async () => {
			const { wrapper } = mountWithApp(GroupSources, {
				props: versioned(),
				global: { stubs: tooltipStub },
			});

			// Holding one of the two is an ordinary state, said as a count and not as a
			// warning: this is not a half-failed sync.
			expect(wrapper.find('[data-test="source-selection"]').text()).toContain('1 of 2 versions here');
		});

		it('shows how far along a copy being fetched is, instead of offering it again', () => {
			// Offering to fetch something already being fetched is how somebody ends up
			// with two of it.
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					...versioned(),
					transfers: {
						'i-extended': {
							id: 't-1',
							state: 'downloading',
							bytesDone: 512,
							bytesTotal: 1024,
							rate: 0,
							etaSeconds: null,
							chunksDone: 1,
							chunksTotal: 2,
							sourceCount: 1,
						},
					},
				},
				global: { stubs: tooltipStub },
			});

			expect(wrapper.findAll('[data-test="group-source-progress"]')).toHaveLength(1);
			expect(wrapper.find('[data-test="group-source-progress"]').text()).toContain('50%');
			// And none left to offer: the other version is already on our disk.
			expect(wrapper.findAll('[data-test="group-source-download"]')).toHaveLength(0);
		});

		it('offers to erase a copy of ours, naming the copy and not the row', async () => {
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					sources: [source({
						itemId: 'i-ours',
						versionId: 'q1-ours',
						local: true,
						path: '/media/shows/S01E01.mkv',
					})],
					versions: [{
						versionId: 'q1-ours',
						edition: null,
						quality: null,
						bytes: 1024,
						heldLocally: true,
						sourceItemIds: ['i-ours'],
					}],
				},
				global: { stubs: tooltipStub },
			});

			await wrapper.find('[data-test="group-source-delete"]').trigger('click');

			expect(wrapper.emitted('remove')?.at(-1)?.[0]).toMatchObject({
				itemId: 'i-ours',
				path: '/media/shows/S01E01.mkv',
			});
		});

		it('offers nothing to erase for a copy whose path nobody knows', () => {
			// Without a path there is nothing to name in the confirmation, and a
			// confirmation that cannot say what it is about is worse than no button.
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					sources: [source({ itemId: 'i-ours', versionId: 'q1-ours', local: true, path: null })],
					versions: [{
						versionId: 'q1-ours',
						edition: null,
						quality: null,
						bytes: 1024,
						heldLocally: true,
						sourceItemIds: ['i-ours'],
					}],
				},
				global: { stubs: tooltipStub },
			});

			expect(wrapper.find('[data-test="group-source-delete"]').exists()).toBe(false);
		});

		/**
		 * The line the owner could not find: his own copy.
		 *
		 * A version row used to fold the local and the remote copy together, name itself
		 * after the server a pull would come from, and carry a delete button that acted
		 * on a copy the line never mentioned — so the row said `plex-pve` and pressing
		 * the bin erased the file on his own disk. He asked for both, plainly: the remote
		 * one marked as already fetched with no button at all, and the delete on his.
		 */
		it('lists our copy and the remote one, each with its own action', () => {
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					sources: [
						source({
							itemId: 'i-ours',
							versionId: 'q1',
							local: true,
							serviceName: 'MisaMisa',
							path: '/media/Shows/S01E02.mkv',
							localPath: '/share/Shows/S01E02.mkv',
						}),
						source({
							itemId: 'i-theirs',
							versionId: 'q1',
							local: false,
							serviceName: 'plex-pve',
						}),
					],
					versions: [{
						versionId: 'q1',
						edition: null,
						quality: null,
						bytes: 1024,
						heldLocally: true,
						sourceItemIds: ['i-ours', 'i-theirs'],
					}],
				},
				global: { stubs: tooltipStub },
			});

			const copies = wrapper.findAll('[data-test="group-source-copy"]');

			expect(copies).toHaveLength(2);

			const ours = copies.find(one => one.attributes('data-copy-local') === 'true');
			const theirs = copies.find(one => one.attributes('data-copy-local') === 'false');

			// The bin is on our copy, where the file it would erase actually is.
			expect(ours?.find('[data-test="group-source-delete"]').exists()).toBe(true);
			expect(ours?.text()).toContain('/share/Shows/S01E02.mkv');

			// And the remote one says it has been fetched, with nothing to press: a
			// download button here writes a second copy of bytes we already hold.
			expect(theirs?.find('[data-test="group-source-downloaded"]').exists()).toBe(true);
			expect(theirs?.find('[data-test="group-source-download"]').exists()).toBe(false);
			expect(theirs?.find('[data-test="group-source-delete"]').exists()).toBe(false);
		});

		it('offers nothing to pull for a version only we hold', () => {
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					sources: [source({ itemId: 'i-ours', versionId: 'q1-ours', local: true })],
					versions: [{
						versionId: 'q1-ours',
						edition: null,
						quality: null,
						bytes: 1024,
						heldLocally: true,
						sourceItemIds: ['i-ours'],
					}],
				},
				global: { stubs: tooltipStub },
			});

			// Listed and marked rather than hidden: "you already have this one" is an
			// answer, and an empty list is not.
			expect(wrapper.findAll('[data-test="group-source"]')).toHaveLength(1);
			expect(wrapper.find('[data-test="group-source-nothing"]').exists()).toBe(true);
			expect(wrapper.find('[data-test="group-source-download"]').exists()).toBe(false);
		});

		it('falls back to one row per copy while nothing has been fingerprinted', () => {
			// No version can be told from another, so the list says what it knows —
			// which is where it stood before versions existed.
			const { wrapper } = mountWithApp(GroupSources, {
				props: {
					sources: [
						source({ itemId: 'i-a', serviceId: 'a', serviceName: 'A', local: false }),
						source({ itemId: 'i-b', serviceId: 'b', serviceName: 'B', local: false }),
					],
					versions: [],
				},
				global: { stubs: tooltipStub },
			});

			expect(wrapper.findAll('[data-test="group-source"]')).toHaveLength(2);
		});
	});
});

describe('components/media/MediaGroupRow', () => {
	it('dims a missing row and counts what is missing under it', () => {
		const { wrapper } = mountWithApp(MediaGroupRow, {
			props: { group: group({ sync: SyncState.MISSING, missingCount: 3 }) },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-row"]').classes()).toContain('media-row--missing');
		expect(wrapper.text()).toContain('3 missing');
	});

	it('carries the state, the quality and the sources the whole interface reads', () => {
		const { wrapper } = mountWithApp(MediaGroupRow, {
			props: { group: group() },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="media-row"]').attributes('data-state')).toBe(SyncState.IN_SYNC);
		expect(wrapper.find('[data-test="sync-state"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="quality-chip"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="source-marks"]').exists()).toBe(true);
	});

	it('reports a selection, so a page can offer to sync what was picked', async () => {
		const { wrapper } = mountWithApp(MediaGroupRow, {
			props: { group: group(), selectable: true },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="media-select"] input').setValue(true);

		expect(wrapper.emitted('update:selected')?.[0]).toEqual([true]);
	});
});

describe('components/peer/CatalogueList', () => {
	function entry (overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
		return {
			externalId: 'x1',
			kind: MediaKind.MOVIE,
			title: 'Arrival',
			year: 2016,
			seasonNumber: null,
			episodeNumber: null,
			parentExternalId: null,
			externalIds: {},
			contentId: 'v1:cid',
			size: 900,
			quality: 'x265 · 1080p',
			...overrides,
		};
	}

	it('offers a pull for what the peer actually serves', async () => {
		const { wrapper } = mountWithApp(CatalogueList, {
			props: { entries: [entry()] },
			global: { stubs: tooltipStub },
		});

		await wrapper.find('[data-test="catalogue-pull"]').trigger('click');

		expect(wrapper.emitted('pull')?.[0]?.[0]).toMatchObject({ externalId: 'x1' });
	});

	/** No content identifier means catalogue only; a pull button would only fail. */
	it('offers no pull for an entry shared as a catalogue only', () => {
		const { wrapper } = mountWithApp(CatalogueList, {
			props: { entries: [entry({ contentId: null })] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.find('[data-test="catalogue-pull"]').exists()).toBe(false);
		expect(wrapper.find('[data-shared="false"]').exists()).toBe(true);
	});

	it('shows the empty state rather than an empty table', () => {
		const { wrapper } = mountWithApp(CatalogueList, { props: { entries: [] } });

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
	});
});
