import { AbortCallerException } from '@/libs/caller';
import { translate } from '@/plugins/i18n';
import { type NotifyType, useNotifierStore } from '@/stores/notifier';

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
	) => {
		return async (...args: Args): Promise<R | undefined> => {
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
				onComplete?.(...args);
			}
		};
	};

	return {
		notify,
		tryCallback,
	};
}
