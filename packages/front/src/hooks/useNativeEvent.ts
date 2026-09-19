import { isRef, type Ref, watch } from 'vue';
import { onMounted, onUnmounted, unref } from 'vue';

export function useNativeEvent(el: EventTarget|Ref<EventTarget|null|undefined>|null|undefined, eventName: string, callback: (...args: any) => any, once: boolean = false, options?: AddEventListenerOptions | boolean): void {
	let old: Nullable<EventTarget>= null;
	const handle = (...args: any) => {
		callback(...args);
		if (once) {
			remove();
		}
	};
	const add = (target: EventTarget|null|undefined) => {
		if (target) {
			old = target;
			target.addEventListener(eventName, handle, options as any);
		}
	}
	const remove = () => {
		if (old) {
			old.removeEventListener(eventName, handle, options as any);
			old = null;
		}
	}

	if (isRef(el)) {
		watch(el, (value) => {
			remove();
			if (value) add(value);
		})
	}
	onMounted(() => add(unref(el)));
	onUnmounted(() => remove());
}
