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
		// Which file this is, which is a question about the disk rather than about the
		// show — a server that gets it wrong files the episode under the wrong season
		// whatever it goes on to fetch.
		expect(document).toContain('<season>1</season>');
		expect(document).toContain('<episode>1</episode>');
	});

	/**
	 * The bug this file now exists to prevent.
	 *
	 * A media server reads a local `.nfo` as authority. Handed a document that already
	 * names the episode, describes it and dates it, Jellyfin considers the record
	 * complete and stops fetching from TVDB and TMDB — so artwork, cast and every later
	 * correction upstream never arrive, and nothing reports a failure. It took a full
	 * "replace all metadata" refresh on a real library to undo.
	 */
	it('writes no metadata of its own, only what identifies the file', () => {
		const document = renderNfo(facts({ overview: 'Ceres station.' })) ?? '';

		expect(document).not.toContain('<title>');
		expect(document).not.toContain('<showtitle>');
		expect(document).not.toContain('<year>');
		expect(document).not.toContain('<plot>');
	});

	it('says plainly that the record is not locked', () => {
		// Left out, a reader that assumes the default is locked would freeze exactly what
		// this document exists to keep thawed. Saying it costs one line.
		expect(renderNfo(facts()) ?? '').toContain('<lockdata>false</lockdata>');
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
		// An unescaped ampersand makes the whole file unparseable — reported by a media
		// server as "no metadata" rather than as a broken file — and identifiers from a
		// server nobody controls are not guaranteed to be tidy.
		const document = renderNfo(facts({ externalIds: { imdb: 'tt1 & <2>' } })) ?? '';

		expect(document).toContain('tt1 &amp; &lt;2&gt;');
		expect(document).not.toMatch(/>[^<]*&(?!amp;|apos;|lt;|gt;|quot;)/);
	});

	it('leaves out a coordinate it does not know rather than writing an empty element', () => {
		const document = renderNfo(facts({ seasonNumber: null })) ?? '';

		expect(document).not.toContain('<season>');
		expect(document).toContain('<episode>1</episode>');
	});

	/**
	 * No identifier, no document — and this is the whole point of the file.
	 *
	 * What would be left is a title the server already has from the filename, written in
	 * the one place that stops it looking any further. An identifier has the opposite
	 * effect: it is the one fact the server cannot work out for itself, and handing it
	 * over is what sends the server to the provider rather than away from it.
	 */
	it('writes nothing at all when it has no identifier to carry', () => {
		expect(renderNfo(facts({ externalIds: {} }))).toBeNull();
		// Not even when everything else is known.
		expect(renderNfo(facts({ externalIds: { internal: 'abc' } }))).toBeNull();
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
		expect(document).toContain('<uniqueid type="tvdb" default="true">280619</uniqueid>');
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
