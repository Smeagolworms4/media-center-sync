import { ReleaseSearchKind } from '@mcs/shared';
import { releaseTitle, searchTerms } from './search-terms';

const query = (over: Partial<Parameters<typeof searchTerms>[0]> = {}): Parameters<typeof searchTerms>[0] => ({
	term: 'Scrubs',
	kind: ReleaseSearchKind.SHOW,
	seasonNumber: null,
	episodeNumber: null,
	...over,
});

describe('the title a tracker is asked for', () => {
	it.each([
		['Scrubs (2026)', 'Scrubs'],
		['Scrubs (HD - VOST)', 'Scrubs'],
		['Scrubs (2026) (HD - VOST)', 'Scrubs'],
		['  Bones (2005)  ', 'Bones'],
		['Marvel’s Runaways', 'Marvel’s Runaways'],
		['Æon Flux', 'Æon Flux'],
	])('reads %s as %s', (filed, asked) => {
		/*
		 * A media server's title is a shelf label. Jellyfin publishes `Scrubs (2026)` to
		 * tell its own users which Scrubs this is; a library flavoured by language comes
		 * out as `Scrubs (HD - VOST)`. Neither spelling is in any release name on any
		 * tracker — what is there is `Scrubs.2026.S01E01` — so the brackets are words that
		 * cannot match, on a search whose whole job is matching words.
		 */
		expect(releaseTitle(filed)).toBe(asked);
	});

	it('keeps a bracket that is the whole of the title', () => {
		// Somebody's odd library, and an empty search asks the tracker for everything.
		expect(releaseTitle('(2026)')).toBe('(2026)');
	});

	it('leaves a bracket alone in the middle, where it is part of the name', () => {
		expect(releaseTitle('Whose Line Is It (Anyway) Tonight')).toBe('Whose Line Is It (Anyway) Tonight');
	});
});

describe('the words a search is made of', () => {
	it('is the bare title when nothing names a season', () => {
		expect(searchTerms(query())).toBe('Scrubs');
	});

	it('names the episode when one was asked for', () => {
		expect(searchTerms(query({ seasonNumber: 11, episodeNumber: 10, term: 'Futurama' })))
			.toBe('Futurama S11E10');
	});

	it('names the season alone for a pack, because that is what a pack is', () => {
		expect(searchTerms(query({ seasonNumber: 11, episodeNumber: 10, seasonPack: true, term: 'Futurama' })))
			.toBe('Futurama S11');
	});

	it('names the season alone when no episode was given', () => {
		expect(searchTerms(query({ seasonNumber: 1 }))).toBe('Scrubs S01');
	});

	it('says nothing about a coordinate it was not given', () => {
		// A pack of nothing in particular is the bare title, which silently turns "find me
		// the rest of this season" into "find me anything called this".
		expect(searchTerms(query({ episodeNumber: 10 }))).toBe('Scrubs');
	});
});
