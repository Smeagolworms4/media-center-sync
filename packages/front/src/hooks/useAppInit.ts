import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useEventsStore } from '@/stores/events';
import { useSettingsStore } from '@/stores/settings';

/**
 * Everything that has to be true before the shell is worth showing.
 *
 * It resolves in both outcomes — session restored, or no session at all — because
 * the sign-in page is part of the application and must not wait behind a spinner
 * for a restore that was always going to fail. Only the session is awaited; the
 * settings and the event stream are conveniences, and a gateway that cannot serve
 * them still has to let somebody in to fix it.
 */
export function useAppInit () {
	const authStore = useAuthStore();
	const settingsStore = useSettingsStore();
	const eventsStore = useEventsStore();

	const ready = ref(false);
	const error = ref<unknown>(null);

	async function init (): Promise<void> {
		try {
			await authStore.restore();
			if (authStore.authenticated) {
				// Failing to read the settings is not a reason to refuse the session.
				await settingsStore.load().catch(loadError => {
					error.value = loadError;
				});
				eventsStore.connect();
			}
		} catch (initError) {
			error.value = initError;
		} finally {
			ready.value = true;
		}
	}

	return { ready, error, init };
}
