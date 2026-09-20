import { DEFAULT_NAMING_ORDER, MediaKind, NamingScheme } from '@mcs/shared';
import { NamingService, type NameableItem } from './naming.service';

/**
 * The orders these tests exercise, named after what somebody would say they want.
 *
 * Each one ends in a convention because every chain does: the last step has to be one
 * that cannot hand on, or a finished transfer has no name. What each describe block
 * below is really pinning is which step answers first, and what happens when it
 * cannot.
 */
const KEEP_SOURCE = [NamingScheme.SOURCE, NamingScheme.STANDARD];
const IMITATE = [NamingScheme.LOCAL, NamingScheme.STANDARD];
const SPACED = [NamingScheme.STANDARD];
const DOTTED = [NamingScheme.DOTTED];

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

	describe('keeping the source name', () => {
		it('keeps the name the source used, ugly as it is, and still files it', () => {
			// The name is the source's; the folders are not negotiable. A library whose
			// episodes land in its root is not a library, and both media servers read
			// the season from the folder when the filename is ambiguous.
			expect(service.render(KEEP_SOURCE, episode())).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv',
			);
		});

		it('imitates the folders the library already uses, spelling and all', () => {
			// Inferring a template is how a season ends up split across two folders
			// differing by a space. An existing file is taken literally instead.
			const rendered = service.render(KEEP_SOURCE, episode({ seasonNumber: 2 }), {
				libraryRoot: '/media/shows',
				siblingPath: '/media/shows/The Expanse/Saison 1/whatever.mkv',
			});

			expect(rendered).toBe('The Expanse/Saison 2/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv');
		});

		it('keeps the padding the library uses for its seasons', () => {
			const rendered = service.render(KEEP_SOURCE, episode({ seasonNumber: 2 }), {
				libraryRoot: '/media/shows',
				siblingPath: '/media/shows/The Expanse (2015)/Season 01/whatever.mkv',
			});

			expect(rendered).toContain('The Expanse (2015)/Season 02/');
		});

		it('leaves a library that files a whole show in one folder alone', () => {
			const rendered = service.render(KEEP_SOURCE, episode({ seasonNumber: 3 }), {
				libraryRoot: '/media/shows',
				siblingPath: '/media/shows/The Expanse/whatever.mkv',
			});

			expect(rendered).toBe('The Expanse/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv');
		});

		it('ignores a sibling that is not inside the destination library', () => {
			// Following it would write outside the root, and it says nothing about how
			// this library is organised.
			const rendered = service.render(KEEP_SOURCE, episode(), {
				libraryRoot: '/media/shows',
				siblingPath: '/somewhere/else/The Expanse/Season 01/whatever.mkv',
			});

			expect(rendered).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv',
			);
		});

		it('falls back to the standard scheme when there is no source name to keep', () => {
			expect(service.render(KEEP_SOURCE, episode({ sourcePath: null }))).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher',
			);
		});
	});

	describe('the spaced convention', () => {
		it('lays an episode out the way both media servers read it', () => {
			expect(service.render(SPACED, episode())).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv',
			);
		});

		it('gives a film its own folder, where the artwork goes', () => {
			expect(service.render(SPACED, movie())).toBe(
				'Blade Runner (1982)/Blade Runner (1982).mkv',
			);
		});

		it('omits the year when nobody knows it', () => {
			expect(service.render(SPACED, movie({ year: null }))).toBe(
				'Blade Runner/Blade Runner.mkv',
			);
		});

		it('pads the numbers so the files sort', () => {
			expect(
				service.render(
					SPACED,
					episode({ seasonNumber: 1, episodeNumber: 9, title: '' }),
				),
			).toBe('The Expanse (2015)/Season 01/The Expanse - S01E09.mkv');
		});
	});

	describe('imitating our own library', () => {
		it('imitates what the library already does for this show', () => {
			const rendered = service.render(IMITATE, episode(), {
				samples: ['The Expanse - S01E01 - Dulcinea [1080p x265].mkv'],
			});

			expect(rendered).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv',
			);
		});

		it('keeps the separator convention of the sample', () => {
			const rendered = service.render(IMITATE, episode(), {
				samples: ['The.Expanse.S01E01.Dulcinea.mkv'],
			});

			expect(rendered).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.S01E02.Back to the Butcher.mkv',
			);
		});

		it('falls back to the standard scheme with nothing to imitate', () => {
			expect(service.render(IMITATE, episode(), { samples: [] })).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv',
			);
		});

		it('falls back when the sample carries no episode tag to replace', () => {
			// Copying it verbatim would overwrite the very file we took as a model.
			expect(
				service.render(IMITATE, episode(), { samples: ['Some Old Name.mkv'] }),
			).toBe('The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher.mkv');
		});

		it('falls back when we have no numbers to put in the tag', () => {
			expect(
				service.render(
					IMITATE,
					episode({ seasonNumber: null, episodeNumber: null }),
					{ samples: ['The Expanse - S01E01 - Dulcinea.mkv'] },
				),
			).toBe('The Expanse (2015)/Season 00/The Expanse - S00E00 - Back to the Butcher.mkv');
		});
	});

	/**
	 * The chain, which is the whole point of an order rather than three exclusive values.
	 *
	 * A step either answers or hands on, and what these pin is which one answers: the
	 * old single setting could only say `LOCAL` and then quietly produce a standard
	 * name when there was nothing to imitate, with nothing anywhere saying so.
	 */
	describe('the order', () => {
		it('imitates a sibling the caller found, without being handed samples', () => {
			// The one caller in the application passes the local copy it decided to file
			// this beside and no samples at all. Imitation that only reads `samples` was
			// therefore configured, looked configured, and never once ran.
			const rendered = service.render(IMITATE, episode(), {
				libraryRoot: '/media/shows',
				siblingPath: '/media/shows/The Expanse/Saison 1/The.Expanse.S01E01.Dulcinea.mkv',
			});

			expect(rendered).toBe('The Expanse/Saison 1/The.Expanse.S01E02.Back to the Butcher.mkv');
		});

		it('hands on to the convention when there is nothing to imitate', () => {
			expect(service.render([NamingScheme.LOCAL, NamingScheme.DOTTED], episode())).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.2015.S01E02.Back.to.the.Butcher.mkv',
			);
		});

		it('keeps the source name by default, which is what every gateway already does', () => {
			expect(service.render(DEFAULT_NAMING_ORDER, episode())).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv',
			);
		});

		it('imitates when the source sent no name, rather than reaching for a template', () => {
			// A peer that shared metadata and no path. The old `SOURCE` scheme went
			// straight to the standard template here even with a shelf full of episodes
			// to copy the spelling from.
			expect(
				service.render(DEFAULT_NAMING_ORDER, episode({ sourcePath: null }), {
					libraryRoot: '/media/shows',
					siblingPath: '/media/shows/The Expanse/Season 01/The Expanse - S01E01 - Dulcinea.mkv',
				}),
			).toBe('The Expanse/Season 01/The Expanse - S01E02 - Back to the Butcher');
		});

		it('still answers when every step in the order handed on', () => {
			// Not reachable through the settings, which refuse such an order — reachable
			// through a hand-edited row, and a finished download with no name to be
			// written under fails a long way from here.
			expect(service.render([NamingScheme.SOURCE], episode({ sourcePath: null }))).toBe(
				'The Expanse (2015)/Season 01/The Expanse - S01E02 - Back to the Butcher',
			);
		});
	});

	/**
	 * The dotted convention, which is a different convention and not a tidier one.
	 *
	 * It is what scene releases carry and what a great many Plex libraries are made
	 * of, and somebody whose library looks like this does not want one file in it
	 * spelled with spaces.
	 */
	describe('the dotted convention', () => {
		it('lays an episode out the way a scene release does', () => {
			expect(service.render(DOTTED, episode())).toBe(
				'The Expanse (2015)/Season 01/The.Expanse.2015.S01E02.Back.to.the.Butcher.mkv',
			);
		});

		it('names a film after its title and year, and files it in its own folder', () => {
			expect(service.render(DOTTED, movie())).toBe(
				'Blade Runner (1982)/Blade.Runner.1982.mkv',
			);
		});

		it('leaves no empty word where the year is unknown', () => {
			// `Blade.Runner..mkv` is what a joined empty part produces, and both scanners
			// read the double dot as a word that is not there.
			expect(service.render(DOTTED, movie({ year: null }))).toBe(
				'Blade Runner/Blade.Runner.mkv',
			);
		});

		it('sanitises a title no filesystem would take, and keeps it readable', () => {
			// The illegal characters become separators rather than vanishing: a name that
			// reads `BatmanBegins` is one nobody, and no scraper, recognises.
			expect(
				service.render(DOTTED, movie({ title: 'Batman: Begins / \u0001Redux', year: 2005 })),
			).toBe('Batman Begins Redux (2005)/Batman.Begins.Redux.2005.mkv');
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

		/**
		 * The dotted name, which is not an exotic case: it is what the dotted convention
		 * produces and what every scene-named source file already looks like.
		 *
		 * Both scanners normalise the dots of such a name to spaces before they match a
		 * title, so a bare marker glued to the end arrives as more title — `Some.Film - 2`
		 * is read as *Some Film 2*, a sequel, and the second version of one film becomes
		 * a second film in the library. Wrapping the marker in the tag Plex strips
		 * unconditionally is what stops that, and it costs Jellyfin nothing: the version
		 * name it reads after the last ` - ` is still there, merely spelled clumsily.
		 */
		it('wraps the marker in a dotted name, where a bare one would be read as title', () => {
			expect(
				service.disambiguate('Blade Runner (1982)/Blade.Runner.1982.mkv', { quality: '2160p' }, 1),
			).toBe('Blade Runner (1982)/Blade.Runner.1982 - {edition-2160p}.mkv');
		});

		it('wraps the counter too, which is the one that reads as a sequel number', () => {
			expect(service.disambiguate('Some.Film.mkv', { edition: null, quality: null }, 1)).toBe(
				'Some.Film - {edition-2}.mkv',
			);
		});

		it('keeps the counter inside the tag rather than trailing after it', () => {
			// Outside, the `(2)` is what Plex is left holding once it has stripped the
			// tag, and it goes straight back into the title it was meant to stay out of.
			expect(
				service.disambiguate('Blade.Runner.1982.mkv', { edition: 'Extended Cut' }, 2),
			).toBe('Blade.Runner.1982 - {edition-Extended Cut (2)}.mkv');
		});

		it('leaves a spaced name alone, where the marker already reads as its own field', () => {
			expect(
				service.disambiguate('The Expanse (2015)/Season 01/The Expanse - S01E02.mkv', { quality: '2160p' }, 1),
			).toBe('The Expanse (2015)/Season 01/The Expanse - S01E02 - 2160p.mkv');
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
				service.render(SPACED, movie({ sourcePath: '/media/Film.MKV' })),
			).toBe('Blade Runner (1982)/Blade Runner (1982).mkv');
		});

		it('adds nothing when the source had no extension', () => {
			expect(
				service.render(SPACED, movie({ sourcePath: '/media/Film' })),
			).toBe('Blade Runner (1982)/Blade Runner (1982)');
		});
	});
});
