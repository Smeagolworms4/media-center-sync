import type { Validator } from '../index';

export default function notNull (
	this: any,
	{
		message,
	}: {
		message?: string;
	} = {}): Validator {
	return (v: any) => (v !== null) || message || this.$t('validators.not_null');
}
