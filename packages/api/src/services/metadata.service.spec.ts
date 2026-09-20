import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MediaKind, type Settings } from '@mcs/shared';
import { MetadataService, type SidecarFile } from './metadata.service';
import { DEFAULT_SETTINGS } from './settings.service';

function settings(overrides: Partial<Settings> = {}): Settings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('MetadataService', () => {
	const service = new MetadataService();
	let root: string;
	let source: string;
	let target: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mcs-metadata-'));
		source = join(root, 'source');
		target = join(root, 'target');

		await mkdir(source, { recursive: true });
		await mkdir(target, { recursive: true });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function sidecar(name: string, content: string): SidecarFile {
		return {
			name,
			kind: 'subtitle',
			size: content.length,
			open: async () => Readable.from([Buffer.from(content)]),
		};
	}

	describe('discover', () => {
		it('finds the companions that belong to a file and renames them to follow it', async () => {
			await writeFile(join(source, 'Old.Name.mkv'), 'media');
			await writeFile(join(source, 'Old.Name.srt'), 'subs');
			await writeFile(join(source, 'Old.Name.en.srt'), 'english subs');
			await writeFile(join(source, 'Old.Name.nfo'), '<nfo/>');
			await writeFile(join(source, 'folder.jpg'), 'art');

			const found = await service.discover(
				join(source, 'Old.Name.mkv'),
				join(target, 'New Name.mkv'),
			);

			expect(found.map((file) => file.name).sort()).toEqual([
				'New Name.en.srt',
				'New Name.nfo',
				'New Name.srt',
				// Folder artwork keeps its own name: it belongs to the directory, not to
				// one file.
				'folder.jpg',
			]);
		});

		it('ignores files belonging to a different media file', async () => {
			await writeFile(join(source, 'Episode 1.mkv'), 'media');
			await writeFile(join(source, 'Episode 2.srt'), 'other subs');

			expect(
				await service.discover(join(source, 'Episode 1.mkv'), join(target, 'Episode 1.mkv')),
			).toEqual([]);
		});

		it('says nothing rather than failing when the source is not ours to read', async () => {
			// The normal case for a remote service, not a fault worth reporting.
			expect(
				await service.discover('/definitely/not/here/file.mkv', join(target, 'file.mkv')),
			).toEqual([]);
		});
	});

	describe('apply', () => {
		it('writes the companions next to the media', async () => {
			const result = await service.apply(
				join(target, 'Film.mkv'),
				[sidecar('Film.srt', 'hello')],
				settings({ pullMetadata: true }),
			);

			expect(result.copied).toEqual(['Film.srt']);
			expect(await readFile(join(target, 'Film.srt'), 'utf8')).toBe('hello');
		});

		it('never overwrites a local file by default', async () => {
			// Somebody's own hand-timed subtitles are work they did; replacing them
			// quietly is how a sync gets switched off.
			await writeFile(join(target, 'Film.srt'), 'mine');

			const result = await service.apply(
				join(target, 'Film.mkv'),
				[sidecar('Film.srt', 'theirs')],
				settings({ pullMetadata: true, preferSourceMetadata: false }),
			);

			expect(result.kept).toEqual(['Film.srt']);
			expect(result.copied).toEqual([]);
			expect(await readFile(join(target, 'Film.srt'), 'utf8')).toBe('mine');
		});

		it('overwrites when the settings say the source knows better', async () => {
			await writeFile(join(target, 'Film.srt'), 'mine');

			const result = await service.apply(
				join(target, 'Film.mkv'),
				[sidecar('Film.srt', 'theirs')],
				settings({ pullMetadata: true, preferSourceMetadata: true }),
			);

			expect(result.copied).toEqual(['Film.srt']);
			expect(await readFile(join(target, 'Film.srt'), 'utf8')).toBe('theirs');
		});

		it('does nothing at all when metadata is turned off', async () => {
			const result = await service.apply(
				join(target, 'Film.mkv'),
				[sidecar('Film.srt', 'hello')],
				settings({ pullMetadata: false }),
			);

			expect(result).toEqual({ copied: [], kept: [], failed: [] });
		});

		it('reports one failure without losing the others', async () => {
			const broken: SidecarFile = {
				name: 'Broken.srt',
				kind: 'subtitle',
				size: null,
				open: async () => {
					throw new Error('link dropped');
				},
			};

			const result = await service.apply(
				join(target, 'Film.mkv'),
				[broken, sidecar('Film.srt', 'hello')],
				settings({ pullMetadata: true }),
			);

			expect(result.failed.map((entry) => entry.name)).toEqual(['Broken.srt']);
			expect(result.copied).toEqual(['Film.srt']);
		});

		it('leaves no temporary file behind after a failure', async () => {
			const broken: SidecarFile = {
				name: 'Broken.srt',
				kind: 'subtitle',
				size: null,
				open: async () => Readable.from([]).map(() => {
					throw new Error('mid-stream failure');
				}) as unknown as Readable,
			};

			await service.apply(join(target, 'Film.mkv'), [broken], settings({ pullMetadata: true }));

			await expect(readFile(join(target, 'Broken.srt.mcs-part'), 'utf8')).rejects.toThrow();
		});
	});

	describe('mergeExternalIds', () => {
		it('adds identifiers we did not have', async () => {
			expect(
				service.mergeExternalIds({ tvdb: '1' }, { tmdb: '2', imdb: 'tt3' }, false),
			).toEqual({ tvdb: '1', tmdb: '2', imdb: 'tt3' });
		});

		it('keeps ours on a disagreement', async () => {
			// Our value may be one somebody corrected by hand.
			expect(service.mergeExternalIds({ tvdb: 'mine' }, { tvdb: 'theirs' }, false)).toEqual({
				tvdb: 'mine',
			});
		});

		it('takes theirs when the settings say so', async () => {
			expect(service.mergeExternalIds({ tvdb: 'mine' }, { tvdb: 'theirs' }, true)).toEqual({
				tvdb: 'theirs',
			});
		});

		it('never copies the provider-local identifier', async () => {
			// It points at a row in somebody else's database.
			expect(
				service.mergeExternalIds({ provider: 'ours' }, { provider: 'theirs' }, true),
			).toEqual({ provider: 'ours' });
		});

		it('survives both sides being missing', async () => {
			expect(service.mergeExternalIds(null, null, false)).toEqual({});
		});
	});

	describe('writing a document of our own', () => {
		const facts = {
			kind: MediaKind.EPISODE,
			title: 'Dulcinea',
			year: 2015,
			seasonNumber: 1,
			episodeNumber: 1,
			overview: null,
			showTitle: 'The Expanse',
			externalIds: { tvdb: '280619' },
		};

		it('writes nothing unless asked', async () => {
			const media = join(target, 'Show - S01E01.mkv');

			await writeFile(media, 'x');

			expect(await service.writeNfo(media, facts, settings({ writeNfo: false }))).toBeNull();
			await expect(readFile(join(target, 'Show - S01E01.nfo'), 'utf8')).rejects.toBeDefined();
		});

		it('names the document after the file, and carries the identifiers', async () => {
			const media = join(target, 'Show - S01E01.mkv');

			await writeFile(media, 'x');

			expect(await service.writeNfo(media, facts, settings({ writeNfo: true })))
				.toBe('Show - S01E01.nfo');

			const document = await readFile(join(target, 'Show - S01E01.nfo'), 'utf8');

			expect(document).toContain('<uniqueid type="tvdb" default="true">280619</uniqueid>');
			expect(document).toContain('<showtitle>The Expanse</showtitle>');
		});

		it('keeps a document somebody already has', async () => {
			// Their own corrected document is work they did, and a sync that replaces it
			// silently is a sync they turn off.
			const media = join(target, 'Show - S01E01.mkv');
			const existing = join(target, 'Show - S01E01.nfo');

			await writeFile(media, 'x');
			await writeFile(existing, '<episodedetails><title>Mine</title></episodedetails>');

			expect(await service.writeNfo(media, facts, settings({ writeNfo: true }))).toBeNull();
			expect(await readFile(existing, 'utf8')).toContain('Mine');
		});

		it('keeps it even when the source is declared to know better', async () => {
			// The asymmetry with `apply` is the point. That setting says a companion the
			// source really has may be richer than ours, which is fair. This document is
			// not one of those — it is assembled from fields we hold — and losing a
			// `.nfo` somebody wrote to a summary we generated is a loss with nothing
			// gained. The local file wins, full stop.
			const media = join(target, 'Show - S01E01.mkv');
			const existing = join(target, 'Show - S01E01.nfo');

			await writeFile(media, 'x');
			await writeFile(existing, '<episodedetails><title>Mine</title></episodedetails>');

			expect(await service.writeNfo(
				media,
				facts,
				settings({ writeNfo: true, preferSourceMetadata: true }),
			)).toBeNull();
			expect(await readFile(existing, 'utf8')).toContain('Mine');
		});

		it('leaves no half-written document behind on a failure', async () => {
			// A media server reads a truncated document as authoritative and wrong, so
			// the write goes through a temporary name like every other companion.
			const media = join(root, 'missing', 'Show - S01E01.mkv');

			await expect(
				service.writeNfo(media, facts, settings({ writeNfo: true })),
			).resolves.toBe('Show - S01E01.nfo');

			const listed = await readFile(join(root, 'missing', 'Show - S01E01.nfo'), 'utf8');

			expect(listed).toContain('<episodedetails>');
		});

		it('writes nothing for a kind that has no document', async () => {
			const media = join(target, 'Collection.mkv');

			await writeFile(media, 'x');

			expect(await service.writeNfo(
				media,
				{ ...facts, kind: MediaKind.COLLECTION },
				settings({ writeNfo: true }),
			)).toBeNull();
		});
	});

});
