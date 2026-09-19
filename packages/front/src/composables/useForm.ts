import { reactive, readonly, ref, toValue, type MaybeRefOrGetter } from 'vue';
import type { VForm } from 'vuetify/components';
import type { ValidationRule } from 'vuetify/framework';
import { useApiError } from '@/hooks/useApiError';

export type RuleResult = string | boolean;
export type Rule = (value: unknown) => RuleResult | PromiseLike<RuleResult>;

interface UseFormOptionsField {
	rules?: MaybeRefOrGetter<Rule[]>;
	[name: string]: MaybeRefOrGetter<unknown>;
}

interface UseFormOptions {
	beforeValidate?: () => Promise<undefined | boolean> | undefined | boolean;
	handle: () => Promise<void> | void;
	fallbackError?: MaybeRefOrGetter<string>;
	fields?: MaybeRefOrGetter<Record<string, MaybeRefOrGetter<UseFormOptionsField>>>;
}

export interface FieldBindings {
	'error-messages': string[];
	rules?: ValidationRule[];
	[name: string]: never | string[] | ValidationRule[] | undefined;
}

export interface IForm {
	loading: boolean;
	mainError: string | null;
	component: VForm | null;
	handle: () => Promise<void>;
	field: (name: string) => FieldBindings;
	setFieldErrors: (errors: Record<string, string[]>) => void;
}

export function useForm(options: UseFormOptions): IForm {
	const { parseApiError } = useApiError();
	const loading = ref(false);
	const mainError = ref<string | null>(null);
	const fieldErrors = ref<Record<string, string[]>>({});
	const mappedFields = new Set<string>();
	const component = ref<VForm | null>(null);

	async function parseError(error: unknown): Promise<void> {
		console.error(error);
		const parsed = await parseApiError(error, {
			fallback: toValue(options.fallbackError) ?? 'front.error.general',
			mappedFields,
		});
		mainError.value = parsed.mainError;
		fieldErrors.value = parsed.fieldErrors;
	}

	async function handle(): Promise<void> {
		mainError.value = null;
		fieldErrors.value = {};
		loading.value = true;
		try {
			component.value?.resetValidation();
			if ((await options.beforeValidate?.()) === false) return;
			const result = await component.value?.validate();
			if (result?.valid !== false) {
				await options.handle();
			}
		} catch (error) {
			await parseError(error);
		} finally {
			loading.value = false;
		}
	}

	function setFieldErrors(errors: Record<string, string[]>): void {
		fieldErrors.value = { ...fieldErrors.value, ...errors };
	}

	function field(name: string): FieldBindings {
		mappedFields.add(name);
		const raw = toValue(toValue(options.fields ?? {})[name] ?? {});
		const { rules, 'error-messages': errorMessagesRaw, ...extra } = raw;
		const errorMessages = typeof errorMessagesRaw === 'string' ? [errorMessagesRaw] : (errorMessagesRaw as string[] | undefined);

		const wrappedRules = toValue(rules ?? []).map((fc): ValidationRule => async (v: unknown) => {
			const result = await fc(v);
			return result;
		});

		const resolvedExtra: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(extra)) {
			resolvedExtra[k] = toValue(v);
		}

		return {
			'error-messages': [...(fieldErrors.value[name] ?? []), ...(errorMessages ?? [])],
			rules: wrappedRules,
			...resolvedExtra,
		} as FieldBindings;
	}

	const form = reactive({
		loading: readonly(loading),
		mainError: readonly(mainError),
		handle,
		field,
		setFieldErrors,
	}) as IForm;

	// `component` non-énumérable : la VForm contient un cycle vnode → component qui
	// crashe JSON.stringify (Storybook source decorator, devtools).
	Object.defineProperty(form, 'component', {
		get: () => component.value,
		set: (v: IForm['component']) => { component.value = v; },
		enumerable: false,
		configurable: true,
	});

	return form;
}
