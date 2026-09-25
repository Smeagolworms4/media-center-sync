import type { Library, MediaGroup, MediaItem, MediaService } from '@mcs/shared';
import {
	LibraryKind,
	MediaKind,
	MediaServiceMode,
	MediaServiceStatus,
	MediaServiceType,
	ReleasePreferenceDimension,
	SyncState,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import MediaCard from '@/components/media/MediaCard.vue';
import MediaGroupRow from '@/components/media/MediaGroupRow.vue';
import OverrideDialog from '@/components/media/OverrideDialog.vue';
import ReleasePreferenceNote from '@/components/media/ReleasePreferenceNote.vue';
import { OPEN_OVERRIDE } from '@/composables/useMediaOverride';
import { dialogStub, mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/**
 * The correction dialog, from the outside.
 *
 * What is asserted here is what somebody would notice: that the dialog says what
 * the service had said, that saving sends exactly the fields that were corrected,
 * and that one button puts everything back.
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

const documentaries: Library = {
	...library,
	id: 'l2',
	name: 'Documentaries',
	localPath: '/media/documentaires',
	localRoots: ['/media/documentaires', '/mnt/disk2/documentaires'],
	isDefaultTarget: false,
};

/**
 * A shelf on somebody else's gateway, which must never be offered as a destination.
 *
 * Reclassifying decides which folder a pull of the media lands in, so a library this
 * gateway cannot write into is not a choice: picking it would produce a transfer that
 * succeeds and files nothing, with no error anywhere. The row is still in the index — a
 * friend's libraries are what the wall is half made of — which is exactly why the list
 * has to filter rather than show what it was given.
 */
const theirs: Library = {
	...library,
	id: 'l3',
	serviceId: 's2',
	name: 'Films',
	localPath: null,
	localRoots: [],
	writable: false,
	isDefaultTarget: false,
};

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
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
		...overrides,
	} as MediaService;
}

const peerService = service({
	id: 's2',
	name: 'Bob’s gateway',
	type: MediaServiceType.PEER,
	mode: MediaServiceMode.PEER,
	filesMounted: false,
	peerId: 'p1',
});

function item (overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 'm1',
		serviceId: 's1',
		libraryId: 'l1',
		parentId: null,
		kind: MediaKind.MOVIE,
		title: 'cosmos.1980.1080p',
		normalizedTitle: 'cosmos 1980 1080p',
		year: 1980,
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
		childCount: 0,
		...overrides,
	} as MediaItem;
}

/**
 * A press, both halves of it.
 *
 * The eraser answers the press rather than the click, because a click needs its press and
 * its release to land on the same element and the field re-renders in between — see
 * `OverrideField`. Sending both is what a person's hand does, and it toggles exactly once
 * whichever of the two the component listens to, so this test says nothing about which.
 */
async function press (target: { trigger: (event: string) => Promise<void> }): Promise<void> {
	await target.trigger('mousedown');
	await target.trigger('click');
}

function mountDialog (node: MediaItem = item()) {
	const stub = stubFetchRoutes({
		'/api/media/m1/override': { body: { ...node, overrides: null, reported: null } },
		'/api/media/m1': { body: node },
		'/api/libraries': { body: [library, documentaries, theirs] },
		// Which libraries may be offered is a fact about the services: a shelf is a place
		// a file can land only when its server's folders are mounted here.
		'/api/services': { body: [service(), peerService] },
	});
	const mounted = mountWithApp(OverrideDialog, {
		props: { modelValue: true, itemId: 'm1' },
		global: { stubs: { ...tooltipStub, ...dialogStub } },
	});
	return { ...mounted, stub };
}

describe('components/media/OverrideDialog', () => {
	it('opens on the values in force, and offers the libraries to reclassify into', async () => {
		const { wrapper } = mountDialog();
		await settle();

		expect((wrapper.find('[data-test="override-title"] input').element as HTMLInputElement).value)
			.toBe('cosmos.1980.1080p');
		expect(wrapper.find('[data-test="override-form"]').exists()).toBe(true);
		// The eraser is the only way to express "remove this value", so the dialog
		// says so rather than leaving it to be discovered.
		expect(wrapper.text()).toContain('Leaving a field alone keeps what the service said');
	});

	it('says what the service had said, field by field', async () => {
		const { wrapper } = mountDialog(item({
			title: 'Cosmos',
			year: 1980,
			overrides: { title: 'Cosmos' },
			reported: {
				libraryId: 'l1',
				title: 'cosmos.1980.1080p',
				seriesTitle: null,
				year: 1980,
				seasonNumber: null,
				episodeNumber: null,
				overview: null,
				externalIds: {},
			},
		}));
		await settle();

		expect(wrapper.find('[data-test="override-title-was"]').text())
			.toContain('cosmos.1980.1080p');
	});

	it('sends only what was corrected, and an erased field as null', async () => {
		const { wrapper, stub } = mountDialog();
		await settle();

		await wrapper.find('[data-test="override-title"] input').setValue('Cosmos');
		// The eraser on the year: a documentary a scraper dated by its re-release.
		await press(wrapper.find('[data-test="override-year"] .v-field__append-inner .v-icon'));
		await settle();
		await wrapper.find('[data-test="override-save"]').trigger('click');
		await settle();

		const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');
		expect(put?.[0]).toBe('/api/media/m1/override');
		const body = JSON.parse(put?.[1].body as string);
		expect(body.title).toBe('Cosmos');
		expect('year' in body).toBe(true);
		expect(body.year).toBeNull();
		// Nothing else travels: the service keeps deciding the rest.
		expect(Object.keys(body)).toEqual(['title', 'year']);
	});

	it('puts everything back with one button', async () => {
		const { wrapper, stub } = mountDialog(item({
			title: 'Cosmos',
			overrides: { title: 'Cosmos' },
			reported: {
				libraryId: 'l1',
				title: 'cosmos.1980.1080p',
				seriesTitle: null,
				year: 1980,
				seasonNumber: null,
				episodeNumber: null,
				overview: null,
				externalIds: {},
			},
		}));
		await settle();

		await wrapper.find('[data-test="override-restore"]').trigger('click');
		await settle();

		const removed = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'DELETE');
		expect(removed?.[0]).toBe('/api/media/m1/override');
	});

	it('offers no restore on an item nobody has corrected', async () => {
		const { wrapper } = mountDialog();
		await settle();

		expect(wrapper.find('[data-test="override-restore"]').exists()).toBe(false);
	});

	/**
	 * Resetting is not restoring, and the pair of buttons is deliberate.
	 *
	 * "Put it all back" writes at once and closes. This one only fills the boxes, so
	 * the service's answer can be read before anybody agrees to it — and so somebody
	 * who looks at it and changes their mind can simply cancel. What it must never do
	 * is save a correction that repeats the service's own answer: an item with no
	 * correction goes on following its server, an item corrected to today's values is
	 * frozen on them for ever.
	 */
	describe('resetting the boxes to what the service reports', () => {
		const withCorrection = () => mountDialog(item({
			title: 'Cosmos',
			year: 1999,
			overrides: { title: 'Cosmos', year: 1999 },
			reported: {
				libraryId: 'l1',
				title: 'cosmos.1980.1080p',
				seriesTitle: null,
				year: 1980,
				seasonNumber: null,
				episodeNumber: null,
				overview: null,
				externalIds: {},
			},
		}));

		it('is not offered on an item nobody has corrected', async () => {
			const { wrapper } = mountDialog();
			await settle();

			expect(wrapper.find('[data-test="override-reset"]').exists()).toBe(false);
		});

		it('fills the boxes with the service’s answer, and saves nothing on its own', async () => {
			const { wrapper, stub } = withCorrection();
			await settle();

			expect((wrapper.find('[data-test="override-title"] input').element as HTMLInputElement).value)
				.toBe('Cosmos');

			await wrapper.find('[data-test="override-reset"]').trigger('click');
			await settle();

			// Visible before it is agreed to: the values change on screen and nothing
			// has been written.
			expect((wrapper.find('[data-test="override-title"] input').element as HTMLInputElement).value)
				.toBe('cosmos.1980.1080p');
			expect((wrapper.find('[data-test="override-year"] input').element as HTMLInputElement).value)
				.toBe('1980');
			expect(stub.mock.calls.some(call => String(call[1]?.method).toUpperCase() === 'PUT'))
				.toBe(false);
		});

		it('saves an empty correction afterwards, which is what removes it', async () => {
			// The body is what matters and it is invisible: a body repeating the
			// reported values would store a correction identical to the service's own
			// answer, and the item would never take a title that server later fixes.
			const { wrapper, stub } = withCorrection();
			await settle();

			await wrapper.find('[data-test="override-reset"]').trigger('click');
			await settle();
			await wrapper.find('[data-test="override-save"]').trigger('click');
			await settle();

			const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');

			expect(put?.[0]).toBe('/api/media/m1/override');
			expect(JSON.parse(put?.[1].body as string)).toEqual({});
		});

		it('leaves one field corrected when only that one is typed back', async () => {
			// The same rule at a smaller scale: a field put back by hand stops being a
			// correction, and the others are untouched.
			const { wrapper, stub } = withCorrection();
			await settle();

			await wrapper.find('[data-test="override-title"] input').setValue('cosmos.1980.1080p');
			await settle();
			await wrapper.find('[data-test="override-save"]').trigger('click');
			await settle();

			const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');

			expect(JSON.parse(put?.[1].body as string)).toEqual({ year: 1999 });
		});
	});

	/**
	 * What the control may offer, which is a shorter list than every library we know of.
	 *
	 * Reclassifying decides the category the media appears under *and* the folder a pull
	 * of it lands in. A library on somebody else's gateway is therefore not a choice:
	 * there is nothing there this gateway can write, and choosing one would produce a
	 * transfer that succeeds and files nothing, with no error anywhere. This list used to
	 * offer every library in the index, a friend's included.
	 */
	describe('the libraries it offers to reclassify into', () => {
		const optionsOf = (wrapper: ReturnType<typeof mountDialog>['wrapper']) =>
			wrapper.findComponent({ name: 'VSelect' }).props('items') as
				{ value: string; title: string }[];

		it('offers our own writable shelves and never a remote one', async () => {
			const { wrapper } = mountDialog();
			await settle();

			expect(optionsOf(wrapper).map(one => one.value)).toEqual(['l2', 'l1']);
		});

		it('labels each one with the path a file would land in', async () => {
			// The path and not the name: two servers commonly have a library called
			// `Films`, and a list of identical names is not a choice anybody can make.
			// A shelf spread over two disks lists both, because it really is two.
			const { wrapper } = mountDialog();
			await settle();

			expect(optionsOf(wrapper).map(one => one.title)).toEqual([
				'/media/documentaires · /mnt/disk2/documentaires',
				'/media/films',
			]);
		});

		/**
		 * The requirement, in the owner's words: reassign it before it is downloaded.
		 *
		 * A row a peer reported sits in a library that can never be offered here, so the
		 * select has nothing selected — and a blank control with no explanation reads as
		 * a list that failed to load rather than as an invitation to choose a shelf.
		 */
		it('says where a media we hold no copy of currently sits, and reclassifies it', async () => {
			const { wrapper, stub } = mountDialog(item({ libraryId: 'l3' }));
			await settle();

			expect(wrapper.find('[data-test="override-library-elsewhere"]').exists()).toBe(true);

			await wrapper.findComponent({ name: 'VSelect' }).setValue('l2');
			await settle();
			await wrapper.find('[data-test="override-save"]').trigger('click');
			await settle();

			const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');

			expect(JSON.parse(put?.[1].body as string)).toEqual({ libraryId: 'l2' });
		});
	});

	/**
	 * The third level of a search order, edited where the other corrections are.
	 *
	 * It lives in the same instruction as the title and the reclassification — see
	 * `MediaOverride` — so it is saved by the same button. What the media page carries is
	 * the statement that one is in force and the press that cancels it.
	 */
	describe('this media’s own search order', () => {
		it('offers to give the media one, and shows none until it is asked for', async () => {
			const { wrapper } = mountDialog();
			await settle();

			expect(wrapper.find('[data-test="override-preference-ranks"]').exists()).toBe(false);
			expect(wrapper.find('[data-test="override-preference-give"]').exists()).toBe(true);
		});

		it('sends the order that was built, dimension and values in their order', async () => {
			const { wrapper, stub } = mountDialog();
			await settle();

			await wrapper.find('[data-test="override-preference-give"]').trigger('click');
			await settle();

			// An order with nothing in it separates nothing, which is said rather than
			// left as an empty list reading like a control that failed.
			expect(wrapper.find('[data-test="override-preference-none"]').exists()).toBe(true);

			await wrapper.find('[data-test="override-preference-add-resolution"]').trigger('click');
			await settle();
			await wrapper
				.findComponent('[data-test="override-preference-add-value-resolution"]')
				.setValue('1080p');
			await settle();
			await wrapper
				.findComponent('[data-test="override-preference-add-value-resolution"]')
				.setValue('2160p');
			await settle();
			await wrapper.find('[data-test="override-save"]').trigger('click');
			await settle();

			const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');

			expect(JSON.parse(put?.[1].body as string)).toEqual({
				releasePreference: { ranks: [{ dimension: 'resolution', values: ['1080p', '2160p'] }] },
			});
		});

		it('cancels one that is in force by sending an explicit null', async () => {
			const { wrapper, stub } = mountDialog(item({
				overrides: {
					releasePreference: {
						ranks: [{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] }],
					},
				},
			}));
			await settle();

			expect(wrapper.find('[data-test="override-preference-ranks"]').exists()).toBe(true);

			await wrapper.find('[data-test="override-preference-drop"]').trigger('click');
			await settle();
			await wrapper.find('[data-test="override-save"]').trigger('click');
			await settle();

			const put = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PUT');

			expect(JSON.parse(put?.[1].body as string)).toEqual({ releasePreference: null });
		});
	});
});

/**
 * The line that stops a per-media setting from being an invisible one.
 *
 * A search on one series answering differently from every other, with nothing on the
 * screen mentioning a setting, is the defect this whole feature most easily
 * reintroduces. So the media says so out loud, says what the order actually is, and
 * carries the press that cancels it.
 */
describe('components/media/ReleasePreferenceNote', () => {
	it('says what the order is, in the order it decides', async () => {
		const { wrapper } = mountWithApp(ReleasePreferenceNote, {
			props: {
				preference: {
					ranks: [
						{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p', '2160p'] },
						{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
					],
				},
			},
			global: { stubs: { ...tooltipStub } },
		});
		await nextTick();

		expect(wrapper.find('[data-test="release-preference-note-summary"]').text())
			.toContain('1080p › 2160p');
		expect(wrapper.find('[data-test="release-preference-note-summary"]').text())
			.toContain('x265');
	});

	it('names an order that separates nothing rather than showing an empty line', async () => {
		// Empty is a decision — "order by nothing, on purpose" — and a blank line would
		// read as a control that failed to load.
		const { wrapper } = mountWithApp(ReleasePreferenceNote, {
			props: { preference: { ranks: [] } },
			global: { stubs: { ...tooltipStub } },
		});
		await nextTick();

		expect(wrapper.find('[data-test="release-preference-note-none"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="release-preference-note-summary"]').exists()).toBe(false);
	});

	it('cancels from the line that states it, in one press', async () => {
		const { wrapper } = mountWithApp(ReleasePreferenceNote, {
			props: { preference: { ranks: [] } },
			global: { stubs: { ...tooltipStub } },
		});
		await nextTick();

		await wrapper.find('[data-test="release-preference-note-cancel"]').trigger('click');

		expect(wrapper.emitted('cancel')).toHaveLength(1);
	});
});

/**
 * Correcting a media from the list, which is where the mistake is visible.
 *
 * A documentary filed under Films is obvious on a wall and invisible on the media's own
 * page, and a mis-scraped folder produces a dozen of them. The row asks the page around
 * it to open the dialog — see `OPEN_OVERRIDE` — so a screen that owns no dialog simply
 * draws no action rather than a button that opens nothing.
 */
describe('correcting a media from the list', () => {
	const group = (): MediaGroup => ({
		id: 'g1',
		kind: MediaKind.MOVIE,
		title: 'Cosmos',
		normalizedTitle: 'cosmos',
		year: 1980,
		seasonNumber: null,
		episodeNumber: null,
		externalIds: {},
		overview: null,
		artworkItemId: null,
		sync: SyncState.MISSING,
		quality: null,
		sources: [],
		childCount: 0,
		missingCount: 0,
		versions: [],
		libraryId: 'l1',
		parentId: null,
		addedAt: null,
	});

	it('offers the action on a row and on a card when the page provides one', async () => {
		const opened: string[] = [];
		const provide = { [OPEN_OVERRIDE as symbol]: (itemId: string) => opened.push(itemId) };

		const row = mountWithApp(MediaGroupRow, {
			props: { group: group() },
			global: { provide, stubs: { ...tooltipStub } },
		});
		await row.wrapper.find('[data-test="media-row-override"]').trigger('click');

		const card = mountWithApp(MediaCard, {
			props: { group: group() },
			global: { provide, stubs: { ...tooltipStub } },
		});
		await card.wrapper.find('[data-test="media-card-override"]').trigger('click');

		expect(opened).toEqual(['g1', 'g1']);
	});

	it('draws no action at all where nothing would answer it', async () => {
		const row = mountWithApp(MediaGroupRow, {
			props: { group: group() },
			global: { stubs: { ...tooltipStub } },
		});
		const card = mountWithApp(MediaCard, {
			props: { group: group() },
			global: { stubs: { ...tooltipStub } },
		});
		await nextTick();

		expect(row.wrapper.find('[data-test="media-row-override"]').exists()).toBe(false);
		expect(card.wrapper.find('[data-test="media-card-override"]').exists()).toBe(false);
	});

	/*
	 * Erasing a field, and taking it back.
	 *
	 * Two journeys caught this and nothing here did: the eraser is an icon inside the
	 * input, and a click that reaches it has to reach the *state*, once. Toggling the
	 * wrong way, or not at all, is a decision somebody cannot undo from the screen that
	 * offered it.
	 */
	it('erases a field and takes it back, one press each way', async () => {
		const { wrapper } = mountDialog();
		await settle();

		expect(wrapper.find('[data-test="override-year-cleared"]').exists()).toBe(false);

		await press(wrapper.find('[data-test="override-year-clear"]'));
		await settle();

		expect(wrapper.find('[data-test="override-year-cleared"]').exists()).toBe(true);
		expect((wrapper.find('[data-test="override-year"] input').element as HTMLInputElement).value)
			.toBe('');

		await press(wrapper.find('[data-test="override-year-clear"]'));
		await settle();

		// Back to what the service said, which is what "not corrected" means.
		expect(wrapper.find('[data-test="override-year-cleared"]').exists()).toBe(false);
		expect((wrapper.find('[data-test="override-year"] input').element as HTMLInputElement).value)
			.toBe('1980');
	});
});
