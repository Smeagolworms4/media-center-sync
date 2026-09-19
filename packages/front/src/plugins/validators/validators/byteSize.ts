import type { Validator } from '../index';
import { Native } from '@/libs/utils';

/**
 * A size typed the way people say it — `512M`, `2G`, `4096` — for the chunk size
 * and the rate limits. The API takes a byte count; this only checks that what was
 * typed can be turned into one.
 */
const PATTERN = /^\d+(?:[.,]\d+)?\s*([kmgt]?)b?$/i;

export default function byteSize (
	this: any,
	{
		message,
		min = null,
		max = null,
	}: {
		message?: string;
		min?: Nullable<number>;
		max?: Nullable<number>;
	} = {}): Validator {
	return (v: any) => {
		if (Native.empty(v)) {
			return true;
		}
		const match = PATTERN.exec(String(v).trim());
		if (!match) {
			return message || this.$t('validators.byte_size');
		}
		const multipliers: Record<string, number> = {
			'': 1,
			'k': 1024,
			'm': 1024 ** 2,
			'g': 1024 ** 3,
			't': 1024 ** 4,
		};
		const digits = Number.parseFloat(String(v).trim().replace(',', '.'));
		const bytes = digits * multipliers[match[1].toLowerCase()];
		if (min !== null && bytes < min) {
			return message || this.$t('validators.byte_size');
		}
		if (max !== null && bytes > max) {
			return message || this.$t('validators.byte_size');
		}
		return true;
	};
}
