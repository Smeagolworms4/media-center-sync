import type { ShareAudit, SharePolicy, UpdateSharePolicyRequest } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * What each library exposes, and to whom.
 *
 * The list holds one row per library, including the ones nobody has configured:
 * those carry `overridden: false` and the gateway's default resolved for them.
 * The distinction matters on screen — a library reading "nobody" because
 * somebody made it private is a decision, one reading "nobody" because it is not
 * ours is a rule — so it is never flattened away here.
 */
export const useSharesStore = defineStore('shares', () => {
	const { caller } = useCaller();

	const policies = ref<SharePolicy[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	const byLibraryId = computed(() => {
		const map: Record<string, SharePolicy> = {};
		for (const policy of policies.value) {
			map[policy.libraryId] = policy;
		}
		return map;
	});

	function replace (policy: SharePolicy): void {
		const index = policies.value.findIndex(one => one.libraryId === policy.libraryId);
		if (index === -1) {
			policies.value = [...policies.value, policy];
		} else {
			policies.value[index] = policy;
		}
	}

	async function load (): Promise<SharePolicy[]> {
		loading.value = true;
		error.value = null;
		try {
			const loadedList = await caller('api').get<SharePolicy[]>('/shares', {
				keepLastKey: 'shares|list',
			});
			// An empty body parses to `null`, and a gateway that answers nothing must
			// not leave a page rendering a list that is not one.
			policies.value = Array.isArray(loadedList) ? loadedList : [];
			loaded.value = true;
			return policies.value;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	/** `PUT`, because a library has at most one policy and this replaces it. */
	async function save (
		libraryId: string,
		request: UpdateSharePolicyRequest,
	): Promise<SharePolicy> {
		const policy = await caller('api').put<SharePolicy>(`/shares/${libraryId}`, request);
		replace(policy);
		return policy;
	}

	/**
	 * Drop the override, and read back what the library falls to.
	 *
	 * Reloaded rather than removed from the list: deleting the row does not make the
	 * library private, it hands it back to the gateway default — which on one of our
	 * own services is usually a level of sharing. Dropping the row here would leave
	 * the screen showing "nobody" for a library that is still being served, which is
	 * the worst of the two possible lies.
	 */
	async function remove (libraryId: string): Promise<void> {
		await caller('api').delete(`/shares/${libraryId}`);
		await load();
	}

	/** What one peer would see of us — the question people ask before saving. */
	function audit (peerId: string): Promise<ShareAudit> {
		return caller('api').get<ShareAudit>(`/shares/audit/${peerId}`);
	}

	return {
		policies,
		loading,
		loaded,
		error,
		byLibraryId,
		load,
		save,
		remove,
		audit,
	};
});
