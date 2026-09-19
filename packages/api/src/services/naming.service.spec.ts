import { MediaKind, NamingScheme } from '@mcs/shared';
import { NamingService, type NameableItem } from './naming.service';

function episode(overrides: Partial<NameableItem> = {}): NameableItem {
	return {
		kind: MediaKind.EPISODE,
		title: 'Back to the Butcher',
		seriesTitle: 'The Expanse',
		year: 2015,
		seasonNumber: 1,
		episodeNumber: 2,
		sourcePath: '/media/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv',
		...overrides,
	};
}

function movie(overrides: Partial<NameableItem> = {}): NameableItem {
	return {
		kind: MediaKind.MOVIE,
		title: 'Blade Runner',
		year: 1982,
		seasonNumber: null,
		episodeNumber: null,
		sourcePath: '/media/Blade.Runner.1982.2160p.mkv',
		...overrides,
	};
}

describe('NamingService', () => {
	const service = new NamingService();

	describe('SOURCE', () => {
		it('keeps the name the source used, ugly as it is, and still files it', () => {
			// The name is the source's; the folders are not negotiable. A library whose
			// episodes land in its root is not a library, and both media servers read
			// the season from the folder when the filename is ambiguous.
			expect(service.render(NamingScheme.SOURCE, episode())).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv',
			);
		});

		it('imitates the folders the library already uses, spelling and all', () => {
			// Inferring a template is how a season ends up split across two folders
			// differing by a space. An existing file is taken literally instead.
			const rendered = service.render(NamingScheme.SOURCE, episode({ seasonNumber: 2 }), {
				libraryRoot: '/media/shows',
				siblingPath: '/media/shows/The Expanse/Saison 1/whatever.mkv',
			});

			expect(rendered).toBe('The Expanse/Saison 2/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv');
		});

		it('keeps the padding the library uses for its seasons', () => {
			const rendered = service.render(NamingScheme.SOURCE, episode({ seasonNumber: 2 }), {
				libraryRoot: '/media/shows',
				siblingPath: '/media/shows/The Expanse (2015)/Season 01/whatever.mkv',
			});

			expect(rendered).toContain('The Expanse (2015)/Season 02/');
		});

		it('leaves a library that files a whole show in one folder alone', () => {
			const rendered = service.render(NamingScheme.SOURCE, episode({ seasonNumber: 3 }), {
				libraryRoot: '/media/shows',
				siblingPath: '/media/shows/The Expanse/whatever.mkv',
			});

			expect(rendered).toBe('The Expanse/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv');
		});

		it('ignores a sibling that is not inside the destination library', () => {
			// Following it would write outside the root, and it says nothing about how
			// this library is organised.
			const rendered = service.render(NamingScheme.SOURCE, episode(), {
				libraryRoot: '/media/shows',
				siblingPath: '/somewhere/else/The Expanse/Season 01/whatever.mkv',
			});

			expect(rendered).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv',
			);
		});

		it('falls back to the standard scheme when there is no source name to keep', () => {
			expect(service.render(NamingScheme.SOURCE, episode({ sourcePath: null }))).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher',
			);
		});
	});

	describe('STANDARD', () => {
		it('lays an episode out the way both media servers read it', () => {
			expect(service.render(NamingScheme.STANDARD, episode())).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv',
			);
		});

		it('gives a film its own folder, where the artwork goes', () => {
			expect(service.render(NamingScheme.STANDARD, movie())).toBe(
				'Blade Runner (1982)/Blade Runner (1982).mkv',
			);
		});

		it('omits the year when nobody knows it', () => {
			expect(service.render(NamingScheme.STANDARD, movie({ year: null }))).toBe(
				'Blade Runner/Blade Runner.mkv',
			);
		});

		it('pads the numbers so the files sort', () => {
			expect(
				service.render(
					NamingScheme.STANDARD,
					episode({ seasonNumber: 1, episodeNumber: 9, title: '' }),
				),
			).toBe('The Expanse (2015)/Season 01/The Expanse - S01E09.mkv');
		});
	});

	describe('LOCAL', () => {
		it('imitates what the library already does for this show', () => {
			const rendered = service.render(NamingScheme.LOCAL, episode(), {
				samples: ['The Expanse - S01E01 - Dulcinea [1080p x265].mkv'],
			});

			expect(rendered).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv',
			);
		});

		it('keeps the separator convention of the sample', () => {
			const rendered = service.render(NamingScheme.LOCAL, episode(), {
				samples: ['The.Expanse.S01E01.Dulcinea.mkv'],
			});

			expect(rendered).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.S01E02.Back to the Butcher.mkv',
			);
		});

		it('falls back to the standard scheme with nothing to imitate', () => {
			expect(service.render(NamingScheme.LOCAL, episode(), { samples: [] })).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv',
			);
		});

		it('falls back when the sample carries no episode tag to replace', () => {
			// Copying it verbatim would overwrite the very file we took as a model.
			expect(
				service.render(NamingScheme.LOCAL, episode(), { samples: ['Some Old Name.mkv'] }),
			).toBe('The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv');
		});

		it('falls back when we have no numbers to put in the tag', () => {
			expect(
				service.render(
					NamingScheme.LOCAL,
					episode({ seasonNumber: null, episodeNumber: null }),
					{ samples: ['The Expanse - S01E01 - Dulcinea.mkv'] },
				),
			).toBe('The Expanse (2015)/Season 00/The Expanse - S00E00 - Back to the Butcher.mkv');
		});
	});

	describe('sanitise', () => {
		it('turns characters no filesystem accepts into spaces', () => {
			expect(service.sanitise('Batman: Begins')).toBe('Batman Begins');
			expect(service.sanitise('A/B\\C|D?E*F')).toBe('A B C D E F');
		});

		it('cuts trailing dots and spaces, which Windows silently drops', () => {
			expect(service.sanitise('Film. ')).toBe('Film');
		});

		it('never returns an empty component', () => {
			expect(service.sanitise('///')).toBe('untitled');
		});

		it('escapes the names Windows reserves', () => {
			expect(service.sanitise('CON')).toBe('_CON');
		});

		it('keeps a component short enough for every filesystem', () => {
			expect(service.sanitise('x'.repeat(400)).length).toBeLessThanOrEqual(200);
		});
	});

	/**
	 * What a second version of one media is called when the first one holds the path.
	 *
	 * The suffix is not decoration: it is the sentence both media servers read to
	 * decide that two files are two versions of one film rather than two films. Get it
	 * wrong and the library shows `Titanic` twice, or shows one and quietly ignores the
	 * other — which is what made overwriting the first one look like a tidy outcome.
	 */
	describe('disambiguate', () => {
		it('writes an edition in the tag Plex parses and Jellyfin keeps', () => {
			// Plex strips `{edition-…}` before matching the title, so it reads Titanic
			// with an edition of `Extended Cut`; Jellyfin reads everything after the last
			// ` - ` as the version name and files it under the same film. One string, two
			// servers, neither of them confused about which film it is.
			expect(
				service.disambiguate(
					'Titanic (1997)/Titanic (1997).mkv',
					{ edition: 'Extended Cut', quality: '2160p' },
					1,
				),
			).toBe('Titanic (1997)/Titanic (1997) - {edition-Extended Cut}.mkv');
		});

		it('falls back to the resolution, which is the other suffix both servers read', () => {
			expect(
				service.disambiguate(
					'The Expanse (2015)/Season 01/The Expanse - S01E02.mkv',
					{ edition: null, quality: '2160p' },
					1,
				),
			).toBe('The Expanse (2015)/Season 01/The Expanse - S01E02 - 2160p.mkv');
		});

		it('counts when there is nothing to say, rather than colliding politely', () => {
			expect(service.disambiguate('Film.mkv', { edition: null, quality: null }, 1)).toBe(
				'Film - 2.mkv',
			);
			expect(service.disambiguate('Film.mkv', { edition: null, quality: null }, 2)).toBe(
				'Film - 3.mkv',
			);
		});

		it('keeps producing new names, because two 2160p encodes of one cut exist', () => {
			expect(service.disambiguate('Film.mkv', { quality: '2160p' }, 2)).toBe(
				'Film - 2160p (2).mkv',
			);
		});

		it('does not repeat a label the source name already carries', () => {
			// `Film {edition-Extended} - {edition-Extended}.mkv` is both ugly and, more to
			// the point, the same name again: the collision would still be there.
			expect(
				service.disambiguate('Film {edition-Extended}.mkv', { edition: 'Extended' }, 1),
			).toBe('Film {edition-Extended} - 2.mkv');
		});

		it('leaves the folders alone and only renames the file', () => {
			expect(
				service.disambiguate('Show (2015)/Season 01/Show - S01E02.mkv', { quality: '1080p' }, 1),
			).toBe('Show (2015)/Season 01/Show - S01E02 - 1080p.mkv');
		});

		it('sanitises a label that arrived from somebody else\'s library', () => {
			expect(service.disambiguate('Film.mkv', { edition: 'Cut: the "good" one' }, 1)).toBe(
				'Film - {edition-Cut the good one}.mkv',
			);
		});
	});

	describe('extensions', () => {
		it('lowercases the extension it keeps', () => {
			expect(
				service.render(NamingScheme.STANDARD, movie({ sourcePath: '/media/Film.MKV' })),
			).toBe('Blade Runner (1982)/Blade Runner (1982).mkv');
		});

		it('adds nothing when the source had no extension', () => {
			expect(
				service.render(NamingScheme.STANDARD, movie({ sourcePath: '/media/Film' })),
			).toBe('Blade Runner (1982)/Blade Runner (1982)');
		});
	});
});
