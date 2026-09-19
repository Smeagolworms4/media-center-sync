import type { Validator } from '../index';
import { Native } from '@/libs/utils';

const RANGES: [number, number][] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
];

/**
 * Five-field cron, checked field by field rather than with one long regular
 * expression, because the answer "this is not a cron expression" is useless when
 * the mistake is a 13th month.
 */
function validField (field: string, [min, max]: [number, number]): boolean {
	return field.split(',').every(part => {
		const [value, step] = part.split('/');
		if (step !== undefined && !/^\d+$/.test(step)) {
			return false;
		}
		if (step !== undefined && Number(step) === 0) {
			return false;
		}
		if (value === '*') {
			return true;
		}
		const bounds = value.split('-');
		if (bounds.length > 2) {
			return false;
		}
		const numbers = bounds.map(one => (/^\d+$/.test(one) ? Number(one) : Number.NaN));
		if (numbers.some(one => Number.isNaN(one) || one < min || one > max)) {
			return false;
		}
		return numbers.length === 1 || numbers[0] <= numbers[1];
	});
}

export default function cron (
	this: any,
	{
		message,
	}: {
		message?: string;
	} = {}): Validator {
	return (v: any) => {
		if (Native.empty(v)) {
			return true;
		}
		const fields = String(v).trim().split(/\s+/);
		const sized = fields.length === RANGES.length;
		const ok = sized && fields.every((field, index) => validField(field, RANGES[index]));
		return ok || message || this.$t('validators.cron');
	};
}
