import { toLocalPath } from './library-path';

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
