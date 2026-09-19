import type { IForm } from './useForm';
import type { ComponentInternalInstance, Directive, DirectiveBinding, VNode } from 'vue';

interface FormEl extends HTMLElement {
	__vformSubmitHandler?: (e: Event) => void;
}

/**
 * Wires an `IForm` (see `useForm`) onto a `<v-form>`.
 *
 * It hands the form its VForm instance, so `handle()` can validate and reset, and
 * it takes over the native submit event. Without it every consumer would have to
 * remember `@submit.prevent="form.handle"`, and the one that forgets reloads the
 * page instead of submitting.
 */
export const vForm: Directive<FormEl, IForm> = {
	mounted (el, binding: DirectiveBinding<IForm>, vnode: VNode) {
		const form = binding.value;
		if (!form) {
			return;
		}

		const fallbackCtx = (vnode as VNode & { ctx?: ComponentInternalInstance | null }).ctx;
		const instance = (vnode.component ?? fallbackCtx) as ComponentInternalInstance | null;

		if (instance) {
			form.component = (instance.exposed ?? instance.proxy) as IForm['component'];
		}

		const handler = (e: Event): void => {
			e.preventDefault();
			void form.handle();
		};
		el.addEventListener('submit', handler, { capture: true });
		el.__vformSubmitHandler = handler;
	},
	beforeUnmount (el) {
		if (el.__vformSubmitHandler) {
			el.removeEventListener('submit', el.__vformSubmitHandler, { capture: true });
			el.__vformSubmitHandler = undefined;
		}
	},
};
