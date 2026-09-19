import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function onlyLetters(
	this: any,
	{
		message
	}: {
		message?: string
	} = {}): Validator {
	return (v: any) => (/^[a-zA-ZÀ-ÿ\- ]*$/gm.test(v) || Native.empty(v)) || message || this.$t('front.validators.only_letters');
}
