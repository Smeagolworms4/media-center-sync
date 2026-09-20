import type { DirectoryListing, Library } from '@mcs/shared';
import { LibraryKind } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
import LibraryPathField from '@/components/library/LibraryPathField.vue';
import { dialogStub, mountWithApp, stubFetchRoutes } from './helpers';

/**
 * The folder browser, and the one rule it must never break.
 *
 * The field is the input and stays authoritative: a path on a mount that is not
 * attached yet cannot be browsed to and is a legitimate thing to type. So the dialog
 * writes into the field when somebody chooses, and leaves whatever was typed exactly
 * as it was when they change their mind.
 */
async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

function listing (overrides: Partial<DirectoryListing> = {}): DirectoryListing {
	return {
		path: '/media',
		parent: null,
		readable: true,
		writable: true,
		entries: [
			{ name: 'Shows', path: '/media/Shows', readable: true, writable: true },
			{ name: 'Archive', path: '/media/Archive', readable: true, writable: false },
		],
		truncated: false,
		limit: 500,
		roots: ['/media'],
		...overrides,
	};
}

const library: Library = {
	id: 'l1',
	serviceId: 's1',
	externalId: 'x',
	name: 'Shows',
	alias: null,
	position: 0,
	kind: LibraryKind.SHOWS,
	paths: ['/data/shows'],
	localPath: '/mnt/typed',
	writable: true,
	isDefaultTarget: false,
	itemCount: 10,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('components/common/DirectoryPicker', () => {
	it('lists the directories it was opened on', async () => {
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing() } });
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true, path: '/media' },
			global: { stubs: dialogStub },
		});
		await settle();

		const names = wrapper.findAll('[data-test="browse-entry"]').map(entry => entry.text());
		expect(names.join(' ')).toContain('Shows');
		expect(names.join(' ')).toContain('Archive');
	});

	it('says when the listing was capped, so a short list is not read as a complete one', async () => {
		stubFetchRoutes({
			'/api/filesystem/directories': { body: listing({ truncated: true, limit: 2 }) },
		});
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true },
			global: { stubs: dialogStub },
		});
		await settle();

		expect(wrapper.find('[data-test="browse-truncated"]').text()).toContain('2');
	});

	it('refuses to offer a folder the gateway cannot write into', async () => {
		// Offering one would put a path in the field that looks chosen rather than
		// typed, and the transfer that lands nowhere is the same silent failure with
		// more confidence behind it.
		stubFetchRoutes({
			'/api/filesystem/directories': { body: listing({ writable: false }) },
		});
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true },
			global: { stubs: dialogStub },
		});
		await settle();

		expect(wrapper.find('[data-test="browse-unwritable"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="browse-choose"]').attributes('disabled')).toBeDefined();
	});

	it('falls back to a root when the path it was opened on is refused', async () => {
		// A field can hold anything at all — an unmounted disk, a path outside the
		// roots — and opening the browser on that refusal is a browser that refuses to
		// browse.
		const fetched = stubFetchRoutes({
			'/api/filesystem/directories?path=%2Fnowhere': {
				status: 403,
				body: { message: 'error.filesystem.path_outside_root' },
			},
			'/api/filesystem/directories': { body: listing() },
		});
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true, path: '/nowhere' },
			global: { stubs: dialogStub },
		});
		await settle();

		expect(fetched.mock.calls.length).toBeGreaterThan(1);
		expect(wrapper.find('[data-test="browse-error"]').exists()).toBe(false);
		expect(wrapper.findAll('[data-test="browse-entry"]').length).toBe(2);
	});

	it('reports a refusal of a step somebody actually clicked', async () => {
		stubFetchRoutes({
			'/api/filesystem/directories?path=%2Fmedia%2FShows': {
				status: 403,
				body: { message: 'error.filesystem.path_outside_root' },
			},
			'/api/filesystem/directories': { body: listing() },
		});

		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true },
			global: { stubs: dialogStub },
		});
		await settle();
		await wrapper.findAll('[data-test="browse-entry"]')[0].trigger('click');
		await settle();

		expect(wrapper.find('[data-test="browse-error"]').text()).toContain('outside');
	});
});

describe('components/library/LibraryPathField', () => {
	it('opens the browser from the icon on the field', async () => {
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing() } });
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library },
			global: { stubs: dialogStub },
		});

		expect(wrapper.findComponent(DirectoryPicker).props('modelValue')).toBe(false);

		await wrapper.find('[data-test="library-path"] .mdi-folder-search-outline').trigger('click');
		await settle();

		expect(wrapper.findComponent(DirectoryPicker).props('modelValue')).toBe(true);
	});

	it('writes the chosen folder into the field', async () => {
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing({ path: '/media/Shows' }) } });
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library },
			global: { stubs: dialogStub },
		});

		await wrapper.find('[data-test="library-path"] .mdi-folder-search-outline').trigger('click');
		await settle();
		await wrapper.find('[data-test="browse-choose"]').trigger('click');
		await settle();

		const input = wrapper.find('[data-test="library-path"] input').element as HTMLInputElement;
		expect(input.value).toBe('/media/Shows');
	});

	it('leaves the typed path alone when the browser is cancelled', async () => {
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing({ path: '/media/Shows' }) } });
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library },
			global: { stubs: dialogStub },
		});

		await wrapper.find('[data-test="library-path"] .mdi-folder-search-outline').trigger('click');
		await settle();
		await wrapper.find('[data-test="browse-cancel"]').trigger('click');
		await settle();

		const input = wrapper.find('[data-test="library-path"] input').element as HTMLInputElement;
		expect(input.value).toBe('/mnt/typed');
		expect(wrapper.findComponent(DirectoryPicker).props('modelValue')).toBe(false);
	});
});
