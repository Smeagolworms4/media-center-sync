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
});
