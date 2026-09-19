import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function maxlength(
	this: any,
	{
		max,
		message
	}: {
		max: number,
		message?: string
	}): Validator {

	return (v: string) => {
		if (!Native.empty(v)) {
			if (v.length > max) {
				return message || this.$t('front.validators.maxlength', { max });
			}
		}
		return true;
	};
}
