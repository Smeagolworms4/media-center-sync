import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function onlyLetters (
	this: any,
	{
		message,
	}: {
		message?: string;
	} = {}): Validator {
	return (v: any) => (/^[\p{Letter}\- ]*$/mu.test(v) || Native.empty(v)) || message || this.$t('validators.only_letters');
}
