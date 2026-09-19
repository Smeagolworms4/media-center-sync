import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function range (
	this: any,
	{
		min,
		max,
		messageMin,
		messageMax,
	}: {
		min?: number;
		max?: number;
		messageMin?: string;
		messageMax?: string;
	} = {}): Validator {
	return (v: number) => {
		if (!Native.empty(v)) {
			if (min !== null && min !== undefined && v < min) {
				return messageMin || this.$t('validators.range.min', { min });
			}
			if (max !== null && max !== undefined && v > max) {
				return messageMax || this.$t('validators.range.max', { max });
			}
		}
		return true;
	};
}
