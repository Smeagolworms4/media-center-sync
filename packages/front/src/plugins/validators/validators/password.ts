import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function password(
	this: any,
	{
		message,
		length = 8
	}: {
		message?: string,
		length?: number
	} = {}): Validator {

	return (v: string) =>
		Native.empty(v) || (v.length >= 8 && !!v.match(/[0-9]/) && !!v.match(/[a-z]/) && !!v.match(/[A-Z]/)) || message || this.$t('front.validators.password', { length })
	;
}
