import type { Validators } from '../index';
import { getCurrentInstance } from 'vue';

export function useValidators(): Validators {
	return (getCurrentInstance() as any)?.appContext?.config?.globalProperties?.$validators as Validators;
}
