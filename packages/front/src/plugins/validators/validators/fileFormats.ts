import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function fileFormats (
	this: any,
	{
		accepts,
		message,
	}: {
		accepts: string[];
		message?: string;
	}): Validator {
	return (v: any) => {
		if (!Native.empty(v)) {
			v = Array.isArray(v) ? v : [v];
			for (const file of v) {
				if (!accepts.includes(file.type)) {
					return message || this.$t('validators.file_formats');
				}
			}
		}
		return true;
	};
}
