import { computed, type ComputedRef, type Ref } from 'vue';
import type { HToken, Token } from '@/models';
import { hToken } from '@/models';
import { useTokenStore } from '@/stores/token';

export function useToken(): Ref<Nullable<Token>> {
	const tokenStore = useTokenStore();
	return computed(() => tokenStore.token);
}
export function useHToken(): ComputedRef<Nullable<HToken>> {
	const token = useToken();
	return computed(() => hToken(token.value));
}
