const formatLocale = (locale: string) => locale.replace(/_/, '-');

export function toDate (
	value: number | Date | null | string | undefined,
	locale: string,
	options: Intl.DateTimeFormatOptions = {},
	timeZone?: string,
): string {
	locale = formatLocale(locale);
	if (value === null || value === undefined) {
		return '';
	}
	const date = new Date(value);
	return new Intl.DateTimeFormat(locale, {
		...(timeZone ? { timeZone } : {}),
		...options,
	}).format(date);
}

/**
 * Date courte (jj/mm/aaaa). Renvoie `fallback` si la valeur est vide ou invalide
 * (RCU renvoie souvent une chaîne vide, ex. `dateResiliation`).
 */
export function toShortDate (
	value: number | Date | null | string | undefined,
	locale: string,
	fallback = '',
): string {
	if (!value) {
		return fallback;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return fallback;
	}
	return toDate(date, locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function toDateTime (
	value: number | Date | null | string | undefined,
	locale: string,
	options: Intl.DateTimeFormatOptions = {},
	timeZone?: string,
): string {
	if (value === null || value === undefined) {
		return '';
	}
	return toDate(new Date(value), locale, {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		...options,
	}, timeZone);
}

export function toTime (
	value: number | Date | null | undefined,
	locale: string,
	options: Intl.DateTimeFormatOptions = {},
	timeZone?: string,
): string {
	if (value === null || value === undefined) {
		return '';
	}
	return toDate(new Date(value), locale, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		...options,
	}, timeZone);
}

export function toCaretDate (value: number | string | Date, utc = false): string {
	if (typeof value === 'string') {
		value = new Date(value);
	}

	if (typeof value === 'number') {
		const date = new Date();
		date.setTime(value);
		value = date;
	}

	const year = utc ? value.getUTCFullYear() : value.getFullYear();
	const month = String((utc ? value.getUTCMonth() : value.getMonth()) + 1).padStart(2, '0'); // Les mois commencent à 0
	const day = String(utc ? value.getUTCDate() : value.getDate()).padStart(2, '0');

	return `${year}-${month}-${day}`;
}

export function fromCaretDate (value?: string | null): Nullable<Date> {
	if (value) {
		const date = new Date();
		const split = value.split('-');
		if (split.length === 3) {
			const year = Number.parseInt(split[0], 10);
			const month = Number.parseInt(split[1], 10) - 1;
			const day = Number.parseInt(split[2], 10);
			if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
				date.setFullYear(year, month, day);
				return Number.isNaN(date.getTime()) ? null : date;
			}
		}
	}
	return null;
}
