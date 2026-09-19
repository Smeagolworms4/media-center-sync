export function byte2Human(value: number, unit: string = 'B'): string {
	const units = [unit, `K${unit}`, `M${unit}`, `G${unit}`, `T${unit}`];
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	return `${value.toFixed(2)} ${units[unitIndex]}`;
}

export function human2Byte(value: string|number): number {
	if (typeof value === 'number') {
		return value;
	}
	return parseInt(value.replace(/^\s*(\d+)\s*(?:([kmgt]?)b?)?\s*$/i, (match, num, unit) => {
		let size = parseInt(num, 10);
		switch (unit?.toLowerCase()) {
			case 't': size *= 1024;
			case 'g': size *= 1024;
			case 'm': size *= 1024;
			case 'k': size *= 1024;
		}
		return size.toString();
	}), 10);
}
