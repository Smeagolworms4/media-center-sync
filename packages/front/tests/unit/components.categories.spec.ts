import type { Library, MediaCategory, SharePolicy } from '@mcs/shared';
import { LibraryKind, ShareVisibility } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import CategoryList from '@/components/library/CategoryList.vue';
import LibraryNameField from '@/components/library/LibraryNameField.vue';
import ShareRateSummary from '@/components/share/ShareRateSummary.vue';
import { mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/**
 * The local name, the order, and the caps — the three settings whose effect
 * happens somewhere other than where they are typed.
 */
async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

function library (overrides: Partial<Library> = {}): Library {
	return {
		id: 'l1',
		serviceId: 's1',
		externalId: 'x',
		name: 'Video2',
		alias: null,
		position: 3,
		kind: LibraryKind.SHOWS,
		paths: ['/data/video2'],
		localPath: '/media/video2',
		writable: true,
		isDefaultTarget: false,
		itemCount: 12,
		lastScanAt: null,
		lastRefreshAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function category (overrides: Partial<MediaCategory> = {}): MediaCategory {
	return {
		key: 'shows',
		name: 'Shows',
		kind: LibraryKind.SHOWS,
		position: 0,
		libraryIds: ['l1', 'l9'],
		serviceIds: ['s1', 's2'],
		itemCount: 30,
		local: true,
		...overrides,
	};
}

describe('components/library/LibraryNameField', () => {
	it('saves the local name and the order in one call', async () => {
		const stub = stubFetchRoutes({
			'/api/libraries/l1': { body: library({ alias: 'Animes', position: 1 }) },
			'/api/libraries/check': { body: [] },
		});
		const { wrapper } = mountWithApp(LibraryNameField, {
			props: { library: library(), category: category() },
			global: { stubs: { ...tooltipStub } },
		});

		await wrapper.find('[data-test="library-alias"] input').setValue('Animes');
		await wrapper.find('[data-test="library-position"] input').setValue('1');
		await wrapper.find('form').trigger('submit');
		await settle();

		const patch = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PATCH');
		expect(patch?.[0]).toBe('/api/libraries/l1');
		expect(JSON.parse(patch?.[1].body as string)).toEqual({ alias: 'Animes', position: 1 });
	});

	it('reads an emptied alias as no alias, which puts the service name back', async () => {
		const stub = stubFetchRoutes({
			'/api/libraries/l1': { body: library() },
			'/api/libraries/check': { body: [] },
		});
		const { wrapper } = mountWithApp(LibraryNameField, {
			props: { library: library({ alias: 'Animes' }), category: category() },
			global: { stubs: { ...tooltipStub } },
		});

		await wrapper.find('[data-test="library-alias"] input').setValue('');
		await wrapper.find('form').trigger('submit');
		await settle();

		const patch = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PATCH');
		expect(JSON.parse(patch?.[1].body as string).alias).toBeNull();
	});

	it('says which category the library lands in, and what it merged with', () => {
		const { wrapper } = mountWithApp(LibraryNameField, {
			props: { library: library(), category: category() },
			global: { stubs: { ...tooltipStub } },
		});

		// Aliasing one of two identically named libraries is how somebody separates
		// them on purpose, so what the merge currently does has to be on screen.
		expect(wrapper.find('[data-test="library-category"]').text()).toContain('Shows');
		expect(wrapper.find('[data-test="library-category"]').text())
			.toContain('merged with 1 other library of that name');
	});

	it('says when a library is a category on its own', () => {
		const { wrapper } = mountWithApp(LibraryNameField, {
			props: { library: library(), category: category({ libraryIds: ['l1'] }) },
			global: { stubs: { ...tooltipStub } },
		});

		expect(wrapper.find('[data-test="library-category"]').text()).toContain('its own category');
	});

	it('keeps the name the service reports in sight once an alias hides it', () => {
		const { wrapper } = mountWithApp(LibraryNameField, {
			props: { library: library({ alias: 'Animes' }), category: category() },
			global: { stubs: { ...tooltipStub } },
		});

		expect(wrapper.find('[data-test="library-reported-name"]').text()).toContain('Video2');
	});
});

describe('components/library/CategoryList', () => {
	it('shows the categories in the order they will appear', () => {
		const { wrapper } = mountWithApp(CategoryList, {
			props: {
				categories: [
					category({ key: 'films', name: 'Films', position: 0 }),
					category({ key: 'shows', name: 'Shows', position: 2 }),
				],
			},
		});

		const rows = wrapper.findAll('[data-test="category-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0].text()).toContain('Films');
		expect(rows[0].text()).toContain('2 libraries');
		expect(rows[1].text()).toContain('Shows');
	});

	it('explains an empty list rather than showing nothing', () => {
		const { wrapper } = mountWithApp(CategoryList, { props: { categories: [] } });

		expect(wrapper.find('[data-test="category-list-empty"]').exists()).toBe(true);
	});
});

function policy (overrides: Partial<SharePolicy> = {}): SharePolicy {
	return {
		id: 'sp1',
		libraryId: 'l1',
		libraryName: 'Films',
		serviceId: 's1',
		visibility: ShareVisibility.FRIENDS,
		overridden: true,
		allowedPeerIds: [],
		deniedPeerIds: [],
		rateLimit: 0,
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('components/share/ShareRateSummary', () => {
	it('says plainly when nothing is throttled', () => {
		const { wrapper } = mountWithApp(ShareRateSummary, {
			props: { uploadRateLimit: 0, policies: [policy()] },
		});

		expect(wrapper.text()).toContain('No global upload cap');
		expect(wrapper.text()).toContain('No library caps what it serves on its own.');
	});

	it('names the cap in force and the libraries that add one of their own', () => {
		// A throttled gateway that looks unthrottled is the support question this
		// block exists to prevent.
		const { wrapper } = mountWithApp(ShareRateSummary, {
			props: {
				uploadRateLimit: 2 * 1024 ** 2,
				policies: [policy(), policy({ id: 'sp2', libraryName: 'Shows', rateLimit: 512 * 1024 })],
			},
		});

		expect(wrapper.text()).toContain('capped at');
		const rows = wrapper.findAll('[data-test="share-rate-library"]');
		expect(rows).toHaveLength(1);
		expect(rows[0].text()).toContain('Shows');
	});
});
