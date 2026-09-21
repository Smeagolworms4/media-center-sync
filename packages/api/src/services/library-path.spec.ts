import { ErrorKey, findRootMappingFault, normaliseRootPath } from '@mcs/shared';
import { derivedLocalPath, toLocalPath } from './library-path';

describe('toLocalPath', () => {
	const library = { paths: ['/media/shows'], localPath: '/mnt/nas/shows' };

	it('rewrites a reported root into the one the gateway can reach', () => {
		expect(toLocalPath(library, '/media/shows/Show/Season 01/a.mkv')).toBe(
			'/mnt/nas/shows/Show/Season 01/a.mkv',
		);
	});

	it('maps the root itself', () => {
		expect(toLocalPath(library, '/media/shows')).toBe('/mnt/nas/shows');
	});

	it('refuses a path outside every declared root', () => {
		// A prefix guessed here is a read outside the library, and the caller cannot
		// tell the difference between a wrong answer and no answer.
		expect(toLocalPath(library, '/media/other/a.mkv')).toBeNull();
		expect(toLocalPath(library, '/media/showsy/a.mkv')).toBeNull();
	});

	it('answers null when nobody told us where the library is', () => {
		expect(toLocalPath({ paths: ['/media/shows'], localPath: null }, '/media/shows/a.mkv'))
			.toBeNull();
	});

	it('picks the root that actually matches, among several', () => {
		const multi = { paths: ['/media/a', '/media/b'], localPath: '/mnt/x' };

		expect(toLocalPath(multi, '/media/b/deep/file.mkv')).toBe('/mnt/x/deep/file.mkv');
	});
});

describe('derivedLocalPath', () => {
	const one = (remoteRoot: string, localRoot: string) => ({ rootMappings: [{ remoteRoot, localRoot }] });
	const single = one('/media', '/mnt/nas');

	it('answers nothing when nobody stated a mapping', () => {
		// The service is a remote Jellyfin we merely have an account on: there is no
		// directory of ours behind it, and inventing one would point the gateway at a
		// path that does not exist.
		expect(derivedLocalPath(['/media/Shows'], { rootMappings: [] })).toBeNull();
	});

	it('replaces the server prefix with ours', () => {
		expect(derivedLocalPath(['/media/Shows'], single)).toBe('/mnt/nas/Shows');
		expect(derivedLocalPath(['/media/Shows/Kids'], single)).toBe('/mnt/nas/Shows/Kids');
	});

	it('maps a library that is the prefix itself', () => {
		expect(derivedLocalPath(['/media'], single)).toBe('/mnt/nas');
	});

	it('compares components, never letters', () => {
		// `/mediacentre` starts with the same letters and is a different directory. A
		// prefix test on raw strings is how a transfer lands on the wrong disk.
		expect(derivedLocalPath(['/srv/Shows'], single)).toBeNull();
		expect(derivedLocalPath(['/mediacentre/Shows'], single)).toBeNull();
		expect(derivedLocalPath(['/data/movies2'], one('/data/movies', '/mnt/nas1/movies'))).toBeNull();
	});

	it('ignores trailing and doubled slashes on every side', () => {
		expect(derivedLocalPath(['/media/Shows/'], one('/media/', '/mnt/nas/'))).toBe('/mnt/nas/Shows');
		expect(derivedLocalPath(['/media/'], one('/media', '/mnt/nas/'))).toBe('/mnt/nas');
		expect(derivedLocalPath(['//media//Shows'], one('/media', '/mnt//nas'))).toBe('/mnt/nas/Shows');
	});

	it('sends each library to the disk it is on', () => {
		// The case one pair could not describe: two disks with nothing in common but
		// `/`, where any single mapping is wrong for one of the two libraries.
		const service = {
			rootMappings: [
				{ remoteRoot: '/data/movies', localRoot: '/mnt/nas1/movies' },
				{ remoteRoot: '/srv/shows', localRoot: '/mnt/nas2/shows' },
			],
		};

		expect(derivedLocalPath(['/data/movies'], service)).toBe('/mnt/nas1/movies');
		expect(derivedLocalPath(['/srv/shows/Kids'], service)).toBe('/mnt/nas2/shows/Kids');
		// Under neither: nothing derived, rather than a guess at the closer one.
		expect(derivedLocalPath(['/opt/music'], service)).toBeNull();
	});

	it('lets the most specific of nested prefixes win, whatever the order of the rows', () => {
		// `/data` on the NAS, `/data/4k` on a faster disk: a film under `/data/4k` sent
		// to the NAS directory that merely shares its parent would be a film the server
		// never sees.
		const nested = [
			{ remoteRoot: '/data', localRoot: '/mnt/nas' },
			{ remoteRoot: '/data/4k', localRoot: '/mnt/fast' },
		];

		for (const rootMappings of [nested, nested.toReversed()]) {
			expect(derivedLocalPath(['/data/4k/Films'], { rootMappings })).toBe('/mnt/fast/Films');
			expect(derivedLocalPath(['/data/4k'], { rootMappings })).toBe('/mnt/fast');
			expect(derivedLocalPath(['/data/Films'], { rootMappings })).toBe('/mnt/nas/Films');
			expect(derivedLocalPath(['/data/4kids'], { rootMappings })).toBe('/mnt/nas/4kids');
		}
	});

	it('takes the server root itself as a prefix of everything', () => {
		// Somebody who says the server's whole filesystem is mounted at one place has
		// said exactly that; a more specific row still wins over it.
		const rootMappings = [
			{ remoteRoot: '/', localRoot: '/mnt/host' },
			{ remoteRoot: '/data', localRoot: '/mnt/nas' },
		];

		expect(derivedLocalPath(['/srv/shows'], { rootMappings })).toBe('/mnt/host/srv/shows');
		expect(derivedLocalPath(['/data/shows'], { rootMappings })).toBe('/mnt/nas/shows');
	});

	it('refuses a reported path that climbs out of its prefix, or is not absolute', () => {
		// Rewriting `/media/../etc` would name a directory the mapping never declared.
		expect(derivedLocalPath(['/media/../etc'], single)).toBeNull();
		expect(derivedLocalPath(['/media/./Shows'], single)).toBeNull();
		// A Plex on Windows answers `D:\Media`, which no POSIX prefix designates.
		expect(derivedLocalPath(['D:\\Media\\Shows', 'media/Shows'], single)).toBeNull();
	});

	it('skips a mapping whose gateway side is empty rather than deriving the filesystem root', () => {
		expect(derivedLocalPath(['/media/Shows'], one('/media', '  '))).toBeNull();
	});

	it('answers nothing for a library that reports no path at all', () => {
		expect(derivedLocalPath([], single)).toBeNull();
		expect(derivedLocalPath([''], single)).toBeNull();
	});

	it('takes the first reported path the mappings can answer for', () => {
		// Stable across scans: choosing among several would depend on the order the
		// service happened to list them in, and the gateway writes into one directory.
		expect(derivedLocalPath(['/srv/Extra', '/media/Shows', '/media/Films'], single))
			.toBe('/mnt/nas/Shows');
	});
});

/**
 * The refusals, from the one function the API and the form both run.
 *
 * Pinned here because the API is where a wrong answer costs something: the form only
 * says it sooner.
 */
describe('findRootMappingFault', () => {
	const pair = (remoteRoot: string, localRoot: string) => ({ remoteRoot, localRoot });

	it('accepts nothing at all, and accepts nested prefixes', () => {
		expect(findRootMappingFault([])).toBeNull();
		expect(findRootMappingFault([pair('/data', '/mnt/nas'), pair('/data/4k', '/mnt/fast')])).toBeNull();
		// Two server paths onto one directory: one share the server reaches two ways.
		expect(findRootMappingFault([pair('/a', '/mnt/nas'), pair('/b', '/mnt/nas')])).toBeNull();
	});

	it('names the side left empty', () => {
		expect(findRootMappingFault([pair('/data', '/mnt/nas'), pair('  ', '/mnt/x')]))
			.toEqual({ index: 1, side: 'remoteRoot', key: ErrorKey.SERVICE_MAPPING_EMPTY });
		expect(findRootMappingFault([pair('/data', '')]))
			.toEqual({ index: 0, side: 'localRoot', key: ErrorKey.SERVICE_MAPPING_EMPTY });
	});

	it('names the side that is not absolute', () => {
		expect(findRootMappingFault([pair('/data', 'mnt/nas')]))
			.toEqual({ index: 0, side: 'localRoot', key: ErrorKey.SERVICE_MAPPING_RELATIVE });
		expect(findRootMappingFault([pair('D:\\Media', '/mnt/nas')]))
			.toEqual({ index: 0, side: 'remoteRoot', key: ErrorKey.SERVICE_MAPPING_RELATIVE });
	});

	it('names the second of two rows claiming one server prefix, however it is spelled', () => {
		expect(findRootMappingFault([pair('/data/', '/mnt/a'), pair('/x', '/mnt/x'), pair('//data', '/mnt/b')]))
			.toEqual({ index: 2, side: 'remoteRoot', key: ErrorKey.SERVICE_MAPPING_DUPLICATE });
	});
});

describe('normaliseRootPath', () => {
	it('folds trailing and doubled slashes, and keeps the root a root', () => {
		expect(normaliseRootPath(' /data//movies/ ')).toBe('/data/movies');
		expect(normaliseRootPath('/')).toBe('/');
		expect(normaliseRootPath('///')).toBe('/');
	});

	it('only trims what is not absolute, so a refusal quotes what was typed', () => {
		expect(normaliseRootPath(' media/ ')).toBe('media/');
	});
});
