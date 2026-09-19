import { defineStore } from 'pinia'
import { queryTypes, storageRef } from '@/libs/vue3-query-ref';
import { hToken, type Token } from '@/models';
import { useUserStore } from '@/stores/user';
import { useCaller, cachePromise } from '@/hooks';

const LOGOUT_CHANNEL_NAME = 'logout'

let logoutRunning = false

/**
 * Store de gestion des tokens d'authentification.
 * Stocke le token et le refresh token dans le localStorage.
 * Gère la déconnexion cross-onglet via BroadcastChannel.
 */
export const useTokenStore = defineStore('token', () => {
	const { caller } = useCaller()

	const token = storageRef<Nullable<Token>>('token', queryTypes.json<Nullable<Token>>());

	// Écoute le logout depuis un autre onglet
	const logoutChannel = new BroadcastChannel(LOGOUT_CHANNEL_NAME);
	logoutChannel.onmessage = () => {
		logout();
	};

	const login = async (email: string, password: string): Promise<Token> => {
		const userStore = useUserStore();
		logoutRunning = false;
		token.value = await caller('api').post<Token>('/dev/tokens/login', { email, password }, { useAuth: false })
		userStore.me = token.value.user;
		return token.value;
	}

	const casLogin = async (ticket: string, service: string): Promise<Token> => {
		const userStore = useUserStore();
		logoutRunning = false;
		token.value = await caller('api').post<Token>('/tokens/cas-login', { ticket, service }, { useAuth: false })
		userStore.me = token.value.user;
		return token.value;
	}

	const logout = () => {
		if (logoutRunning) {
			return
		}
		const userStore = useUserStore();
		logoutRunning = true;
		token.value = null;
		userStore.me = null;

		const channel = new BroadcastChannel(LOGOUT_CHANNEL_NAME)
		channel.postMessage('logout')
		setTimeout(() => {
			window.location.reload();
		}, 300);
	};

	const checkAndRefresh = async (): Promise<boolean> => {
		if (token.value && !hToken(token.value)!.isValid) {
			await refresh();
			return true;
		}
		return false;
	};

	const refresh = (refreshToken: Nullable<string> = null): Promise<Nullable<Token>> => {
		return cachePromise(async () => {
			const userStore = useUserStore();
			token.value = await caller('api').post<Token>('/tokens/refresh', refreshToken ? { id: refreshToken } : token.value?.refreshToken, { useAuth: false });
			userStore.me = token.value.user;
			return token.value;
		}, true)('token|refresh');
	};

	return {
		token,
		login,
		casLogin,
		logout,
		checkAndRefresh,
		refresh,
	};
});
