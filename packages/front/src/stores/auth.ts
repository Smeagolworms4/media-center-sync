import type { AuthProvider, LoginRequest, Right, SessionUser, TokenPair } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useTokenStore } from '@/stores/token';

/**
 * The session, as the rest of the interface sees it.
 *
 * `stores/token` owns the credentials; this store owns who is signed in and what
 * they may do. Components and guards ask this one, never the other, so that the
 * day tokens are exchanged differently nothing above has to change.
 */
export const useAuthStore = defineStore('auth', () => {
	const { caller } = useCaller();
	const tokenStore = useTokenStore();

	const providers = ref<AuthProvider[]>([]);
	const providersLoaded = ref(false);

	/**
	 * Whether the boot-time restore has finished.
	 *
	 * The route guard cannot decide anything before it has: redirecting on a
	 * session that is merely not read yet sends a signed-in viewer to the sign-in
	 * page on every refresh.
	 */
	const ready = ref(false);
	let restoring: Promise<void> | null = null;

	const user = computed<SessionUser | null>(() => {
		const session = tokenStore.session;
		return session ? { ...session.user, rights: session.rights } : null;
	});
	const rights = computed<Right[]>(() => tokenStore.session?.rights ?? []);
	const authenticated = computed(() => user.value !== null);

	function hasRight(right: Right | Right[]): boolean {
		if (!authenticated.value) {
			return false;
		}
		const needed = Array.isArray(right) ? right : [right];
		return needed.every(one => rights.value.includes(one));
	}

	/** The ways in offered by this gateway. Public: the sign-in page needs it. */
	async function loadProviders(): Promise<AuthProvider[]> {
		providers.value = await caller('api').get<AuthProvider[]>('/auth/providers', {
			useAuth: false,
			keepLastKey: 'auth|providers',
		});
		providersLoaded.value = true;
		return providers.value;
	}

	async function login(request: LoginRequest): Promise<SessionUser> {
		const pair = await caller('api').post<TokenPair>('/auth/login', request, { useAuth: false });
		tokenStore.store(pair);
		ready.value = true;
		return { ...pair.user, rights: pair.rights };
	}

	async function logout(): Promise<void> {
		await tokenStore.revoke();
	}

	/**
	 * Reads whatever the browser kept and proves it is still good.
	 *
	 * A stored session says nothing about the server: the gateway may have been
	 * restarted with a new signing key, or the session revoked from another
	 * device. One refresh settles it, and a failure simply means "not signed in".
	 */
	function restore(): Promise<void> {
		restoring ??= (async () => {
			try {
				if (tokenStore.session && !tokenStore.isValid) {
					await tokenStore.refresh();
				}
			} catch {
				tokenStore.clear();
			} finally {
				ready.value = true;
			}
		})();
		return restoring;
	}

	/** Resolves once the boot-time restore is done, running it if nobody has. */
	function whenReady(): Promise<void> {
		return ready.value ? Promise.resolve() : restore();
	}

	return {
		providers,
		providersLoaded,
		ready,
		user,
		rights,
		authenticated,
		hasRight,
		loadProviders,
		login,
		logout,
		restore,
		whenReady,
	};
});
