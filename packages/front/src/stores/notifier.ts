import { defineStore } from 'pinia';

export type NotifyType = 'error'|'warning'|'success';

export interface NotifyInterface {
	type?: NotifyType;
	message?: string;
	timeout?: number;
}

export interface CommonNotifierState {
	notifies: NotifyInterface[];
}

export const useNotifierStore = defineStore('notifier', {
	state: () => ({
		notifies: [],
	} as CommonNotifierState),

	actions: {
		addNotify(notify: NotifyInterface) {
			this.notifies.push(notify);
		},

		removeNotify(notify: NotifyInterface) {
			const index = this.notifies.indexOf(notify);
			this.notifies.splice(index, 1);
		},


		async notify(notify: NotifyInterface): Promise<NotifyInterface> {
			notify = {
				...{
					type:  'success',
					message: '',
					timeout: 5000
				} as NotifyInterface,
				...notify,
			};
			this.addNotify(notify);
			await new Promise(r => setTimeout(r, notify.timeout!));
			this.removeNotify(notify);
			return notify;
		},
	}
});
