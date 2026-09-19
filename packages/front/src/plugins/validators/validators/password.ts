import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function password (
	this: any,
	{
		message,
		length = 8,
	}: {
		message?: string;
		length?: number;
	} = {}): Validator {
	return (v: string) =>
		Native.empty(v) || (v.length >= 8 && !!/\d/.test(v) && !!/[a-z]/.test(v) && !!/[A-Z]/.test(v)) || message || this.$t('validators.password', { length })
	;
}
