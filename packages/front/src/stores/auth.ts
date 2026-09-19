import type {
	AuthProvider,
	LoginRequest,
	Right,
	SessionUser,
	SetupRequest,
	SetupState,
	TokenPair,
} from '@mcs/shared';
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
	 * Whether this gateway has never been claimed.
	 *
	 * It is part of the session state rather than of the setup page's own data
	 * because the route guard decides on it: a gateway with no account at all has
	 * exactly one thing to offer, and every address has to lead there.
	 */
	const setupRequired = ref(false);
	const setupVersion = ref<string | null>(null);

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

	function hasRight (right: Right | Right[]): boolean {
		if (!authenticated.value) {
			return false;
		}
		const needed = Array.isArray(right) ? right : [right];
		return needed.every(one => rights.value.includes(one));
	}

	/** The ways in offered by this gateway. Public: the sign-in page needs it. */
	async function loadProviders (): Promise<AuthProvider[]> {
		providers.value = await caller('api').get<AuthProvider[]>('/auth/providers', {
			useAuth: false,
			keepLastKey: 'auth|providers',
		});
		providersLoaded.value = true;
		return providers.value;
	}

	/**
	 * Whether the gateway still needs its first administrator.
	 *
	 * A failure answers "no". The question is asked before anything is signed in,
	 * on a route an older gateway does not even serve, and the cost of the two
	 * mistakes is not the same: reading an unreachable gateway as "set up" shows
	 * the sign-in page, which says so itself, while reading it as "fresh" would
	 * offer to create an administrator on a gateway that already has one and then
	 * fail on submit for reasons nobody can see.
	 */
	async function loadSetupState (): Promise<SetupState | null> {
		try {
			const state = await caller('api').get<SetupState>('/auth/setup', {
				useAuth: false,
				keepLastKey: 'auth|setup',
			});
			setupRequired.value = state?.required === true;
			setupVersion.value = state?.version ?? null;
			return state;
		} catch {
			setupRequired.value = false;
			return null;
		}
	}

	/**
	 * Creates the first administrator, and signs them in with it.
	 *
	 * The route answers a session on purpose, and this stores it: sending somebody
	 * to the sign-in screen to retype the credentials they chose ten seconds ago is
	 * a step for nobody. It is also the moment the open route closes — the gateway
	 * refuses a second call — so the flag is cleared here rather than re-read.
	 */
	async function setup (request: SetupRequest): Promise<SessionUser> {
		const pair = await caller('api').post<TokenPair>('/auth/setup', request, { useAuth: false });
		tokenStore.store(pair);
		setupRequired.value = false;
		ready.value = true;
		return { ...pair.user, rights: pair.rights };
	}

	async function login (request: LoginRequest): Promise<SessionUser> {
		const pair = await caller('api').post<TokenPair>('/auth/login', request, { useAuth: false });
		tokenStore.store(pair);
		ready.value = true;
		return { ...pair.user, rights: pair.rights };
	}

	async function logout (): Promise<void> {
		await tokenStore.revoke();
	}

	/**
	 * Reads whatever the browser kept and proves it is still good.
	 *
	 * A stored session says nothing about the server: the gateway may have been
	 * restarted with a new signing key, or the session revoked from another
	 * device. One refresh settles it, and a failure simply means "not signed in".
	 */
	function restore (): Promise<void> {
		restoring ??= (async () => {
			try {
				if (tokenStore.session && !tokenStore.isValid) {
					await tokenStore.refresh();
				}
			} catch {
				tokenStore.clear();
			}
			// Asked here, before the first navigation is decided, because the guard
			// needs the answer: a gateway that has never been claimed must lead to its
			// setup screen from whatever address somebody typed. A visitor who already
			// holds a session is not asking that question, and is not made to wait for
			// a call that would answer "no".
			if (!tokenStore.session) {
				await loadSetupState();
			}
			ready.value = true;
		})();
		return restoring;
	}

	/** Resolves once the boot-time restore is done, running it if nobody has. */
	function whenReady (): Promise<void> {
		return ready.value ? Promise.resolve() : restore();
	}

	return {
		providers,
		providersLoaded,
		setupRequired,
		setupVersion,
		ready,
		user,
		rights,
		authenticated,
		hasRight,
		loadProviders,
		loadSetupState,
		setup,
		login,
		logout,
		restore,
		whenReady,
	};
});
