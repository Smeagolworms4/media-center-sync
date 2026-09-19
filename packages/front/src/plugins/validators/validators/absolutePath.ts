import type { Validator } from '../index';
import { Native } from '@/libs/utils';

/**
 * A path the gateway can resolve on its own filesystem.
 *
 * Relative paths are rejected because the gateway's working directory is an
 * implementation detail of its container, and `..` because a share path that can
 * climb out of its library is a way to hand a friend the whole disk.
 */
export default function absolutePath (
	this: any,
	{
		message,
	}: {
		message?: string;
	} = {}): Validator {
	return (v: any) => {
		if (Native.empty(v)) {
			return true;
		}
		const value = String(v);
		const absolute = value.startsWith('/');
		const contained = !value.split('/').includes('..');
		const printable = !/\0/.test(value);
		return (absolute && contained && printable) || message || this.$t('validators.absolute_path');
	};
}
