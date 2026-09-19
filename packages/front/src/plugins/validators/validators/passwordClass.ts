import type { Validator } from '../index';
import { Native } from '@/libs/utils';

function validate(value: string, numClasses: number): boolean {
	let classes = 0;
	if (/[A-Z]/.test(value)) {
		classes++;
	}
	if (/[a-z]/.test(value)) {
		classes++;
	}
	if (/[0-9]/.test(value)) {
		classes++;
	}
	if (/[^A-Za-z0-9]/.test(value)) {
		classes++;
	}
	return classes >= numClasses;
}

export default function passwordClass(
	this: any,
	{
		message,
		numClasses = 1
	}: {
		message?: string,
		numClasses?: number
	} = {}): Validator {

	return (v: string) =>
		Native.empty(v) ||
		validate(v as string, numClasses) ||
		message ||
		this.$t('front.validators.passwordClass', { numClasses })
	;
}
