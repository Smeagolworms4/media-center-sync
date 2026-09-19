import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function url(
	this: any,
	{
		message
	}: {
		message?: string
	} = {}): Validator {
	return (v: any) => {
		if (Native.empty(v)) {
			return true;
		}
		try {
			new URL(v);
			return true;
		} catch(_e) {
			return message || this.$t('front.validators.url');
		}
	};
}
