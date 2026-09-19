import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function regExp(
	this: any,
	{
		regExp,
		message
	}: {
		regExp: RegExp,
		message?: string
	}): Validator {
	return (v: any) => Native.empty(v) || regExp.test(v) || message || this.$t('front.validators.regExp', { source: regExp.source });
}
