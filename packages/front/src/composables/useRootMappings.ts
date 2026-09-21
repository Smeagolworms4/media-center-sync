import type { RootMapping } from '@mcs/shared';
import { normaliseRootPath, pathComponents } from '@mcs/shared';
import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from 'vue';

/** Whether `path` is `prefix` or sits under it, compared component by component. */
function under (path: string[], prefix: string[]): boolean {
	return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

/**
 * The server prefixes worth offering as mappings, from the paths a probe reported.
 *
 * One suggestion per top-level directory the libraries live under, each the longest
 * prefix its libraries share. That is a decision between two worse ones:
 *
 *  - the single longest prefix common to every library, which is what the form offered
 *    when a service carried one pair, answers `/` — nothing — for the case the list
 *    exists for: films under `/data/movies`, shows under `/srv/shows`, two disks;
 *  - one suggestion per library is always correct and turns a server with six
 *    libraries on one disk into six rows, each with a local side to browse to — the
 *    typing the mapping exists to remove.
 *
 * Grouping by the first component keeps the one-disk server one row (`/data/media/shows`
 * and `/data/media/films` give `/data/media`) and splits the two-disk server into two
 * rows, because two top-level directories in a media server's container are nearly
 * always two mounts. When they are not the right cut — two disks under one `/data` —
 * the server's own folders are one click away in the picker beside the field, where
 * each library root can be chosen on its own.
 *
 * A path that is not absolute is left out: a Plex on Windows answers `D:\Media`, which
 * no mapping here can match. So is anything a listed row already covers, so a
 * suggestion disappears once it has been taken rather than inviting a duplicate.
 */
export function suggestedServerRoots (
	reported: readonly string[],
	listed: readonly RootMapping[],
): string[] {
	const covered = listed
		.filter(mapping => mapping.remoteRoot.trim().startsWith('/'))
		.map(mapping => pathComponents(mapping.remoteRoot));
	const groups = new Map<string, string[][]>();

	for (const path of reported) {
		if (!path.trim().startsWith('/')) {
			continue;
		}

		const parts = pathComponents(path);

		if (parts.length === 0 || covered.some(prefix => under(parts, prefix))) {
			continue;
		}

		groups.set(parts[0], [...(groups.get(parts[0]) ?? []), parts]);
	}

	return [...groups.values()].map(paths => {
		const shared: string[] = [];

		for (const [index, part] of paths[0].entries()) {
			if (!paths.every(one => one[index] === part)) {
				break;
			}
			shared.push(part);
		}

		return normaliseRootPath(`/${shared.join('/')}`);
	});
}

/** The suggestions, kept current as the probe answers and rows are added. */
export function useRootMappingSuggestions (
	reported: MaybeRefOrGetter<readonly string[]>,
	listed: MaybeRefOrGetter<readonly RootMapping[]>,
): ComputedRef<string[]> {
	return computed(() => suggestedServerRoots(toValue(reported), toValue(listed)));
}
