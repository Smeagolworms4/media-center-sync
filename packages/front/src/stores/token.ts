import type { TokenPair } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { cachePromise } from '@/hooks/cachePromise';
import { useCaller } from '@/hooks/useCaller';
import { queryTypes, storageRef } from '@/libs/vue3-query-ref';

const SESSION_STORAGE_KEY = 'mcs.session';
const LOGOUT_CHANNEL_NAME = 'mcs.logout';

/**
 * How early an access token is considered stale.
 *
 * Refreshing exactly at expiry loses the race against the network: the request
 * leaves valid and arrives expired. A few seconds of margin costs one extra
 * refresh a day and removes a class of spurious 401s.
 */
const EXPIRY_SKEW_MS = 15_000;

/**
 * What is persisted between reloads.
 *
 * `TokenPair` carries a *relative* lifetime, which is useless once the tab is
 * closed — so the absolute deadline is computed on receipt and stored alongside.
 */
export interface StoredSession extends TokenPair {
	/** Epoch milliseconds at which `accessToken` stops being accepted. */
	expiresAt: number;
}

/**
 * The raw credentials of the session.
 *
 * Deliberately below `stores/auth`: the caller has to be able to attach a bearer
 * and to refresh it without pulling in the whole session façade, and the session
 * façade has to be able to reason about the user without knowing how a token is
 * stored.
 */
export const useTokenStore = defineStore('token', () => {
	const { caller } = useCaller();

	const session = storageRef<StoredSession | null>(
		SESSION_STORAGE_KEY,
		queryTypes.json<StoredSession | null>(),
	);

	const accessToken = computed(() => session.value?.accessToken ?? null);
	const refreshToken = computed(() => session.value?.refreshToken ?? null);
	const authenticated = computed(() => session.value !== null);
	const isValid = computed(
		() => !!session.value && session.value.expiresAt - EXPIRY_SKEW_MS > Date.now(),
	);

	/**
	 * Signing out in one tab has to sign out every other one, otherwise a second
	 * tab keeps a token the server has already revoked and every call it makes
	 * fails in a way nobody can explain.
	 */
	const logoutChannel = typeof BroadcastChannel === 'undefined'
		? null
		: new BroadcastChannel(LOGOUT_CHANNEL_NAME);

	function store(pair: TokenPair): StoredSession {
		const stored: StoredSession = { ...pair, expiresAt: Date.now() + pair.expiresIn * 1000 };
		session.value = stored;
		return stored;
	}

	function clear(): void {
		session.value = null;
	}

	if (logoutChannel) {
		logoutChannel.onmessage = () => clear();
	}

	/**
	 * Single-flighted: a page that fires five calls at once on a stale token must
	 * produce one refresh, not five — and four of those five would be racing
	 * against a refresh token the first one already rotated away.
	 */
	const refreshOnce = cachePromise(async (): Promise<StoredSession | null> => {
		const token = session.value?.refreshToken;
		if (!token) {
			clear();
			return null;
		}
		try {
			const pair = await caller('api').post<TokenPair>(
				'/auth/refresh',
				{ refreshToken: token },
				{ useAuth: false, silentError: true },
			);
			return store(pair);
		} catch (error) {
			clear();
			throw error;
		}
	}, true);

	function refresh(): Promise<StoredSession | null> {
		return refreshOnce('token|refresh');
	}

	/** The bearer to attach, refreshed first when it is about to expire. */
	async function getAccessToken(): Promise<string | null> {
		if (!session.value) {
			return null;
		}
		if (!isValid.value) {
			try {
				await refresh();
			} catch {
				return null;
			}
		}
		return session.value?.accessToken ?? null;
	}

	/**
	 * Revokes the session server-side before forgetting it.
	 *
	 * The access token is backed by a database row, so telling the API first is
	 * what actually ends the session; dropping the local copy only hides it.
	 */
	async function revoke(): Promise<void> {
		const hadSession = session.value !== null;
		try {
			if (hadSession) {
				await caller('api').post('/auth/logout', {}, { silentError: true });
			}
		} catch {
			// A gateway that is down must not trap somebody in a signed-in shell.
		} finally {
			clear();
			logoutChannel?.postMessage('logout');
		}
	}

	return {
		session,
		accessToken,
		refreshToken,
		authenticated,
		isValid,
		store,
		clear,
		refresh,
		getAccessToken,
		revoke,
	};
});
