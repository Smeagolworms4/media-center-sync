import { computed, type ComputedRef } from 'vue';
import { type StoredSession, useTokenStore } from '@/stores/token';

/** Read-only view of the stored session, for anything that only needs to look. */
export function useToken (): ComputedRef<StoredSession | null> {
	const tokenStore = useTokenStore();
	return computed(() => tokenStore.session);
}

/** True while the access token in hand is still worth sending. */
export function useTokenIsValid (): ComputedRef<boolean> {
	const tokenStore = useTokenStore();
	return computed(() => tokenStore.isValid);
}
