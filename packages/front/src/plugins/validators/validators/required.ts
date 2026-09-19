import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function required(
	this: any,
	{
		message
	}: {
		message?: string
	} = {}): Validator {
	return (v: any) => (!Native.empty(v) && v !== false) && !(Array.isArray(v) && v.length === 0) || message || this.$t('front.validators.required');
}
