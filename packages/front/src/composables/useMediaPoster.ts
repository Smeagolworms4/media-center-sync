/**
 * What a poster shows when there is no poster.
 *
 * Most of a self-hosted library has no artwork at all — a generated fixture, a
 * rip nobody tagged, a friend's server that never fetched metadata — so the
 * placeholder is not the edge case, it is what the wall is mostly made of. A
 * broken-image icon repeated forty times says nothing; initials on a colour that
 * is always the same for the same title give each tile an identity, which is what
 * lets somebody find a row again after scrolling past it.
 */

/**
 * A stable 32-bit hash of the title.
 *
 * Stable is the whole point: the same media has to land on the same colour on
 * every machine and after every reload, otherwise the wall reshuffles its palette
 * every time it is drawn and the colour carries no information at all.
 */
export function posterHash (seed: string): number {
	let hash = 0x81_1C_9D_C5;
	for (let index = 0; index < seed.length; index += 1) {
		// `Math.imul` rather than a plain multiplication: it is the only product in
		// JavaScript that stays a 32-bit integer, and a hash that silently becomes a
		// float loses its low bits — which are exactly the ones the hue is taken from.
		hash = Math.imul(hash ^ seed.codePointAt(index)!, 0x01_00_01_93);
	}
	return Math.abs(hash);
}

/**
 * Up to two initials, taken from the words that carry meaning.
 *
 * Articles are dropped because half a library would otherwise be a wall of `T`.
 */
const NOISE_WORDS = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du']);

export function posterInitials (title: string | null | undefined): string {
	const words = (title ?? '')
		.split(/[\s.:\-_]+/)
		.map(word => word.replace(/[^\p{L}\p{N}]/gu, ''))
		.filter(word => word.length > 0);

	const meaningful = words.filter(word => !NOISE_WORDS.has(word.toLowerCase()));
	const chosen = meaningful.length > 0 ? meaningful : words;

	if (chosen.length === 0) {
		return '?';
	}
	if (chosen.length === 1) {
		return chosen[0].slice(0, 2).toUpperCase();
	}
	return `${chosen[0][0]}${chosen[1][0]}`.toUpperCase();
}

export interface PosterPlaceholder {
	initials: string;
	/** A CSS gradient, ready for a `style` binding. */
	background: string;
}

/**
 * The placeholder for one title.
 *
 * Two stops of the same hue rather than a flat fill: a wall of flat rectangles
 * reads as a loading state, and a gradient reads as a deliberate cover.
 */
export function posterPlaceholder (title: string | null | undefined): PosterPlaceholder {
	const hue = posterHash(title ?? '') % 360;
	return {
		initials: posterInitials(title),
		background: `linear-gradient(150deg, hsl(${hue} 42% 32%), hsl(${(hue + 40) % 360} 38% 18%))`,
	};
}

export function useMediaPoster () {
	return { posterHash, posterInitials, posterPlaceholder };
}
