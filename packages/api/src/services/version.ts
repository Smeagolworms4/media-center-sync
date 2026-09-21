import type { MediaFileInfo } from '@mcs/shared';

/**
 * What both media servers write when a folder holds two cuts of one film.
 *
 * Plex documents `{edition-Director's Cut}` and strips the whole tag before it looks
 * the title up; Jellyfin leaves it in the version name. It is the one spelling worth
 * reading, and deliberately the only one: `Movie (2009) - Extended.mkv` is the other
 * common convention and cannot be told from an episode title, a release group or a
 * subtitle the library kept — guessing there would label a copy `1080p BluRay x264`
 * and then write that label into a filename.
 */
const EDITION_TAG = /[{[]edition-([^}\]]{1,80})[}\]]/i;

/**
 * Which version a copy is, from the fingerprint it already carries.
 *
 * The content identifier is reused rather than hashed again, and that is the whole
 * rule: it is already a function of the bytes alone, already computed identically by
 * two gateways that never speak, and already carried across a peer link. A second
 * scheme — even one derived from the first — would mean two spellings of the same
 * version, and two copies of one file looking like two things to pull.
 *
 * Null is an answer, not a failure: a copy nobody has fingerprinted cannot be said to
 * be the same as, or different from, anything, and inventing an identity per row would
 * turn the one file three friends hold into three versions to download.
 */
export const versionIdOf = (file: MediaFileInfo | null | undefined): string | null => {
	const contentId = file?.contentId;

	return contentId === null || contentId === undefined || contentId === '' ? null : contentId;
};

/** The edition tag a path carries, or null. Never inferred from anything looser. */
export const editionInPath = (path: string | null | undefined): string | null => {
	const match = EDITION_TAG.exec(path ?? '');

	return match ? match[1].trim().replace(/\s+/g, ' ') || null : null;
};

/**
 * The label this copy's cut goes by, the service's own word winning.
 *
 * A service that has the field — Plex does — knows more than the filename does, and a
 * library whose files are named `{edition-…}` is telling us the same thing the only
 * other way it can. Both are labels for people: nothing here decides whether two
 * copies are the same version, which is `versionIdOf`'s job and the fingerprint's.
 */
export const editionOf = (file: MediaFileInfo | null | undefined): string | null => {
	if (!file) {
		return null;
	}

	const reported = file.edition;

	if (typeof reported === 'string' && reported.trim() !== '') {
		return reported.trim();
	}

	return editionInPath(file.path);
};

/**
 * The identities a file can be recognised by, strongest first.
 *
 * A checksum is proof. `contentId` is a few sampled ranges plus the exact size, which
 * two gateways compute identically without exchanging anything — the whole reason it
 * exists. A size on its own is deliberately not in the list: two files of the same
 * length are not the same file, and treating them as such would turn every rule built
 * on this into a machine for inventing matches.
 */
export const contentKeys = (file: MediaFileInfo | null | undefined): string[] => {
	if (!file) {
		return [];
	}

	const keys: string[] = [];

	if (file.checksum !== null && file.checksum !== undefined && file.checksum !== '') {
		keys.push(`checksum:${file.checksum}`);
	}

	if (file.contentId !== null && file.contentId !== undefined && file.contentId !== '') {
		keys.push(`content:${file.contentId}`);
	}

	return keys;
};

/** Two files are the same bytes when anything that identifies their content agrees. */
export const sameContent = (
	left: MediaFileInfo | null | undefined,
	right: MediaFileInfo | null | undefined,
): boolean => {
	const theirs = contentKeys(right);

	return contentKeys(left).some((key) => theirs.includes(key));
};
