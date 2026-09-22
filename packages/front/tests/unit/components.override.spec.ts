import type { Library, MediaItem } from '@mcs/shared';
import { LibraryKind, MediaKind, SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import OverrideDialog from '@/components/media/OverrideDialog.vue';
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

const documentaries: Library = { ...library, id: 'l2', name: 'Documentaries', isDefaultTarget: false };

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

function mountDialog (node: MediaItem = item()) {
	const stub = stubFetchRoutes({
		'/api/media/m1/override': { body: { ...node, overrides: null, reported: null } },
		'/api/media/m1': { body: node },
		'/api/libraries': { body: [library, documentaries] },
		'/api/services': { body: [] },
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
		await wrapper.find('[data-test="override-year"] .v-field__append-inner .v-icon').trigger('click');
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
});
