import type { ComponentInternalInstance, Directive, DirectiveBinding, VNode } from 'vue';
import type { IForm } from './useForm';

interface FormEl extends HTMLElement {
	__vformSubmitHandler?: (e: Event) => void;
}

/**
 * Branche un `IForm` (cf. `useForm`) sur un `<v-form>` :
 *  - assigne `form.component` à l'instance VForm exposée par le vnode (pour validate/reset)
 *  - intercepte le `submit` natif et appelle `form.handle()` → plus besoin de
 *    `@submit.prevent="form.handle"` sur chaque consommateur.
 */
export const vForm: Directive<FormEl, IForm> = {
	mounted(el, binding: DirectiveBinding<IForm>, vnode: VNode) {
		const form = binding.value;
		if (!form) return;

		const instance = (vnode.component
			?? (vnode as VNode & { ctx?: ComponentInternalInstance | null }).ctx) as ComponentInternalInstance | null;

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
	beforeUnmount(el) {
		if (el.__vformSubmitHandler) {
			el.removeEventListener('submit', el.__vformSubmitHandler, { capture: true });
			el.__vformSubmitHandler = undefined;
		}
	},
};
