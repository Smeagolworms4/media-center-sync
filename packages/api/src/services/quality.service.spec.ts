import type { MediaFileInfo } from '@mcs/shared';
import { QualityService } from './quality.service';

function file(overrides: Partial<MediaFileInfo> = {}): MediaFileInfo {
	return {
		path: '/media/Show/Show.S01E01.mkv',
		size: 1_000_000_000,
		container: 'mkv',
		videoCodec: 'h264',
		audioCodec: 'ac3',
		width: 1920,
		height: 1080,
		durationMs: 2_700_000,
		bitrate: 8_000_000,
		quickHash: null,
		contentId: null,
		checksum: null,
		...overrides,
	};
}

describe('QualityService', () => {
	const service = new QualityService();

	describe('resolutionLabel', () => {
		it.each([
			[2160, '2160p'],
			[1800, '2160p'],
			[1080, '1080p'],
			[1040, '1080p'],
			[720, '720p'],
			[576, '576p'],
			[480, '480p'],
			[240, '480p'],
		])('reads %i as %s', (height, label) => {
			expect(service.resolutionLabel(height)).toBe(label);
		});

		it('says nothing when the height is unknown', () => {
			expect(service.resolutionLabel(null)).toBeNull();
			expect(service.resolutionLabel(0)).toBeNull();
		});
	});

	describe('codec normalisation', () => {
		it.each(['hevc', 'h265', 'H.265', 'x265'])('folds %s onto x265', (codec) => {
			expect(service.normalizeVideoCodec(codec)).toBe('x265');
		});

		it.each(['avc', 'h264', 'X264'])('folds %s onto x264', (codec) => {
			expect(service.normalizeVideoCodec(codec)).toBe('x264');
		});

		it('keeps an unknown codec rather than inventing one', () => {
			expect(service.normalizeVideoCodec('prores')).toBe('prores');
		});

		it('folds the audio spellings too', () => {
			expect(service.normalizeAudioCodec('E-AC-3')).toBe('eac3');
			expect(service.normalizeAudioCodec('DTS-HD')).toBe('dtshd');
		});

		it('says nothing for an absent codec', () => {
			expect(service.normalizeVideoCodec(null)).toBeNull();
			expect(service.normalizeVideoCodec('  ')).toBeNull();
		});
	});

	describe('summarise', () => {
		it('groups files that differ only in how their codec is spelled', () => {
			const summary = service.summarise([
				file({ videoCodec: 'hevc' }),
				file({ videoCodec: 'h265' }),
				file({ videoCodec: 'x265' }),
			]);

			expect(summary.variants).toHaveLength(1);
			expect(summary.mixed).toBe(false);
			expect(summary.label).toBe('x265 · 1080p');
			expect(summary.dominant?.count).toBe(3);
			expect(summary.fileCount).toBe(3);
		});

		it('detects a mixed season and names the dominant encoding', () => {
			const summary = service.summarise([
				file({ videoCodec: 'x265' }),
				file({ videoCodec: 'x265' }),
				file({ videoCodec: 'x264', height: 720, width: 1280 }),
			]);

			expect(summary.mixed).toBe(true);
			expect(summary.label).toBe('mixed');
			expect(summary.variants).toHaveLength(2);
			// Most common first, so the tooltip opens on the encoding somebody chose.
			expect(summary.variants[0].videoCodec).toBe('x265');
			expect(summary.variants[0].count).toBe(2);
		});

		it('adds up the bytes across every variant', () => {
			const summary = service.summarise([
				file({ size: 1_000 }),
				file({ size: 2_000, videoCodec: 'x265' }),
			]);

			expect(summary.totalBytes).toBe(3_000);
		});

		it('survives an unscanned node', () => {
			const summary = service.summarise([null, undefined]);

			expect(summary).toMatchObject({
				label: 'unknown',
				mixed: false,
				dominant: null,
				fileCount: 0,
				totalBytes: 0,
			});
		});

		it('reads the dynamic range and the channel layout off the path', () => {
			const summary = service.summarise([
				file({ path: '/media/Film.2160p.HDR10.DTS-HD.MA.5.1.mkv', height: 2160 }),
			]);

			expect(summary.dominant?.hdr).toBe('HDR10');
			expect(summary.dominant?.audioChannels).toBe('5.1');
		});
	});

	describe('compare', () => {
		it('puts resolution before everything else', () => {
			const better = service.compare(
				file({ height: 2160, videoCodec: 'x264', bitrate: 1_000_000, size: 10 }),
				file({ height: 1080, videoCodec: 'x265', bitrate: 90_000_000, size: 100_000 }),
			);

			expect(better.order).toBe(1);
			expect(better.advantage).toBe('resolution');
			expect(better.reason).toContain('2160p');
		});

		it('prefers the more efficient codec at equal resolution', () => {
			const result = service.compare(
				file({ videoCodec: 'x265' }),
				file({ videoCodec: 'x264' }),
			);

			expect(result.order).toBe(1);
			expect(result.advantage).toBe('codec');
		});

		it('does not demote a file whose codec nobody reported', () => {
			// An unreported codec is a missing metadata field, not evidence of a bad
			// encode; ranking it last would have the gateway replace good files.
			const result = service.compare(file({ videoCodec: null }), file({ videoCodec: 'x264' }));

			expect(result.order).toBe(0);
		});

		it('falls back to bitrate once resolution and codec agree', () => {
			const result = service.compare(file({ bitrate: 12_000_000 }), file({ bitrate: 8_000_000 }));

			expect(result.order).toBe(1);
			expect(result.advantage).toBe('bitrate');
		});

		it('ignores a bitrate difference too small to mean anything', () => {
			const result = service.compare(file({ bitrate: 8_100_000 }), file({ bitrate: 8_000_000 }));

			expect(result.order).toBe(0);
		});

		it('only uses size when nothing else separates them', () => {
			const result = service.compare(
				file({ bitrate: null, size: 4_000_000_000 }),
				file({ bitrate: null, size: 1_000_000_000 }),
			);

			expect(result.advantage).toBe('size');
			expect(result.order).toBe(1);
		});

		it('says nothing about a file nobody has scanned', () => {
			expect(service.compare(null, file())).toEqual({
				order: 0,
				advantage: null,
				reason: null,
			});
		});

		it('is symmetric', () => {
			const left = file({ height: 2160 });
			const right = file({ height: 1080 });

			expect(service.compare(left, right).order).toBe(1);
			expect(service.compare(right, left).order).toBe(-1);
		});
	});

	describe('isBetter and isConflicting', () => {
		it('answers the question the sync actually asks', () => {
			expect(service.isBetter(file({ height: 2160 }), file({ height: 1080 }))).toBe(true);
			expect(service.isBetter(file({ height: 1080 }), file({ height: 2160 }))).toBe(false);
		});

		it('calls two cuts of different lengths a conflict', () => {
			expect(
				service.isConflicting(file({ durationMs: 7_200_000 }), file({ durationMs: 8_400_000 })),
			).toBe(true);
		});

		it('does not call a few seconds a different cut', () => {
			expect(
				service.isConflicting(file({ durationMs: 7_200_000 }), file({ durationMs: 7_210_000 })),
			).toBe(false);
		});

		it('refuses to guess without durations', () => {
			expect(service.isConflicting(file({ durationMs: null }), file())).toBe(false);
		});

		it('does not read a second of a four-second clip as a different cut', () => {
			// The owner's two copies of Big Buck Bunny, to the millisecond. Twenty-four
			// percent apart and one second apart: the proportional rule said different
			// cut, correlation vetoed the pair, and the film had two posters for ever.
			expect(
				service.isConflicting(file({ durationMs: 4_000 }), file({ durationMs: 3_023 })),
			).toBe(false);
		});

		it('still separates a short whose difference is long enough to be a cut', () => {
			// Five minutes against four is a minute of content, well past the floor, and
			// the floor must not become a licence to merge anything brief.
			expect(
				service.isConflicting(file({ durationMs: 300_000 }), file({ durationMs: 240_000 })),
			).toBe(true);
		});

		it('leaves a feature film exactly where it was', () => {
			// The floor only ever applies under ten minutes of runtime, since five percent
			// of anything longer already exceeds thirty seconds. Two minutes and one
			// second apart on a three-hour film is still two cuts.
			expect(
				service.isConflicting(file({ durationMs: 11_640_000 }), file({ durationMs: 11_519_000 })),
			).toBe(true);
			expect(
				service.isConflicting(file({ durationMs: 11_640_000 }), file({ durationMs: 11_521_000 })),
			).toBe(false);
		});
	});
});
