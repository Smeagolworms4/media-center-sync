import { ref } from 'vue';
import { AbortCallerException } from '@/libs/caller';
import { translate } from '@/plugins/i18n';
import { type NotifyType, useNotifierStore } from '@/stores/notifier';

/**
 * An action wrapped by `tryCallback`, carrying the state of its own calls.
 *
 * The flag rides on the function rather than being returned beside it so that every
 * existing call site keeps working unchanged: `const act = tryCallback(…)` still gives
 * something callable, and `act.loading` is there for the button that wants it.
 */
export interface NotifiedAction<Args extends unknown[], R> {
	(...args: Args): Promise<R | undefined>;

	/**
	 * True while a call is in flight.
	 *
	 * A plain boolean and not a `Ref`, deliberately: a template unwraps a top-level ref
	 * but not one reached through a function object, so `action.loading` would have
	 * rendered the ref itself and every call site would have needed an alias beside it.
	 * It is a getter over a ref, so reading it in a template is still tracked.
	 *
	 * It counts rather than toggles, for the reason `stores/loader` counts: one action
	 * is commonly bound to a list of rows, and a boolean would be switched off by the
	 * first row to answer while the others are still running.
	 *
	 * `useLoaderStore` is the wrong tool here even though it counts the same way: it is
	 * the application-wide flag, and one row of one list starting a fetch has no business
	 * greying out the whole interface.
	 */
	readonly loading: boolean;
}

export function useNotifier () {
	const notifierStore = useNotifierStore();

	/** `message` is an i18n key; an unknown one falls back to itself, unchanged. */
	const notify = async (message: string, type: NotifyType = 'success', timeout = 5000) => {
		await notifierStore.notify({ type, message: translate(message), timeout });
	};

	/**
	 * Wraps an action so a failure becomes a toast instead of an unhandled
	 * rejection. Aborted calls are swallowed on purpose: the interface cancelled
	 * them itself — a newer search, a page left — and telling the viewer about it
	 * would report our own behaviour as an error.
	 */
	const tryCallback = <Args extends unknown[], R>(
		callback: (...args: Args) => R | Promise<R>,
		{
			onError = null,
			onComplete = null,
			message = 'error.general',
		}: {
			onError?: Nullable<(error: unknown, ...args: Args) => unknown>;
			onComplete?: Nullable<(...args: Args) => unknown>;
			message?: string;
		} = {},
	): NotifiedAction<Args, R> => {
		const pending = ref(0);

		const run = (async (...args: Args): Promise<R | undefined> => {
			pending.value += 1;

			try {
				return await callback(...args);
			} catch (error) {
				if (error instanceof AbortCallerException) {
					return undefined;
				}
				console.error(error);
				void notify(message, 'error');
				onError?.(error, ...args);
				return undefined;
			} finally {
				// Decremented before `onComplete`, which is free to start another call: the
				// counter has to already reflect this one having ended.
				pending.value -= 1;
				onComplete?.(...args);
			}
		}) as NotifiedAction<Args, R>;

		Object.defineProperty(run, 'loading', {
			get: () => pending.value > 0,
			enumerable: true,
			configurable: false,
		});

		return run;
	};

	return {
		notify,
		tryCallback,
	};
}
