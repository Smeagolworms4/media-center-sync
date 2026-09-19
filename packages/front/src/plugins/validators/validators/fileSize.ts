import type { Validator } from '../index';
import { byte2Human, Native } from '@/libs/utils';

export default function fileSize (
	this: any,
	{
		size,
		message,
	}: {
		size: number;
		message?: string;
	}): Validator {
	return (v: any) => {
		if (!Native.empty(v)) {
			v = Array.isArray(v) ? v : [v];
			for (const file of v) {
				if (file.size > size) {
					return message || this.$t('validators.file_size', { size: (byte2Human(size, this.$t('general.byte_unit'))) });
				}
			}
		}
		return true;
	};
}
