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
	const mapping = { remoteRoot: '/media', localRoot: '/mnt/nas' };

	it('answers nothing when nobody stated a mapping', () => {
		// The service is a remote Jellyfin we merely have an account on: there is no
		// directory of ours behind it, and inventing one would point the gateway at a
		// path that does not exist.
		expect(derivedLocalPath(['/media/Shows'], { remoteRoot: null, localRoot: null })).toBeNull();
		expect(derivedLocalPath(['/media/Shows'], { remoteRoot: '/media', localRoot: null })).toBeNull();
		expect(derivedLocalPath(['/media/Shows'], { remoteRoot: null, localRoot: '/mnt/nas' })).toBeNull();
	});

	it('replaces the service root with ours', () => {
		expect(derivedLocalPath(['/media/Shows'], mapping)).toBe('/mnt/nas/Shows');
		expect(derivedLocalPath(['/media/Shows/Kids'], mapping)).toBe('/mnt/nas/Shows/Kids');
	});

	it('maps a library that is the root itself', () => {
		expect(derivedLocalPath(['/media'], mapping)).toBe('/mnt/nas');
	});

	it('refuses a path that does not sit under the root', () => {
		// `/mediacentre` starts with the same letters and is a different directory. A
		// prefix test on raw strings is how a transfer lands on the wrong disk.
		expect(derivedLocalPath(['/srv/Shows'], mapping)).toBeNull();
		expect(derivedLocalPath(['/mediacentre/Shows'], mapping)).toBeNull();
	});

	it('ignores trailing slashes on either side', () => {
		expect(derivedLocalPath(['/media/Shows/'], { remoteRoot: '/media/', localRoot: '/mnt/nas/' }))
			.toBe('/mnt/nas/Shows');
		expect(derivedLocalPath(['/media/'], { remoteRoot: '/media', localRoot: '/mnt/nas/' }))
			.toBe('/mnt/nas');
	});

	it('answers nothing for a library that reports no path at all', () => {
		expect(derivedLocalPath([], mapping)).toBeNull();
		expect(derivedLocalPath([''], mapping)).toBeNull();
	});

	it('takes the first reported path the mapping can answer for', () => {
		// Stable across scans: choosing among several would depend on the order the
		// service happened to list them in, and the gateway writes into one directory.
		expect(derivedLocalPath(['/srv/Extra', '/media/Shows', '/media/Films'], mapping))
			.toBe('/mnt/nas/Shows');
	});
});
