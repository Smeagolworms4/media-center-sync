import type { DirectoryListing } from '@mcs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * The directories the gateway itself can see.
 *
 * Read-only, and held in a store rather than called from the dialog because a
 * component never builds a URL. Nothing is cached: a browse is a question about a
 * filesystem that somebody may have just changed — a mount that came up, a folder
 * they made in another window — and a remembered listing is the one thing that would
 * make this assist lie.
 */
export const useFilesystemStore = defineStore('filesystem', () => {
	const { caller } = useCaller();

	const loading = ref(false);

	/**
	 * One directory's worth of directories.
	 *
	 * Failures are silent as far as the global notifier is concerned: a refused path
	 * is an answer this dialog shows in place of its list, and a toast over the whole
	 * application for a path somebody is still choosing would be noise about nothing.
	 */
	async function browse (path?: string | null, includeHidden = false): Promise<DirectoryListing> {
		const params = new URLSearchParams();

		if (path) {
			params.set('path', path);
		}
		if (includeHidden) {
			params.set('includeHidden', 'true');
		}

		const query = params.toString();

		loading.value = true;
		try {
			return await caller('api').get<DirectoryListing>(
				`/filesystem/directories${query ? `?${query}` : ''}`,
				{ silentError: true },
			);
		} finally {
			loading.value = false;
		}
	}

	return { loading, browse };
});
