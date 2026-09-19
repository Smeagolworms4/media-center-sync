import { useI18n } from 'vue-i18n';
import { type NotifyType, useNotifierStore } from '@/stores/notifier';
import { AbortCallerException } from '@/libs/caller';

export function useNotifier() {

	const storeCommonNotifier = useNotifierStore();
	const { t } = useI18n();
	const notify = async (message: string, type: NotifyType = 'success', timeout: number = 5000) => {
		await storeCommonNotifier.notify({
			type: type,
			message: t(message),
			timeout: timeout
		});
	};

	const tryCallback = (
		callback: (...args: any[]) => any|Promise<any>,
		{
			onError = null,
			onComplete = null,
			message = 'front.error.general'
		}: {
			onError?: Nullable<(...args: any[]) => any>,
			onComplete?: Nullable<(...args: any[]) => any>,
			message?: string
		} = {}
	) => {
		return async (...args: any[]) => {
			try {
				return await callback(...args);
			} catch (e) {
				if (e instanceof AbortCallerException) {
					console.log('Abort fetch call');
					return;
				}
				console.error(e);
				if (typeof window !== 'undefined') {
					notify(message!, 'error');
				}
				if (onError) {
					onError(e, ...args);
				}
			} finally {
				if (onComplete) {
					onComplete(...args);
				}
			}
		};
	};

	return {
		notify,
		tryCallback,
	};
}
