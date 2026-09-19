import type { ShareAudit, SharePolicy, UpdateSharePolicyRequest } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * What each library exposes, and to whom.
 *
 * A library with no policy is private: the absence of a row is a decision, not a
 * gap, which is why deleting a policy is the same thing as never having shared
 * the library at all.
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

	async function remove (libraryId: string): Promise<void> {
		await caller('api').delete(`/shares/${libraryId}`);
		policies.value = policies.value.filter(one => one.libraryId !== libraryId);
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
