import type { DirectoryListing, Library, LibraryCheck, ServerStructure } from '@mcs/shared';
import { LibraryKind, PathMatch, ServerStructureSupport } from '@mcs/shared';
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

/** What a server answers about its own folders, in the shape the route returns. */
function structure (overrides: Partial<ServerStructure> = {}): ServerStructure {
	return {
		support: ServerStructureSupport.REPORTED,
		path: null,
		parent: null,
		entries: [
			{
				path: '/data/media/shows',
				name: 'shows',
				root: true,
				libraryExternalId: 'x',
				libraryName: 'Shows',
				directory: true,
			},
		],
		...overrides,
	};
}

function check (overrides: Partial<LibraryCheck> = {}): LibraryCheck {
	return {
		libraryId: 'l1',
		name: 'Shows',
		localPath: '/mnt/typed',
		derived: false,
		exists: true,
		readable: true,
		writable: true,
		freeBytes: 1000,
		serverPaths: ['/data/media/shows'],
		match: PathMatch.MATCHED,
		error: null,
		...overrides,
	};
}

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

describe('the two sides of the mapping', () => {
	it('shows what the server says, apart from what this gateway sees', async () => {
		// The server's paths are the authoritative half: it is the machine that
		// actually reads the files. Mixed into the browse they would read as folders
		// of ours, which is the mix-up the two fields exist to keep apart.
		stubFetchRoutes({
			'/api/services/s1/structure': { body: structure() },
			'/api/filesystem/directories': { body: listing() },
		});
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true, serviceId: 's1' },
			global: { stubs: dialogStub },
		});
		await settle();

		const server = wrapper.findAll('[data-test="browse-server-entry"]');

		expect(server).toHaveLength(1);
		expect(server[0].text()).toContain('/data/media/shows');
		// Named as the server's, and the library it belongs to is what places it.
		expect(server[0].text()).toContain('Shows');
		expect(wrapper.find('[data-test="browse-server"]').text()).toContain('server');
		// The browse is still there and still its own list: it is how somebody finds
		// the other side of the mapping when the two differ.
		expect(wrapper.find('[data-test="browse-gateway-title"]').exists()).toBe(true);
		expect(wrapper.findAll('[data-test="browse-entry"]').length).toBe(2);
	});

	it('takes a path the server reported as the value', async () => {
		stubFetchRoutes({
			'/api/services/s1/structure': { body: structure() },
			'/api/filesystem/directories': { body: listing() },
		});
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true, serviceId: 's1' },
			global: { stubs: dialogStub },
		});
		await settle();
		await wrapper.find('[data-test="browse-server-entry"]').trigger('click');
		await settle();

		expect(wrapper.emitted('choose')).toEqual([['/data/media/shows']]);
	});

	it('says so when the service has no way to tell us', async () => {
		// A peer always answers this, and so does a server whose build has no browse
		// route. Shown as an empty list, somebody would go looking for folders that
		// were never going to be reported.
		stubFetchRoutes({
			'/api/services/s1/structure': {
				body: structure({ support: ServerStructureSupport.UNSUPPORTED, entries: [] }),
			},
			'/api/filesystem/directories': { body: listing() },
		});
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true, serviceId: 's1' },
			global: { stubs: dialogStub },
		});
		await settle();

		expect(wrapper.find('[data-test="browse-server-unsupported"]').exists()).toBe(true);
		expect(wrapper.findAll('[data-test="browse-server-entry"]')).toHaveLength(0);
	});

	it('keeps the folders the server did report when it refuses to go deeper', async () => {
		// Plex is why this exists: its browse route answers happily and ignores the
		// folder asked for, so the handler reports that it cannot walk. Replacing the
		// roots with "cannot say" would take away the one thing the server answered
		// correctly, at the exact moment somebody asked it for more.
		let asked = 0;
		const fetched = stubFetchRoutes({
			'/api/services/s1/structure': { body: structure() },
			'/api/filesystem/directories': { body: listing() },
		});

		fetched.mockImplementation((input: unknown) => {
			const url = String(input);

			if (url.includes('/structure')) {
				asked += 1;

				return Promise.resolve(Response.json(
					asked === 1
						? structure()
						: structure({ support: ServerStructureSupport.UNSUPPORTED, entries: [] }),
				));
			}

			return Promise.resolve(Response.json(listing()));
		});

		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true, serviceId: 's1' },
			global: { stubs: dialogStub },
		});
		await settle();
		await wrapper.find('[data-test="browse-server-enter"]').trigger('click');
		await settle();

		expect(wrapper.findAll('[data-test="browse-server-entry"]')).toHaveLength(1);
		expect(wrapper.find('[data-test="browse-server-no-deeper"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="browse-server-unsupported"]').exists()).toBe(false);
	});

	it('shows nothing of the server when there is no service to ask', async () => {
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing() } });
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true },
			global: { stubs: dialogStub },
		});
		await settle();

		expect(wrapper.find('[data-test="browse-server"]').exists()).toBe(false);
	});

	it('keeps browsing when the server cannot be reached at all', async () => {
		// The browse is the fallback this assist has always had; a server that is
		// asleep must not stop somebody typing the path they already know.
		stubFetchRoutes({
			'/api/services/s1/structure': { status: 503, body: { message: 'error.service.unreachable' } },
			'/api/filesystem/directories': { body: listing() },
		});
		const { wrapper } = mountWithApp(DirectoryPicker, {
			props: { modelValue: true, serviceId: 's1' },
			global: { stubs: dialogStub },
		});
		await settle();

		expect(wrapper.findAll('[data-test="browse-entry"]').length).toBe(2);
		expect(wrapper.find('[data-test="browse-error"]').exists()).toBe(false);
		// And the section goes away rather than claiming the server reported nothing.
		expect(wrapper.find('[data-test="browse-server"]').exists()).toBe(false);
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

	it('reports the two paths that are not the same directory, naming both', async () => {
		// The failure nothing else on the screen can report: the path exists, is
		// readable and is writable, and the server still reads somewhere else. The two
		// strings are legitimately different, so seeing them side by side is the only
		// thing somebody can act on.
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing() } });
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library, check: check({ match: PathMatch.MISMATCHED }) },
			global: { stubs: dialogStub },
		});
		await settle();

		const alert = wrapper.find('[data-test="library-mismatch"]');

		expect(alert.exists()).toBe(true);
		expect(alert.text()).toContain('/mnt/typed');
		expect(alert.text()).toContain('/data/media/shows');
		// Nothing else is wrong with it, which is exactly why this has to be said.
		expect(wrapper.find('[data-test="library-problem"]').exists()).toBe(false);
	});

	it('says nothing when the server confirms it reads the same directory', async () => {
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing() } });
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library, check: check() },
			global: { stubs: dialogStub },
		});
		await settle();

		expect(wrapper.find('[data-test="library-mismatch"]').exists()).toBe(false);
	});

	it('hands the picker the service, so it can ask where its own folders are', async () => {
		stubFetchRoutes({ '/api/filesystem/directories': { body: listing() } });
		const { wrapper } = mountWithApp(LibraryPathField, {
			props: { library },
			global: { stubs: dialogStub },
		});

		expect(wrapper.findComponent(DirectoryPicker).props('serviceId')).toBe('s1');
		expect(wrapper.findComponent(DirectoryPicker).props('libraryExternalId')).toBe('x');
	});
});
