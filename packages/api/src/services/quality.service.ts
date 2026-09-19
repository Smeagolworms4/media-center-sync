import type { MediaFileInfo, QualitySummary, QualityVariant } from '@mcs/shared';
import { Injectable } from '@nestjs/common';

/**
 * Height thresholds for a resolution label.
 *
 * Derived from the height rather than the width, because a 2.35:1 film is 1920 wide
 * at 800 tall and calling that 1080p would be a lie the comparator then acts on.
 * The bands are generous on purpose: cropped masters land a few dozen lines short
 * of the nominal height and are still, to anybody looking at them, 1080p.
 */
const RESOLUTION_BANDS: { minHeight: number; label: string }[] = [
	{ minHeight: 1700, label: '2160p' },
	{ minHeight: 900, label: '1080p' },
	{ minHeight: 650, label: '720p' },
	{ minHeight: 540, label: '576p' },
	{ minHeight: 1, label: '480p' },
];

/**
 * Codec names, folded onto one spelling each.
 *
 * `hevc`, `h265`, `h.265` and `x265` are the same decoder and three different
 * habits of naming it — one is the standard, one the encoder, one a container's
 * idea of the standard. Left unfolded they produce four variants of a season that
 * is in fact uniform, and the summary says `mixed` about a library that is not.
 */
const VIDEO_CODEC_ALIASES: Record<string, string> = {
	hevc: 'x265',
	h265: 'x265',
	'h.265': 'x265',
	x265: 'x265',
	avc: 'x264',
	h264: 'x264',
	'h.264': 'x264',
	x264: 'x264',
	avc1: 'x264',
	mpeg4: 'xvid',
	xvid: 'xvid',
	divx: 'xvid',
	'msmpeg4v3': 'xvid',
	av1: 'av1',
	vp9: 'vp9',
	vp8: 'vp8',
	mpeg2video: 'mpeg2',
	mpeg2: 'mpeg2',
};

const AUDIO_CODEC_ALIASES: Record<string, string> = {
	'e-ac-3': 'eac3',
	eac3: 'eac3',
	ec3: 'eac3',
	ddp: 'eac3',
	'ac-3': 'ac3',
	ac3: 'ac3',
	dd: 'ac3',
	'dts-hd': 'dtshd',
	dtshd: 'dtshd',
	dtsma: 'dtshd',
	dts: 'dts',
	truehd: 'truehd',
	'mlp': 'truehd',
	aac: 'aac',
	'aac-lc': 'aac',
	mp3: 'mp3',
	flac: 'flac',
	opus: 'opus',
	vorbis: 'vorbis',
	pcm: 'pcm',
	lpcm: 'pcm',
};

/**
 * How much picture a codec buys per bit, ranked.
 *
 * Only the order matters. An unknown codec is ranked with AVC rather than at the
 * bottom: a file whose codec the service never reported is not evidence of a bad
 * encode, and putting it last would have the gateway replacing perfectly good files
 * with nothing better than a filled-in metadata field.
 */
const CODEC_EFFICIENCY: Record<string, number> = {
	av1: 4,
	x265: 3,
	vp9: 3,
	x264: 2,
	vp8: 1,
	xvid: 1,
	mpeg2: 0,
};

const UNKNOWN_CODEC_EFFICIENCY = 2;

/** Below these, two files are the same file as far as anybody watching is concerned. */
const BITRATE_SIGNIFICANCE = 0.1;
const SIZE_SIGNIFICANCE = 0.05;

/** Why one file beats another, in the order the comparator applies the rules. */
export type QualityAdvantage = 'resolution' | 'codec' | 'bitrate' | 'size' | null;

export interface QualityComparison {
	/** Positive when the candidate wins, negative when it loses, zero when neither. */
	order: number;
	advantage: QualityAdvantage;
	/** A sentence for `MediaMatch.reason`, null when nothing separates them. */
	reason: string | null;
}

/**
 * Everything the gateway says about how good a file, or a pile of files, is.
 *
 * Two jobs that have to agree with each other: describing what a node holds, and
 * deciding whether somebody else's copy is better than ours. They share the codec
 * and resolution normalisation, because a summary that groups two files together
 * while the comparator ranks one above the other is how an `IN_SYNC` season starts
 * re-downloading itself every night.
 */
@Injectable()
export class QualityService {
	/** `2160p`, `1080p`… or null when the height is unknown or nonsense. */
	public resolutionLabel(height: number | null): string | null {
		if (height === null || !Number.isFinite(height) || height <= 0) {
			return null;
		}

		return RESOLUTION_BANDS.find((band) => height >= band.minHeight)?.label ?? null;
	}

	public normalizeVideoCodec(codec: string | null): string | null {
		return this._normalizeCodec(codec, VIDEO_CODEC_ALIASES);
	}

	public normalizeAudioCodec(codec: string | null): string | null {
		return this._normalizeCodec(codec, AUDIO_CODEC_ALIASES);
	}

	/**
	 * Group a set of files into the distinct encodings they represent.
	 *
	 * A library is rarely uniform — a season ripped twice, three episodes re-encoded,
	 * one left in 720p — and the only summary that does not lie is the dominant
	 * encoding plus an honest `mixed` flag, with the variants kept for the tooltip
	 * that answers "which episode is the odd one".
	 */
	public summarise(files: (MediaFileInfo | null | undefined)[]): QualitySummary {
		const present = files.filter((file): file is MediaFileInfo => !!file);
		const grouped = new Map<string, QualityVariant>();
		let totalBytes = 0;

		for (const file of present) {
			const variant = this.describe(file);
			const key = this._variantKey(variant);
			const existing = grouped.get(key);

			totalBytes += Math.max(0, file.size || 0);

			if (existing) {
				existing.count += 1;
				existing.bytes += Math.max(0, file.size || 0);
			} else {
				grouped.set(key, variant);
			}
		}

		// Most common first, and the larger group wins a tie: when a season is split
		// evenly between two encodings, the one holding more bytes is the one somebody
		// chose, and the other is the leftover.
		const variants = [...grouped.values()].sort(
			(left, right) => right.count - left.count || right.bytes - left.bytes,
		);

		const dominant = variants[0] ?? null;

		return {
			label: variants.length > 1 ? 'mixed' : (dominant?.label ?? 'unknown'),
			mixed: variants.length > 1,
			dominant,
			variants,
			fileCount: present.length,
			totalBytes,
		};
	}

	/** One file as a variant of one, which is what the grouping is built from. */
	public describe(file: MediaFileInfo): QualityVariant {
		const videoCodec = this.normalizeVideoCodec(file.videoCodec);
		const resolution = this.resolutionLabel(file.height);
		const hdr = this._detectHdr(file);
		const audioCodec = this.normalizeAudioCodec(file.audioCodec);
		const audioChannels = this._detectChannels(file);

		return {
			label: this._label(videoCodec, resolution, hdr),
			videoCodec,
			resolution,
			hdr,
			audioCodec,
			audioChannels,
			container: file.container?.toLowerCase() ?? null,
			count: 1,
			bytes: Math.max(0, file.size || 0),
		};
	}

	/**
	 * Is the candidate a better copy than the one we hold?
	 *
	 * Height first, then codec efficiency, then bitrate, then size — and size last
	 * for a reason worth spelling out: size alone is the worst signal in the set. A
	 * bloated 1080p remux is four times the size of a careful 2160p x265 encode and
	 * worse to watch; a badly upscaled 4K file is enormous and contains no more
	 * picture than the 1080p it came from. Size only means anything once resolution
	 * and codec are equal, where it stands in for "how hard the encoder was pushed",
	 * and even then only when the difference is large enough to be deliberate.
	 */
	public compare(
		candidate: MediaFileInfo | null,
		current: MediaFileInfo | null,
	): QualityComparison {
		if (!candidate || !current) {
			// Nothing can be said about a file nobody has looked at yet, and answering
			// "better" here would have a sync replace files on the strength of an
			// unscanned row.
			return { order: 0, advantage: null, reason: null };
		}

		const candidateHeight = candidate.height ?? 0;
		const currentHeight = current.height ?? 0;
		const candidateResolution = this.resolutionLabel(candidate.height);
		const currentResolution = this.resolutionLabel(current.height);

		if (candidateResolution !== currentResolution && (candidateHeight || currentHeight)) {
			const order = candidateHeight - currentHeight;

			return {
				order: Math.sign(order),
				advantage: 'resolution',
				reason:
					order > 0
						? `higher resolution (${candidateResolution ?? 'unknown'} over ${currentResolution ?? 'unknown'})`
						: `lower resolution (${candidateResolution ?? 'unknown'} against ${currentResolution ?? 'unknown'})`,
			};
		}

		const candidateCodec = this.normalizeVideoCodec(candidate.videoCodec);
		const currentCodec = this.normalizeVideoCodec(current.videoCodec);
		const candidateEfficiency = this._efficiency(candidateCodec);
		const currentEfficiency = this._efficiency(currentCodec);

		if (candidateEfficiency !== currentEfficiency) {
			const order = candidateEfficiency - currentEfficiency;

			return {
				order: Math.sign(order),
				advantage: 'codec',
				reason:
					order > 0
						? `more efficient codec (${candidateCodec ?? 'unknown'} over ${currentCodec ?? 'unknown'})`
						: `less efficient codec (${candidateCodec ?? 'unknown'} against ${currentCodec ?? 'unknown'})`,
			};
		}

		const bitrateOrder = this._significantOrder(
			candidate.bitrate,
			current.bitrate,
			BITRATE_SIGNIFICANCE,
		);

		if (bitrateOrder !== 0) {
			return {
				order: bitrateOrder,
				advantage: 'bitrate',
				reason: bitrateOrder > 0 ? 'higher bitrate at equal resolution' : 'lower bitrate',
			};
		}

		const sizeOrder = this._significantOrder(candidate.size, current.size, SIZE_SIGNIFICANCE);

		if (sizeOrder !== 0) {
			return {
				order: sizeOrder,
				advantage: 'size',
				reason: sizeOrder > 0 ? 'larger file at equal resolution and codec' : 'smaller file',
			};
		}

		return { order: 0, advantage: null, reason: null };
	}

	/** The question the sync actually asks, phrased as it is asked. */
	public isBetter(candidate: MediaFileInfo | null, current: MediaFileInfo | null): boolean {
		return this.compare(candidate, current).order > 0;
	}

	/**
	 * Two copies that cannot be ordered — different cuts, different languages.
	 *
	 * Equal rank is not the same as equivalent: a 1080p x265 French dub and a 1080p
	 * x265 original are both "not better" than each other, and replacing one with the
	 * other would be a surprise. The duration is what separates a different cut from
	 * a different encode of the same cut, and it is the only field we have that says
	 * anything about content rather than about encoding.
	 */
	public isConflicting(left: MediaFileInfo | null, right: MediaFileInfo | null): boolean {
		if (!left || !right || left.durationMs === null || right.durationMs === null) {
			return false;
		}

		const longest = Math.max(left.durationMs, right.durationMs);

		if (longest <= 0) {
			return false;
		}

		// More than a two-minute difference, or five percent, is an extended cut, a
		// different regional master, or a file with the credits trimmed — not the same
		// thing encoded twice.
		const difference = Math.abs(left.durationMs - right.durationMs);

		return difference > 120_000 || difference / longest > 0.05;
	}

	private _normalizeCodec(codec: string | null, aliases: Record<string, string>): string | null {
		if (!codec) {
			return null;
		}

		const cleaned = codec.trim().toLowerCase().replace(/\s+/g, '');

		if (cleaned === '') {
			return null;
		}

		return aliases[cleaned] ?? cleaned;
	}

	private _label(
		videoCodec: string | null,
		resolution: string | null,
		hdr: string | null,
	): string {
		const parts = [videoCodec, resolution, hdr].filter((part): part is string => !!part);

		return parts.length > 0 ? parts.join(' · ') : 'unknown';
	}

	private _variantKey(variant: QualityVariant): string {
		return [
			variant.videoCodec,
			variant.resolution,
			variant.hdr,
			variant.audioCodec,
			variant.audioChannels,
			variant.container,
		].join('|');
	}

	private _efficiency(codec: string | null): number {
		if (codec === null) {
			return UNKNOWN_CODEC_EFFICIENCY;
		}

		return CODEC_EFFICIENCY[codec] ?? UNKNOWN_CODEC_EFFICIENCY;
	}

	/**
	 * Compare two numbers, ignoring differences too small to mean anything.
	 *
	 * Without the floor, a transfer would be started to replace a file with one that
	 * is two percent larger, forever, in both directions.
	 */
	private _significantOrder(
		candidate: number | null,
		current: number | null,
		significance: number,
	): number {
		if (!candidate || !current || candidate <= 0 || current <= 0) {
			return 0;
		}

		const largest = Math.max(candidate, current);
		const difference = candidate - current;

		if (Math.abs(difference) / largest < significance) {
			return 0;
		}

		return Math.sign(difference);
	}

	/**
	 * HDR and channel layout, read off the path.
	 *
	 * Neither Jellyfin nor Plex reports them in the shape `MediaFileInfo` carries, and
	 * `QualityVariant` has a field for both — so the only source left is the name the
	 * release was given, which for once is reliable: nobody encodes Dolby Vision and
	 * forgets to say so in the filename. A miss costs a slightly vaguer label, never a
	 * wrong comparison, because neither field is ranked.
	 */
	private _detectHdr(file: MediaFileInfo): string | null {
		const haystack = `${file.path ?? ''}`.toLowerCase();

		if (/\b(dolby[ ._-]?vision|dovi|\bdv\b)\b/.test(haystack)) {
			return 'DV';
		}

		if (/hdr10\+|hdr10plus/.test(haystack)) {
			return 'HDR10+';
		}

		if (/\bhdr(10)?\b/.test(haystack)) {
			return 'HDR10';
		}

		if (/\bhlg\b/.test(haystack)) {
			return 'HLG';
		}

		return null;
	}

	private _detectChannels(file: MediaFileInfo): string | null {
		const match = /\b([1-9])[._]([01])\b/.exec(`${file.path ?? ''}`);

		return match ? `${match[1]}.${match[2]}` : null;
	}
}
