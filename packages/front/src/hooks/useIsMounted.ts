import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useUserStore } from '@/stores/user';

export function useIsMounted() {
	const isMounted = ref(false);
	const isUnmounted = ref(false);
	const mountedCallbacks = ref<(() => any)[]>([]);
	const loggedCallbacks = ref<(() => any)[]>([]);

	const userStore = useUserStore();

	const onMountedInner = (callback: () => any) => {
		mountedCallbacks.value.push(callback);
	};

	const onLogged = (callback: () => any) => {
		loggedCallbacks.value.push(callback);
	};

	onMounted(async () => {
		try {
			isMounted.value = false;
			await Promise.all(
				mountedCallbacks.value.map(mounted => mounted()),
			);
			isMounted.value = true;
		} catch (e) {
			console.error(e);
		}
	});

	onUnmounted(() => {
		isMounted.value = false;
		isUnmounted.value = true;
	});

	const checkConnected = async () => {
		if (userStore.connected) {
			await Promise.all(
				loggedCallbacks.value.map(mounted => mounted()),
			);
		}
	}
	onMountedInner(checkConnected);
	watch(() => userStore.connected, checkConnected);

	return { isMounted, isUnmounted, onMounted: onMountedInner, onLogged };
}
