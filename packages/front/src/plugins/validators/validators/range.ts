import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function range(
	this: any,
	{
		min,
		max,
		messageMin,
		messageMax
	}: {
		min?: number,
		max?: number,
		messageMin?: string,
		messageMax?: string
	} = {}): Validator {
	return (v: number) => {
		if (!Native.empty(v)) {
			if (min !== null && typeof min !== 'undefined') {
				if (v < min) {
					return messageMin || this.$t('front.validators.range.min', { min });
				}
			}
			if (max !== null && typeof max !== 'undefined') {
				if (v > max) {
					return messageMax || this.$t('front.validators.range.max', { max });
				}
			}
		}
		return true;
	};
}
