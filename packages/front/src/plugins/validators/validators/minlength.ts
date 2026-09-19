import type { Validator } from '../index';
import { Native } from '@/libs/utils';

/**
 * A floor on a value's length, stated before the API states it.
 *
 * Empty passes on purpose, as everywhere else here: "this field is required" is
 * `required`'s sentence, and a field that answered both would show two errors for
 * one mistake.
 */
export default function minlength (
	this: any,
	{
		min,
		message,
	}: {
		min: number;
		message?: string;
	}): Validator {
	return (v: string) => {
		if (!Native.empty(v) && v.length < min) {
			return message || this.$t('validators.minlength', { min });
		}
		return true;
	};
}
