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
		it('keeps the name the source used, ugly as it is', () => {
			expect(service.render(NamingScheme.SOURCE, episode())).toBe(
				'The.Expanse.S01E02.1080p.WEB-DL.x265-GRP.mkv',
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

			expect(rendered).toBe('The Expanse - S01E02 - Back to the Butcher.mkv');
		});

		it('keeps the separator convention of the sample', () => {
			const rendered = service.render(NamingScheme.LOCAL, episode(), {
				samples: ['The.Expanse.S01E01.Dulcinea.mkv'],
			});

			expect(rendered).toBe('The.Expanse.S01E02.Back to the Butcher.mkv');
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
