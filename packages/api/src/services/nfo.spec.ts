import { MediaKind } from '@mcs/shared';
import { nfoNameFor, renderNfo, type NfoFacts } from './nfo';

const facts = (overrides: Partial<NfoFacts> = {}): NfoFacts => ({
	kind: MediaKind.EPISODE,
	title: 'Dulcinea',
	year: 2015,
	seasonNumber: 1,
	episodeNumber: 1,
	overview: null,
	showTitle: 'The Expanse',
	externalIds: { tvdb: '280619' },
	...overrides,
});

describe('renderNfo', () => {
	it('files an episode under the element a media server reads', () => {
		const document = renderNfo(facts()) ?? '';

		expect(document).toContain('<episodedetails>');
		expect(document).toContain('<season>1</season>');
		expect(document).toContain('<episode>1</episode>');
		expect(document).toContain('<showtitle>The Expanse</showtitle>');
	});

	it('carries the identifiers, which is the whole reason to write one', () => {
		// A source often holds rich metadata and no `.nfo` on disk. Copying the
		// companions gives the file and none of the facts, and the local server then
		// re-identifies the episode from its filename.
		const document = renderNfo(facts({ externalIds: { tvdb: '280619', imdb: 'tt3230854' } })) ?? '';

		expect(document).toContain('<uniqueid type="tvdb" default="true">280619</uniqueid>');
		expect(document).toContain('<uniqueid type="imdb">tt3230854</uniqueid>');
	});

	it('marks exactly one identifier as the default', () => {
		// Without a default the server picks for itself, and a server that picks
		// differently from the source is how one episode is identified two ways on two
		// machines.
		const document = renderNfo(facts({ externalIds: { imdb: 'tt1', tmdb: '2' } })) ?? '';

		expect([...document.matchAll(/default="true"/g)]).toHaveLength(1);
		// tmdb outranks imdb in the preferred order.
		expect(document).toContain('<uniqueid type="tmdb" default="true">2</uniqueid>');
	});

	it('drops a provider no media server would recognise', () => {
		// An unknown provider is ignored at best; at worst a strict parser drops the
		// whole document, losing the identifiers that did work.
		const document = renderNfo(facts({ externalIds: { tvdb: '1', internal: 'abc' } })) ?? '';

		expect(document).not.toContain('internal');
		expect(document).toContain('type="tvdb"');
	});

	it('escapes what would end the document early', () => {
		// Both occur in real libraries, and an unescaped ampersand makes the file
		// unparseable — reported by a media server as "no metadata", not as a bad file.
		const document = renderNfo(facts({ title: "Fear & Loathing: Girls' Night <1>" })) ?? '';

		expect(document).toContain('Fear &amp; Loathing: Girls&apos; Night &lt;1&gt;');
		expect(document).not.toMatch(/<title>[^<]*&(?!amp;|apos;|lt;|gt;|quot;)/);
	});

	it('leaves out what it does not know rather than writing empty elements', () => {
		const document = renderNfo(facts({ year: null, overview: null, showTitle: null })) ?? '';

		expect(document).not.toContain('<year>');
		expect(document).not.toContain('<plot>');
		expect(document).not.toContain('<showtitle>');
	});

	it('writes nothing at all when it knows nothing', () => {
		// A document with a root and nothing in it says less than no document, and a
		// media server that reads one stops looking for metadata elsewhere.
		expect(renderNfo(facts({
			title: '   ',
			year: null,
			seasonNumber: null,
			episodeNumber: null,
			overview: null,
			showTitle: null,
			externalIds: {},
		}))).toBeNull();
	});

	it('has no document for a collection', () => {
		expect(renderNfo(facts({ kind: MediaKind.COLLECTION }))).toBeNull();
	});

	it('files a film under its own element', () => {
		const document = renderNfo(facts({
			kind: MediaKind.MOVIE,
			title: 'Big Buck Bunny',
			seasonNumber: null,
			episodeNumber: null,
			showTitle: null,
		})) ?? '';

		expect(document).toContain('<movie>');
		expect(document).not.toContain('<season>');
	});
});

describe('nfoNameFor', () => {
	it.each([
		[MediaKind.EPISODE, 'Show - S01E02 - Title.mkv', 'Show - S01E02 - Title.nfo'],
		[MediaKind.MOVIE, 'Big Buck Bunny (2008).mp4', 'Big Buck Bunny (2008).nfo'],
		// A series document belongs to the folder, so naming it after a file would
		// leave it unread.
		[MediaKind.SERIES, 'whatever.mkv', 'tvshow.nfo'],
	])('names the document for %s', (kind, file, expected) => {
		expect(nfoNameFor(kind, file)).toBe(expected);
	});

	it('keeps a name that has no extension', () => {
		expect(nfoNameFor(MediaKind.MOVIE, 'nameless')).toBe('nameless.nfo');
	});

	it('has no name for a kind with no document', () => {
		expect(nfoNameFor(MediaKind.COLLECTION, 'x.mkv')).toBeNull();
	});
});
