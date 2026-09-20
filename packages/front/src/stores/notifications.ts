import type {
	CreateNotificationChannelRequest,
	NotificationChannel,
	NotificationTestResult,
	UpdateNotificationChannelRequest,
} from '@mcs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * The ways this gateway can reach somebody.
 *
 * Named `notificationChannels` rather than `notifications` because the interface
 * already has a `notifier`, which is the toast in the corner of the screen. Two
 * things called a notification, one of which disappears in four seconds and one of
 * which reaches a phone at four in the morning, is a confusion worth one longer name.
 *
 * Nothing here ever holds a credential: the API strips them before answering, so what
 * a form prefills is the address and the topic and never the token. Leaving a secret
 * box empty is what keeps the stored one — the API treats an absent key as unchanged.
 */
export const useNotificationChannelsStore = defineStore('notificationChannels', () => {
	const { caller } = useCaller();

	const channels = ref<NotificationChannel[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	function replace (channel: NotificationChannel): void {
		const index = channels.value.findIndex(one => one.id === channel.id);
		if (index === -1) {
			channels.value = [...channels.value, channel];
		} else {
			channels.value[index] = channel;
		}
	}

	async function load (): Promise<NotificationChannel[]> {
		loading.value = true;
		error.value = null;
		try {
			const list = await caller('api').get<NotificationChannel[]>('/notifications/channels', {
				keepLastKey: 'notifications|channels',
			});
			// An empty body parses to `null`, and a gateway that answers nothing must not
			// leave the screen rendering a list that is not one.
			channels.value = Array.isArray(list) ? list : [];
			loaded.value = true;
			return channels.value;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	async function create (request: CreateNotificationChannelRequest): Promise<NotificationChannel> {
		const channel = await caller('api').post<NotificationChannel>('/notifications/channels', request);
		replace(channel);
		return channel;
	}

	async function update (
		id: string,
		request: UpdateNotificationChannelRequest,
	): Promise<NotificationChannel> {
		const channel = await caller('api').patch<NotificationChannel>(
			`/notifications/channels/${id}`,
			request,
		);
		replace(channel);
		return channel;
	}

	async function remove (id: string): Promise<void> {
		await caller('api').delete(`/notifications/channels/${id}`);
		channels.value = channels.value.filter(one => one.id !== id);
	}

	/**
	 * Send one message now and keep what the gateway said about it.
	 *
	 * The row is reloaded afterwards because the attempt writes `lastError` and
	 * `lastSentAt`, and those are the whole point: a channel that has delivered
	 * nothing since March has to be visible as such on this screen, not only in the
	 * toast that appeared for four seconds while somebody was pressing the button.
	 */
	async function test (id: string): Promise<NotificationTestResult> {
		const result = await caller('api').post<NotificationTestResult>(
			`/notifications/channels/${id}/test`,
			{},
		);
		await load().catch(() => undefined);
		return result;
	}

	return { channels, loading, loaded, error, load, create, update, remove, test };
});
