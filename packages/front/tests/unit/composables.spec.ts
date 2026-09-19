import type { MediaItem, TransferChunk } from '@mcs/shared';
import { ChunkState, MediaKind, SyncState, TransferErrorKind } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { parseByteSize, toByteSizeInput } from '@/composables/useByteSize';
import { toCatalogueEntry } from '@/composables/useCatalogue';
import { buildChunkMap } from '@/composables/useChunkMap';
import { describeCron } from '@/composables/useCron';
import { describeTransferError, TransferAction } from '@/composables/useTransferError';

function chunk (index: number, state: ChunkState): TransferChunk {
	return {
		index,
		start: index * 100,
		end: index * 100 + 99,
		state,
		bytesDone: state === ChunkState.DONE ? 100 : 0,
		sourceServiceId: 's1',
		attempts: 1,
		checksum: null,
	};
}

describe('useByteSize', () => {
	it.each([
		['4M', 4 * 1024 ** 2],
		['2G', 2 * 1024 ** 3],
		['512k', 512 * 1024],
		['1024', 1024],
		['1,5M', Math.round(1.5 * 1024 ** 2)],
	])('reads %s as a byte count', (input, expected) => {
		expect(parseByteSize(input)).toBe(expected);
	});

	it('answers null for what is not a size, so a caller can fall back', () => {
		expect(parseByteSize('')).toBeNull();
		expect(parseByteSize(null)).toBeNull();
		expect(parseByteSize('soon')).toBeNull();
	});

	it('writes a byte count back in the shortest exact form', () => {
		expect(toByteSizeInput(4 * 1024 ** 2)).toBe('4M');
		expect(toByteSizeInput(1500)).toBe('1500');
		// Zero is "no cap", which a form shows as an empty field rather than a 0.
		expect(toByteSizeInput(0)).toBe('');
	});
});

describe('useCron', () => {
	it.each([
		['* * * * *', 'cron.describe.every_minute'],
		['*/15 * * * *', 'cron.describe.every_n_minutes'],
		['0 * * * *', 'cron.describe.hourly_at'],
		['30 */6 * * *', 'cron.describe.every_n_hours'],
		['0 4 * * *', 'cron.describe.daily_at'],
		['0 4 * * 1', 'cron.describe.weekly_at'],
		['0 4 1 * *', 'cron.describe.monthly_at'],
		['0 4 1,15 * 3', 'cron.describe.custom'],
	])('describes %s', (expression, key) => {
		expect(describeCron(expression)?.key).toBe(key);
	});

	it('says an expression is malformed rather than guessing at it', () => {
		expect(describeCron('0 4 *')?.key).toBe('cron.describe.invalid');
	});

	it('has nothing to say about an empty schedule', () => {
		expect(describeCron('')).toBeNull();
		expect(describeCron(null)).toBeNull();
	});

	it('carries the parts the sentence needs', () => {
		expect(describeCron('0 4 * * *')?.params).toEqual({ time: '04:00' });
		// Sunday is both 0 and 7 in the dialects worth supporting.
		expect(describeCron('0 4 * * 7')?.params).toEqual({ day: 0, time: '04:00' });
	});
});

describe('useChunkMap', () => {
	it('draws one cell per chunk while there are few of them', () => {
		const map = buildChunkMap([chunk(0, ChunkState.DONE), chunk(1, ChunkState.PENDING)]);

		expect(map.scale).toBe(1);
		expect(map.cells).toHaveLength(2);
		expect(map.counts[ChunkState.DONE]).toBe(1);
	});

	/**
	 * A folded cell shows the worst state it covers: averaging would hide the two
	 * corrupt pieces in an otherwise finished season, which are the only reason
	 * anybody opened the map.
	 */
	it('folds a long list and keeps the state that needs attention', () => {
		const chunks = Array.from({ length: 1000 }, (_, index) => chunk(index, ChunkState.DONE));
		chunks[500] = chunk(500, ChunkState.CORRUPT);

		const map = buildChunkMap(chunks, 100);

		expect(map.cells.length).toBeLessThanOrEqual(100);
		expect(map.scale).toBe(10);
		expect(map.cells.some(cell => cell.state === ChunkState.CORRUPT)).toBe(true);
		expect(map.counts[ChunkState.CORRUPT]).toBe(1);
	});

	it('has nothing to draw for a transfer with no piece map yet', () => {
		const map = buildChunkMap([]);

		expect(map.cells).toEqual([]);
		expect(map.counts[ChunkState.DONE]).toBe(0);
	});
});

describe('useTransferError', () => {
	/** The point of the mapping: a retry that would fail the same way is not offered. */
	it('offers another source when the far end no longer holds the file', () => {
		const descriptor = describeTransferError(TransferErrorKind.SOURCE_GONE);

		expect(descriptor.actions[0]).toBe(TransferAction.ANOTHER_SOURCE);
		expect(descriptor.actions).not.toContain(TransferAction.RETRY);
	});

	it('offers another library when the disk is full or the path refuses us', () => {
		for (const kind of [
			TransferErrorKind.DISK_FULL,
			TransferErrorKind.PERMISSION_DENIED,
			TransferErrorKind.TARGET_MISSING,
		]) {
			expect(describeTransferError(kind).actions[0]).toBe(TransferAction.ANOTHER_TARGET);
		}
	});

	it('offers a repair when the pieces do not match their hashes', () => {
		expect(describeTransferError(TransferErrorKind.CHECKSUM_MISMATCH).actions[0])
			.toBe(TransferAction.REPAIR);
	});

	it('offers the credentials when the source answered and refused us', () => {
		expect(describeTransferError(TransferErrorKind.SOURCE_UNAUTHORIZED).actions[0])
			.toBe(TransferAction.FIX_SERVICE);
	});

	it('offers a retry for the one failure a retry really does fix', () => {
		expect(describeTransferError(TransferErrorKind.NETWORK).actions[0]).toBe(TransferAction.RETRY);
	});

	it('falls back to the unknown case for a kind this build does not know', () => {
		const descriptor = describeTransferError('something_new_from_the_api');

		expect(descriptor.kind).toBe(TransferErrorKind.UNKNOWN);
		expect(descriptor.labelKey).toBe('transfer.error_kind.unknown');
		expect(descriptor.actions.length).toBeGreaterThan(0);
	});
});

describe('useCatalogue', () => {
	const item: MediaItem = {
		id: 'm1',
		serviceId: 's1',
		libraryId: 'l1',
		parentId: 'series-1',
		kind: MediaKind.EPISODE,
		title: 'Pilot',
		normalizedTitle: 'pilot',
		year: 2019,
		seasonNumber: 1,
		episodeNumber: 2,
		externalIds: { tvdb: '1234', provider: 'jf-9' },
		overview: null,
		artworkUrl: null,
		file: {
			path: '/data/shows/pilot.mkv',
			size: 900,
			container: 'mkv',
			videoCodec: 'h265',
			audioCodec: 'eac3',
			width: 1920,
			height: 1080,
			durationMs: 1000,
			bitrate: 8_000_000,
			quickHash: 'v1:abc',
			contentId: 'v1:cid',
			checksum: null,
		},
		quality: {
			label: 'x265 · 1080p',
			mixed: false,
			dominant: null,
			variants: [],
			fileCount: 1,
			totalBytes: 900,
		},
		addedAt: null,
		sync: SyncState.MISSING,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};

	it('keeps what a peer tells us and drops what is ours', () => {
		const entry = toCatalogueEntry(item);

		expect(entry.externalId).toBe('jf-9');
		expect(entry.title).toBe('Pilot');
		expect(entry.contentId).toBe('v1:cid');
		expect(entry.size).toBe(900);
		expect(entry.quality).toBe('x265 · 1080p');
		expect(entry).not.toHaveProperty('libraryId');
		expect(entry).not.toHaveProperty('path');
	});

	it('does not invent an external identifier for the parent', () => {
		expect(toCatalogueEntry(item).parentExternalId).toBeNull();
	});

	it('falls back to our identifier when the index kept none of theirs', () => {
		const entry = toCatalogueEntry({ ...item, externalIds: {} });

		expect(entry.externalId).toBe('m1');
		expect(entry.externalIds).toEqual({});
	});

	it('answers no content identifier for an item shared as a catalogue only', () => {
		expect(toCatalogueEntry({ ...item, file: null }).contentId).toBeNull();
	});
});
