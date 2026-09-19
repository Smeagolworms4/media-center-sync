import { detectCompanions, missingCompanions } from './companions';

const MEDIA = 'The Expanse - S01E02 - The Big Empty.mkv';

describe('detectCompanions', () => {
	it('finds a description named after the file', () => {
		const found = detectCompanions([MEDIA, 'The Expanse - S01E02 - The Big Empty.nfo'], MEDIA);

		expect(found.nfo).toBe(true);
	});

	it('finds a description that belongs to the folder', () => {
		// Both servers read `tvshow.nfo` and `movie.nfo` from the directory rather than
		// from a file named after the media, and a library filed that way is complete.
		expect(detectCompanions([MEDIA, 'tvshow.nfo'], MEDIA).nfo).toBe(true);
		expect(detectCompanions([MEDIA, 'movie.nfo'], MEDIA).nfo).toBe(true);
	});

	it('finds the artwork under any of the names a server accepts', () => {
		expect(detectCompanions([MEDIA, 'poster.jpg'], MEDIA).poster).toBe(true);
		expect(detectCompanions([MEDIA, 'folder.png'], MEDIA).poster).toBe(true);
		expect(detectCompanions([MEDIA, 'fanart.jpg'], MEDIA).fanart).toBe(true);
	});

	it('counts subtitles whatever language or flag they carry', () => {
		// A subtitle carries a language and often a flag, so anything starting with the
		// media's name counts. Matching exactly would report a subtitled episode as bare.
		const found = detectCompanions(
			[
				MEDIA,
				'The Expanse - S01E02 - The Big Empty.en.srt',
				'The Expanse - S01E02 - The Big Empty.fr.forced.srt',
				'The Expanse - S01E02 - The Big Empty.ass',
			],
			MEDIA,
		);

		expect(found.subtitles).toBe(3);
	});

	it('does not claim somebody else s artwork', () => {
		// A poster named after another episode is that episode's. Claiming it would
		// report a complete item that is not one, which is worse than reporting nothing.
		const found = detectCompanions([MEDIA, 'The Expanse - S01E03 - Remember the Cant-poster.jpg'], MEDIA);

		expect(found.poster).toBe(false);
	});

	it('reports an empty folder as empty rather than unknown', () => {
		const found = detectCompanions([MEDIA], MEDIA);

		expect(found).toMatchObject({ nfo: false, poster: false, fanart: false, subtitles: 0 });
		expect(found.checkedAt).not.toBeNull();
	});
});

describe('missingCompanions', () => {
	const full = { nfo: true, poster: true, fanart: true, subtitles: 2, missing: [], checkedAt: null };
	const bare = { nfo: false, poster: false, fanart: false, subtitles: 0, missing: [], checkedAt: null };

	it('names the roles the other side has and this one does not', () => {
		expect(missingCompanions(bare, full)).toEqual(['nfo', 'poster', 'fanart', 'subtitles']);
	});

	it('says nothing when the other side is not richer', () => {
		expect(missingCompanions(full, bare)).toEqual([]);
		expect(missingCompanions(full, full)).toEqual([]);
	});

	it('says nothing at all when the other side was never inspected', () => {
		// Absence of knowledge is not knowledge of absence, and reporting it as missing
		// would have the interface offer to fetch companions nobody knows exist.
		expect(missingCompanions(bare, null)).toEqual([]);
	});

	it('treats never-inspected here as having nothing', () => {
		expect(missingCompanions(null, full)).toEqual(['nfo', 'poster', 'fanart', 'subtitles']);
	});
});
