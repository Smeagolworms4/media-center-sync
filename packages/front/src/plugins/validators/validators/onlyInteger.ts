import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function onlyInteger (
	this: any,
	{ message }: {
		message?: string;
	} = {}): Validator {
	return (v: string) => Native.empty(v) || /^-?\d*$/.test(v) || message || this.$t('validators.only_number');
}
