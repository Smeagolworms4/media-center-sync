import { LibraryKind } from '@mcs/shared';
import { serverNameOf, serverParentOf, serverRootsOf } from './server-path';

describe('reading a path that belongs to somebody else’s machine', () => {
	describe('serverNameOf', () => {
		it('takes the last segment of a POSIX path', () => {
			expect(serverNameOf('/data/media/shows')).toBe('shows');
		});

		it('takes the last segment of a Windows path, which node:path would not', () => {
			// `posix.basename('D:\\Media\\Shows')` answers the whole string, and a Plex
			// on Windows would show one unreadable row instead of a folder name.
			expect(serverNameOf('D:\\Media\\Shows')).toBe('Shows');
		});

		it('ignores a trailing separator rather than answering nothing', () => {
			expect(serverNameOf('/data/media/shows/')).toBe('shows');
		});

		it('answers the path itself for a root, so no row is unlabelled', () => {
			expect(serverNameOf('/')).toBe('/');
		});
	});

	describe('serverParentOf', () => {
		it('cuts one level off a POSIX path', () => {
			expect(serverParentOf('/data/media/shows')).toBe('/data/media');
		});

		it('cuts one level off a Windows path', () => {
			expect(serverParentOf('D:\\Media\\Shows')).toBe('D:\\Media');
		});

		it('answers the root rather than the empty string one level under it', () => {
			expect(serverParentOf('/media')).toBe('/');
		});

		it('answers nothing when there is nowhere left to go', () => {
			expect(serverParentOf('/')).toBeNull();
			expect(serverParentOf('shows')).toBeNull();
		});
	});

	describe('serverRootsOf', () => {
		const libraries = [
			{
				externalId: 'folder-1',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/data/shows', '/data/anime'],
			},
			{ externalId: 'folder-2', name: 'Films', kind: LibraryKind.MOVIES, paths: ['/data/films'] },
		];

		it('gives one row per declared path, labelled with the library it belongs to', () => {
			// A shelf split across two mounts is two directories somebody may have to
			// map separately, and a row with no library name is a path nobody can place.
			expect(serverRootsOf(libraries)).toEqual([
				{
					path: '/data/shows',
					name: 'shows',
					root: true,
					libraryExternalId: 'folder-1',
					libraryName: 'Shows',
					directory: true,
				},
				{
					path: '/data/anime',
					name: 'anime',
					root: true,
					libraryExternalId: 'folder-1',
					libraryName: 'Shows',
					directory: true,
				},
				{
					path: '/data/films',
					name: 'films',
					root: true,
					libraryExternalId: 'folder-2',
					libraryName: 'Films',
					directory: true,
				},
			]);
		});

		it('keeps only the library that was asked for', () => {
			expect(serverRootsOf(libraries, 'folder-2').map((entry) => entry.path)).toEqual([
				'/data/films',
			]);
		});

		it('answers nothing for a library the service reports no path for', () => {
			// A peer's libraries are exactly this case, and an empty list is the honest
			// answer: their files are on their disk.
			expect(
				serverRootsOf([
					{ externalId: 'shared', name: 'Shared', kind: LibraryKind.OTHER, paths: [] },
				]),
			).toEqual([]);
		});
	});
});
