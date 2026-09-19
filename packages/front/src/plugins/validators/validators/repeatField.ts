import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function repeatField(
	this: any,
	{
		repeat,
		message,
	}: {
		repeat: () => string,
		message?: string,
	}): Validator {
	return (v: string) => Native.empty(v) || v === repeat() || message || this.$t('front.validators.repeat_field');
}
