import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function email (
	this: any,
	{ message }: {
		message?: string;
	} = {}): Validator {
	return (v: string) => Native.empty(v) || /^(?:[^<>()[\].,;:\s@"]+(?:\.[^<>()[\].,;:\s@"]+)*|".+")@(?:[^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{2,}$/.test(v) || message || this.$t('validators.email');
}
