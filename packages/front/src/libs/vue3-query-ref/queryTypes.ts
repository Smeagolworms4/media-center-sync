import type { QueryRefParser } from '@/libs/vue3-query-ref/queryRef';
import { fromCaretDate, toCaretDate } from '@/libs/utils';

function firstParam(v: string | string[] | undefined): string | null {
	return (Array.isArray(v) ? v[0] : v) ?? null;
}

export interface QueryTypesOptions<D = any, V = D> {
	validate?: (v: V) => boolean;
	defaultValue?: D|null
}

export const queryTypes =  {
	string: (
		{
			validate = () => true,
			defaultValue = null,
		}: QueryTypesOptions<string> = {}
	) => ({
		parse: (v) => {
			// firstParam(v) === null ? null : firstParam(v);
			const value = firstParam(v);
			return value !== null && validate!(value) ? value : defaultValue;
		},
		serialize: (v) => v,
		defaultValue,
	} as QueryRefParser<string>),
	integer:  (
		{
			validate = () => true,
			defaultValue = null,
		}: QueryTypesOptions<number> = {}
	) => ({
		parse: (v) => {
			const first = firstParam(v);
			const value = first !== null ? parseInt(first, 10) : null;
			if (value === null || isNaN(value)) {
				return defaultValue;
			}
			return validate!(value) ? value : defaultValue;
		},
		serialize: (v) => Math.floor(v).toFixed(0),
		defaultValue,
	} as QueryRefParser<number>),
	float: (
		{
			validate = () => true,
			defaultValue = null,
			round = null,
			fixed = null,
		}: QueryTypesOptions<number> & { round?: Nullable<number>, fixed?: Nullable<number>,  } = {}
	) => ({
		parse: (v) => {
			const first = firstParam(v);
			const value = first !== null ? parseFloat(first) : null;
			if (value === null || isNaN(value)) {
				return defaultValue;
			}
			return validate!(value) ? value : defaultValue;
		},
		serialize: (v) => {
			if (round !== null && isNaN(round)) {
				v = Math.round(v * (10 ** round)) / (10 ** round);
			}
			return fixed === null || isNaN(fixed) ? v.toString() : v.toFixed(fixed);
		},
		defaultValue,
	} as QueryRefParser<number>),
	boolean: (
		{
			validate = () => true,
			defaultValue = false,
			falseRemove = true,
			serializeNumber = true,
		}: QueryTypesOptions<boolean> & {
			falseRemove?: boolean,
			serializeNumber?: boolean,
		} = {}
	) => ({
		parse: (v) => {
			const first = firstParam(v);
			const value = first !== null ? (first.toLowerCase() !== 'false' && v !== '0') : null;
			return value !== null && validate!(value) ? value : defaultValue;
		},
		serialize: (v) => v ? (serializeNumber ? '1' : 'true') : (falseRemove ? null : (serializeNumber ? '0' : 'false')),
		defaultValue,
	} as QueryRefParser<boolean>),

	timestamp: (
		{
			validate = () => true,
			defaultValue = null,
		}: QueryTypesOptions<Date> = {}
	) => ({
		parse: (v) => {
			const value = firstParam(v);
			if (value !== null) {
				const t = parseInt(value, 10);
				const date = new Date();
				date.setTime(t);
				if (!isNaN(date.getTime()) && validate!(date)) {
					return date;
				}
			}
			return defaultValue;
		},
		serialize: (v) => isNaN(v.getTime()) ? '' : v.getTime().toString(),
		defaultValue,
	} as QueryRefParser<Date>),
	isoDateTime: (
		{
			validate = () => true,
			defaultValue = null,
		}: QueryTypesOptions<Date> = {}
	) => ({
		parse: (v) => {
			const value = firstParam(v);
			if (value !== null) {
				const date = new Date(value);
				if (!isNaN(date.getTime()) && validate!(date)) {
					return date;
				}
			}
			return defaultValue;
		},
		serialize: (v) => isNaN(v.getTime()) ? '' : v.toISOString(),
		defaultValue,
	} as QueryRefParser<Date>),
	isoDate: (
		{
			validate = () => true,
			defaultValue = null,
		}: QueryTypesOptions<Date> = {}
	) => ({
		parse: (v) => {
			const value = firstParam(v);
			if (value !== null) {
				const date = fromCaretDate(value);
				if (date) {
					return date;
				}
			}
			return defaultValue;
		},
		serialize: (v) => isNaN(v.getTime()) ? '' : toCaretDate(v),
		defaultValue,
	} as QueryRefParser<Date>),
	stringEnum: <Enum extends string>(
		{
			values,
			validate = () => true,
			defaultValue = null,
		}: {
			values: Enum[]
		} & QueryTypesOptions<Enum>
	) => ({
		parse: (v) => {
			const value = firstParam(v);
			if (value !== null && values.includes(value as Enum) && validate!(value as Enum)) {
				return value;
			}
			return defaultValue;
		},
		serialize: (v) => v,
		defaultValue,
	} as QueryRefParser<Enum>),
	json: <T = any>(
		{
			validate = () => true,
			defaultValue = null,
		}: QueryTypesOptions<T, any> = {}
	) => ({
		parse: (v) => {
			try {
				const first = firstParam(v);
				if (first !== null ){
					const value = JSON.parse(first);
					if (validate!(value)) {
						return value;
					}
				}
			} catch (_e) {
			}
			return defaultValue;
		},
		serialize: (v) => JSON.stringify(v),
		defaultValue,
	} as QueryRefParser<T>),
	array: <I = any>(
		{
			itemParse = param => param as any,
			itemSerialize = v => String(v),
			validate = () => true,
			defaultValue = null,
		}: {
			itemParse?: (param: string) => I,
			itemSerialize?: (v: I) => string,
		} & QueryTypesOptions<I[]> = {}
	) => ({
		parse: (v) => {
			if (typeof v === 'string') {
				v = [ v ];
			}
			const ar = v.map(param => itemParse!(param));
			return validate(ar) ? ar : defaultValue;
		},
		serialize: (v) => v.map(data => itemSerialize!(data)),
		defaultValue,
	} as QueryRefParser<I[]>),
	delimitedArray: <I = any>(
		{
			separator = ',',
			itemParse = param => param as any,
			itemSerialize = v => String(v),
			validate = () => true,
			defaultValue = null,
		}: {
			separator?: string,
			itemParse?: (param: string) => I,
			itemSerialize?: (v: I) => string,
		} & QueryTypesOptions<I[]> = {}
	) => ({
		parse: (v) => {
			const first = firstParam(v);
			if (first !== null) {
				const arStr = first.split(separator!);
				const ar = arStr.map(param => itemParse!(param));
				if (validate(ar)) {
					return ar;
				}
			}
			return defaultValue ?? null;
		},
		serialize: (v) => v.map(data => itemSerialize!(data)).join(separator),
		defaultValue,
	} as QueryRefParser<I[]>),
}
