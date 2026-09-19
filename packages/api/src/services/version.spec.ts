import type { MediaFileInfo } from '@mcs/shared';
import { editionInPath, editionOf, versionIdOf } from './version';

function file(overrides: Partial<MediaFileInfo> = {}): MediaFileInfo {
	return {
		path: '/media/Films/Titanic (1997)/Titanic (1997).mkv',
		size: 12_000_000_000,
		container: 'mkv',
		videoCodec: 'x265',
		audioCodec: 'eac3',
		width: 3840,
		height: 2160,
		durationMs: 11_640_000,
		bitrate: 8_000_000,
		quickHash: 'abc',
		contentId: 'q1-abc',
		checksum: null,
		...overrides,
	};
}

describe('version identity', () => {
	it('is the content identifier the fingerprint already produced', () => {
		// Not a hash of a hash: the same file on two gateways has to come out with the
		// same version without the two ever speaking, and that is exactly what the
		// content identifier is. A second scheme would be a second spelling.
		expect(versionIdOf(file())).toBe('q1-abc');
	});

	it.each([
		['no file at all', null],
		['a file nobody fingerprinted', file({ contentId: null })],
		['a file whose identifier came back empty', file({ contentId: '' })],
	])('says nothing about %s rather than inventing one', (_name, value) => {
		// Null is the answer, and an important one: a per-row identity would make the
		// one file three friends hold look like three versions to download.
		expect(versionIdOf(value)).toBeNull();
	});

	describe('edition', () => {
		it('takes the label the service reported', () => {
			expect(editionOf(file({ edition: 'Director’s Cut' }))).toBe('Director’s Cut');
		});

		it('reads the tag both media servers write, whichever brackets were used', () => {
			expect(editionInPath('/films/Titanic (1997) {edition-Extended Cut}.mkv')).toBe(
				'Extended Cut',
			);
			expect(editionInPath('/films/Titanic (1997) [edition-Theatrical].mkv')).toBe('Theatrical');
		});

		it('prefers what the service said over what the filename says', () => {
			// Plex knows its own editions; a filename is what is left when nothing else
			// answers, and a library that carries both can disagree with itself.
			expect(
				editionOf(file({ edition: 'Extended', path: '/films/Titanic {edition-Theatrical}.mkv' })),
			).toBe('Extended');
		});

		it.each([
			'/films/Titanic (1997) - Extended Cut.mkv',
			'/films/Titanic.1997.EXTENDED.1080p.BluRay.x264-GROUP.mkv',
			'/films/Titanic (1997).mkv',
		])('reads no edition out of %s', (path) => {
			// Deliberately not guessed. `- Extended Cut` cannot be told from an episode
			// title or a release tag, and a wrong guess here is written into a filename.
			expect(editionOf(file({ path }))).toBeNull();
		});

		it('ignores an empty label, which is how both services spell "none"', () => {
			expect(editionOf(file({ edition: '   ', path: '/films/Titanic.mkv' }))).toBeNull();
		});
	});
});
