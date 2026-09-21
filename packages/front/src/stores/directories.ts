import type {
	DirectorySignIn,
	DiscoveredServer,
	MediaServiceType,
	RegisterDiscoveredResult,
} from '@mcs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useServicesStore } from '@/stores/services';

/**
 * Finding media servers through the account service that knows them — plex.tv.
 *
 * Every call here is `silentError`, and that is deliberate rather than a way of hiding
 * anything: the add dialog shows each failure in place, naming what went wrong, next to
 * the step it happened in. A toast over the whole application as well would say the
 * same thing twice, once where nobody is looking.
 */
export const useDirectoriesStore = defineStore('directories', () => {
	const { caller } = useCaller();
	const servicesStore = useServicesStore();

	/** The types a sign-in is offered for. Null until asked. */
	const types = ref<MediaServiceType[] | null>(null);

	async function loadTypes (): Promise<MediaServiceType[]> {
		const loaded = await caller('api').get<MediaServiceType[]>('/directories', { silentError: true });
		types.value = Array.isArray(loaded) ? loaded : [];
		return types.value;
	}

	function startSignIn (type: MediaServiceType): Promise<DirectorySignIn> {
		return caller('api').post<DirectorySignIn>(`/directories/${type}/sign-ins`, undefined, { silentError: true });
	}

	/** Polled: only the latest answer matters, so an older one still in flight is dropped. */
	function readSignIn (id: string): Promise<DirectorySignIn> {
		return caller('api').get<DirectorySignIn>(`/directories/sign-ins/${id}`, {
			silentError: true,
			keepLastKey: `directories|sign-in|${id}`,
		});
	}

	function cancelSignIn (id: string): Promise<void> {
		return caller('api').delete<void>(`/directories/sign-ins/${id}`, { silentError: true });
	}

	function servers (id: string): Promise<DiscoveredServer[]> {
		return caller('api').get<DiscoveredServer[]>(`/directories/sign-ins/${id}/servers`, { silentError: true });
	}

	/** Registers them, and puts what came in straight into the services list. */
	async function register (id: string, identifiers: string[]): Promise<RegisterDiscoveredResult> {
		const result = await caller('api').post<RegisterDiscoveredResult>(
			`/directories/sign-ins/${id}/servers`,
			{ identifiers },
			{ silentError: true },
		);

		for (const service of result.created) {
			servicesStore.replace(service);
		}

		return result;
	}

	return { types, loadTypes, startSignIn, readSignIn, cancelSignIn, servers, register };
});
