import type { DirectorySignIn, DiscoveredServer, MediaServiceType } from '@mcs/shared';
import { DirectorySignInState } from '@mcs/shared';
import { onBeforeUnmount, ref } from 'vue';
import { useApiError } from '@/hooks/useApiError';
import { useDirectoriesStore } from '@/stores/directories';

/**
 * Where the add dialog stands in signing in to plex.tv.
 *
 * One value rather than four booleans, because the screen shows exactly one of these
 * at a time and every pair of booleans that could both be true is a screen showing a
 * spinner and an error at once.
 */
export type DirectorySignInPhase = 'idle' | 'starting' | 'waiting' | 'expired' | 'listing' | 'ready' | 'failed';

/**
 * How often the gateway is asked whether the person approved.
 *
 * Every two seconds is what Plex's own clients do, and what makes the dialog move on
 * the moment somebody comes back from the plex.tv tab. Each poll costs one request to
 * the gateway and one from it to plex.tv, for a few minutes at most.
 */
export const SIGN_IN_POLL_MS = 2000;

/**
 * Signing in to a directory, waiting for the approval, and fetching the servers.
 *
 * The one piece of behaviour here that is not bookkeeping is the tab. It is opened
 * **before** the gateway is asked for a PIN, blank, inside the click that asked for it,
 * and pointed at plex.tv once the PIN exists. Opening it after the answer — the obvious
 * order — is opening a window outside a user gesture, which every browser's popup
 * blocker refuses in silence: the dialog would wait for an approval on a page that
 * never appeared. When the browser refuses anyway, the dialog says so and offers the
 * link, which the person's own click opens.
 */
export function useDirectorySignIn (options: { pollMs?: number } = {}) {
	const directoriesStore = useDirectoriesStore();
	const { parseApiError } = useApiError();

	const phase = ref<DirectorySignInPhase>('idle');
	const signIn = ref<DirectorySignIn | null>(null);
	const servers = ref<DiscoveredServer[]>([]);
	const error = ref<string | null>(null);
	const popupBlocked = ref(false);

	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	function stopPolling (): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	async function fail (cause: unknown, fallback = 'error.directory.unreachable'): Promise<void> {
		stopPolling();
		error.value = (await parseApiError(cause, { fallback, mappedFields: new Set() })).mainError;
		phase.value = 'failed';
	}

	async function loadServers (): Promise<void> {
		if (!signIn.value) {
			return;
		}
		phase.value = 'listing';
		error.value = null;
		try {
			servers.value = await directoriesStore.servers(signIn.value.id);
			phase.value = 'ready';
		} catch (error_) {
			await fail(error_);
		}
	}

	async function poll (): Promise<void> {
		timer = null;
		if (!signIn.value || disposed) {
			return;
		}
		try {
			const read = await directoriesStore.readSignIn(signIn.value.id);
			if (disposed || phase.value !== 'waiting') {
				return;
			}
			signIn.value = read;
			if (read.state === DirectorySignInState.APPROVED) {
				await loadServers();
				return;
			}
			if (read.state === DirectorySignInState.EXPIRED) {
				phase.value = 'expired';
				return;
			}
			schedule();
		} catch (error_) {
			if (!disposed) {
				await fail(error_);
			}
		}
	}

	function schedule (): void {
		stopPolling();
		timer = setTimeout(() => {
			void poll();
		}, options.pollMs ?? SIGN_IN_POLL_MS);
	}

	/** Must be called from the click itself: see the note above about the tab. */
	async function start (type: MediaServiceType): Promise<void> {
		stopPolling();
		error.value = null;
		servers.value = [];
		popupBlocked.value = false;
		phase.value = 'starting';

		const tab = window.open('', '_blank');

		try {
			signIn.value = await directoriesStore.startSignIn(type);
		} catch (error_) {
			tab?.close();
			await fail(error_);
			return;
		}

		if (tab) {
			// plex.tv has no business holding a handle on this page.
			tab.opener = null;
			tab.location.href = signIn.value.authUrl;
		} else {
			popupBlocked.value = true;
		}

		phase.value = 'waiting';
		schedule();
	}

	/**
	 * Stop waiting, and have the gateway forget the sign-in and any token with it.
	 *
	 * The forgetting is best effort: a gateway that cannot be reached to be told has
	 * lost the sign-in already, and the cancel has to work from the person's point of
	 * view either way.
	 */
	async function cancel (): Promise<void> {
		stopPolling();
		const current = signIn.value;
		signIn.value = null;
		servers.value = [];
		error.value = null;
		phase.value = 'idle';
		if (current) {
			await directoriesStore.cancelSignIn(current.id).catch(() => undefined);
		}
	}

	onBeforeUnmount(() => {
		disposed = true;
		stopPolling();
		// Closing the dialog is a cancel, whatever it was showing: while waiting, the
		// approval would otherwise hand the gateway an account token for a dialog nobody
		// is looking at, and once the servers are registered each of them already keeps
		// the token it needs.
		if (signIn.value) {
			void directoriesStore.cancelSignIn(signIn.value.id).catch(() => undefined);
		}
	});

	return { phase, signIn, servers, error, popupBlocked, start, cancel, loadServers };
}
