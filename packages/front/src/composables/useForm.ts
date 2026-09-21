import type { VForm } from 'vuetify/components';
import type { ValidationRule } from 'vuetify/framework';
import { computed, type MaybeRefOrGetter, reactive, readonly, ref, toValue } from 'vue';
import { useApiError } from '@/hooks/useApiError';

export type RuleResult = string | boolean;
export type Rule = (value: unknown) => RuleResult | PromiseLike<RuleResult>;

interface UseFormOptionsField {
	[name: string]: MaybeRefOrGetter<unknown>;
	rules?: MaybeRefOrGetter<Rule[]>;
}

interface UseFormOptions {
	beforeValidate?: () => Promise<undefined | boolean> | undefined | boolean;
	handle: () => Promise<void> | void;
	fallbackError?: MaybeRefOrGetter<string>;
	fields?: MaybeRefOrGetter<Record<string, MaybeRefOrGetter<UseFormOptionsField>>>;
}

export interface FieldBindings {
	[name: string]: never | string | string[] | ValidationRule[] | undefined;
	'error-messages': string[];
	'rules'?: ValidationRule[];
	/**
	 * The field's name, used as the control's DOM id.
	 *
	 * Set because Vuetify reports a failed rule against the input's id, and an
	 * auto-generated `input-47` cannot be matched back to the field it refused. It is
	 * what makes `refusedFields` able to name a field no server ever saw.
	 */
	'id'?: string;
}

export interface IForm {
	loading: boolean;
	mainError: string | null;
	/**
	 * The backend refusals, by field name.
	 *
	 * Exposed because `field()` alone only helps a control that is on screen. A form
	 * split across tabs, steps or collapsed sections can have a refused field the
	 * person cannot see: the screen reports that something was refused, shows no
	 * error anywhere visible, and leaves them pressing save again. Knowing which
	 * fields were refused is what lets a page point at the section holding them.
	 */
	fieldErrors: Record<string, string[]>;
	/** Every field the last submit refused, from a rule of ours or from the API. */
	refusedFields: Set<string>;
	component: VForm | null;
	handle: () => Promise<void>;
	field: (name: string) => FieldBindings;
	setFieldErrors: (errors: Record<string, string[]>) => void;
}

/**
 * The one way a form is written in this application.
 *
 * It owns the three things every form needs and nobody should re-invent: the
 * loading flag, the main error, and the mapping from backend field errors onto
 * the matching Vuetify inputs. `field(name)` both declares that the form renders
 * that field — which is how `useApiError` knows where a message belongs — and
 * returns the bindings to spread onto the control.
 */
export function useForm (options: UseFormOptions): IForm {
	const { parseApiError } = useApiError();
	const loading = ref(false);
	const mainError = ref<string | null>(null);
	const fieldErrors = ref<Record<string, string[]>>({});
	/** Fields our own rules refused on the last submit, by name. See `handle`. */
	const ruleErrors = ref<Set<string>>(new Set());
	const mappedFields = new Set<string>();
	const component = ref<VForm | null>(null);

	async function parseError (error: unknown): Promise<void> {
		console.error(error);
		const parsed = await parseApiError(error, {
			fallback: toValue(options.fallbackError) ?? 'error.general',
			mappedFields,
		});
		mainError.value = parsed.mainError;
		fieldErrors.value = parsed.fieldErrors;
	}

	async function handle (): Promise<void> {
		mainError.value = null;
		fieldErrors.value = {};
		ruleErrors.value = new Set();
		loading.value = true;
		try {
			component.value?.resetValidation();
			if ((await options.beforeValidate?.()) === false) {
				return;
			}
			const result = await component.value?.validate();
			if (result?.valid !== false) {
				await options.handle();
				return;
			}

			// A rule of our own refused, so nothing was ever sent — and until this
			// existed, nothing outside the input knew which field it was. Vuetify marks
			// the control and stops there, which is enough on a form somebody can see
			// whole and useless on one that is split: the settings screen saves every
			// pane at once, so a value refused on the peers pane left somebody on the
			// placement pane pressing save against a screen that said nothing at all.
			//
			// Kept apart from `fieldErrors` rather than merged into it, because that one
			// feeds each input's `error-messages` and Vuetify concatenates those with
			// its own rule messages — the same sentence would appear twice under the
			// field. What every caller actually wants is `refusedFields`, which does not
			// care which side refused.
			ruleErrors.value = new Set(
				result.errors
					.filter(entry => typeof entry.id === 'string' && entry.errorMessages.length > 0)
					.map(entry => String(entry.id)),
			);
		} catch (error) {
			await parseError(error);
		} finally {
			loading.value = false;
		}
	}

	function setFieldErrors (errors: Record<string, string[]>): void {
		fieldErrors.value = { ...fieldErrors.value, ...errors };
	}

	function field (name: string): FieldBindings {
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
			'id': name,
			'error-messages': [...(fieldErrors.value[name] ?? []), ...(errorMessages ?? [])],
			'rules': wrappedRules,
			// After the spread, so a caller that needs its own id still wins.
			...resolvedExtra,
		} as FieldBindings;
	}

	/**
	 * Every field the last submit refused, whoever refused it.
	 *
	 * The two sources are deliberately indistinguishable here: a form showing where a
	 * refusal is should not have to ask whether a rule or the API produced it, and the
	 * one screen that does ask would get it wrong the day a rule moves to the server.
	 */
	const refusedFields = computed(
		() => new Set([...Object.keys(fieldErrors.value), ...ruleErrors.value]),
	);

	const form = reactive({
		loading: readonly(loading),
		mainError: readonly(mainError),
		fieldErrors: readonly(fieldErrors),
		refusedFields,
		handle,
		field,
		setFieldErrors,
	}) as IForm;

	// `component` is deliberately non-enumerable: a VForm holds a vnode → component
	// cycle that makes JSON.stringify throw, which breaks the devtools inspector
	// and anything else that tries to serialise the form object.
	Object.defineProperty(form, 'component', {
		get: () => component.value,
		set: (v: IForm['component']) => {
			component.value = v;
		},
		enumerable: false,
		configurable: true,
	});

	return form;
}
