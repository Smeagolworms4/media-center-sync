import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';

/**
 * Mount state, plus a hook that fires once a session exists.
 *
 * Most screens need their data as soon as they appear, but a screen mounted
 * during the boot restore has no bearer yet. `onLogged` runs when the session is
 * there — immediately when it already was, later when it arrives.
 */
export function useIsMounted () {
	const isMounted = ref(false);
	const isUnmounted = ref(false);
	const mountedCallbacks: (() => unknown)[] = [];
	const loggedCallbacks: (() => unknown)[] = [];

	const authStore = useAuthStore();

	const onMountedInner = (callback: () => unknown) => {
		mountedCallbacks.push(callback);
	};

	const onLogged = (callback: () => unknown) => {
		loggedCallbacks.push(callback);
	};

	onMounted(async () => {
		try {
			isMounted.value = false;
			await Promise.all(mountedCallbacks.map(callback => callback()));
			isMounted.value = true;
		} catch (error) {
			console.error(error);
		}
	});

	onUnmounted(() => {
		isMounted.value = false;
		isUnmounted.value = true;
	});

	const checkConnected = async () => {
		if (authStore.authenticated) {
			await Promise.all(loggedCallbacks.map(callback => callback()));
		}
	};
	onMountedInner(checkConnected);
	watch(() => authStore.authenticated, checkConnected);

	return { isMounted, isUnmounted, onMounted: onMountedInner, onLogged };
}
