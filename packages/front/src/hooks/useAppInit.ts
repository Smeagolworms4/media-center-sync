import { ref, watch } from 'vue';
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
			}
		} catch (initError) {
			error.value = initError;
		} finally {
			ready.value = true;
		}
	}

	/*
	 * The stream follows the session, rather than the boot.
	 *
	 * Connecting inside `init` covered only the case of arriving with a session
	 * already restored. The ordinary path — land on the sign-in page, sign in — left
	 * the stream closed for the rest of the visit: every screen worked, every list
	 * filled, and no progress bar ever moved until somebody reloaded the page. Nothing
	 * reported an error, because nothing had failed.
	 */
	watch(
		() => authStore.authenticated,
		authenticated => {
			if (authenticated) {
				eventsStore.connect();
			} else {
				eventsStore.disconnect();
			}
		},
		{ immediate: true },
	);

	return { ready, error, init };
}
