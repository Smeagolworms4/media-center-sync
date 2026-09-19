import type { Validator } from '../index';
import { Native } from '@/libs/utils';

export default function object(
	this: any,
	{
		rules,
	}: {
		rules: Record<string, Validator[]>,
	}): Validator {
	return (v: any) => {
		if (!Native.empty(v)) {
			for (const [key, ruleList] of Object.entries(rules)) {
				for (const rule of ruleList) {
					const result = rule(v[key]);
					if (result !== true) {
						return `${key}: ${result}`;
					}
				}
			}
		}
		return true;
	};
}
