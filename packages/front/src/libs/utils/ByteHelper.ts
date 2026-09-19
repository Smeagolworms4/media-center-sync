export function byte2Human (value: number, unit = 'B'): string {
	const units = [unit, `K${unit}`, `M${unit}`, `G${unit}`, `T${unit}`];
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/** Binary multiples, the ones every filesystem and media server reports. */
const BYTE_MULTIPLIERS: Record<string, number> = {
	'': 1,
	'k': 1024,
	'm': 1024 ** 2,
	'g': 1024 ** 3,
	't': 1024 ** 4,
};

const HUMAN_SIZE = /^(\d+)\s*([kmgt]?)b?$/i;

export function human2Byte (value: string | number): number {
	if (typeof value === 'number') {
		return value;
	}
	const match = HUMAN_SIZE.exec(value.trim());
	if (!match) {
		return Number.NaN;
	}
	return Number.parseInt(match[1], 10) * BYTE_MULTIPLIERS[match[2].toLowerCase()];
}
