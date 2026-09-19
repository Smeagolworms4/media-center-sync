import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function fileFormats(
	this: any,
	{
		accepts,
		message
	}: {
		accepts: string[],
		message?: string,
	}): Validator {
	return (v: any) => {
		if (!Native.empty(v)) {
			v = Array.isArray(v) ? v : [ v ];
			for (const file of v) {
				// Check type.
				console.log(file.type);
				if (accepts.indexOf(file.type) === -1) {
					return message || this.$t('front.validators.file_formats');
				}
			}
		}
		return true;
	};
}
