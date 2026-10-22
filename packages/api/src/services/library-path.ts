import { join } from 'node:path';
import { normaliseRootPath, pathComponents, type RootMapping } from '@mcs/shared';

/** The parts of a library this mapping needs, so a caller can pass a row or a fake. */
export interface PathMappedLibrary {
	/** Roots as the media service reports them — its own, not ours. */
	paths: string[];
	/** Where the gateway can reach the same files, when somebody has told us. */
	localPath: string | null;
}

/**
 * Where the gateway reaches one declared root of a library.
 *
 * `localPath` is the library's single answer, and it is only ever true of one of its
 * roots. A shelf called `Series TV` is five directories on five disks here, and every
 * path reported under the second, third, fourth or fifth of them used to be rewritten
 * onto the first: a path that does not exist, on another disk. Nothing failed. The
 * gateway simply believed a show it holds on disk five sat on disk one, so it filed
 * season two there — beside nothing, while season one stayed where it was, and no media
 * server shows the two as one series. In the owner's words: *il a mal rangé la saison 2*.
 *
 * So the root that matched is translated through the service's own mappings, which are
 * the only statement of one directory per disk. `localPath` still answers for the root
 * it was derived from — somebody typing a path there is correcting that one, and a
 * mapping must not undo it — and for everything the mappings cannot translate, which is
 * what a library on a single disk has always relied on.
 */
const reachableRoot = (
	library: PathMappedLibrary,
	root: string,
	service: ServiceRootMappings | null,
): string | null => {
	// Guarded rather than trusted, the way every other reader of this column guards it:
	// it is JSON on a row that may predate it, and a service with nothing stated is a
	// service that cannot tell its own roots apart — which is the state this answers for
	// by falling back to the library.
	const mappings = service?.rootMappings ?? [];
	const mapped = mappedLocalPath(root, mappings);
	const primary = derivedLocalPath(library.paths, { rootMappings: mappings });

	return mapped === null || mapped === primary ? (library.localPath ?? mapped) : mapped;
};

/**
 * The path as the gateway sees it, from the path a service reported.
 *
 * The two differ as soon as the service runs in its own container: Jellyfin says
 * `/media/Shows/…` and the gateway sees `/mnt/nas/Shows/…`. Every use of a reported
 * path outside the service that reported it has to go through here — reading a file to
 * fingerprint it, and looking at how a library files its shows before putting something
 * new in it. Skipping the translation does not fail loudly; it silently decides that
 * the gateway holds nothing at that path, and the feature that depended on it just
 * stops happening.
 *
 * Only a root the library actually declares is rewritten. Anything else yields null,
 * because a prefix guessed here is a read outside the library.
 *
 * The service is optional and carries the mappings that tell its roots apart — see
 * `reachableRoot`. Without it the library's single `localPath` answers for every root,
 * which is right for a library on one disk and a guess for a shelf spread over five:
 * every caller holding a service should pass it.
 */
export const toLocalPath = (
	library: PathMappedLibrary,
	reported: string | null,
	service: ServiceRootMappings | null = null,
): string | null => {
	if (reported === null || reported === '') {
		return null;
	}

	for (const root of library.paths) {
		if (reported !== root && !reported.startsWith(`${root}/`)) {
			continue;
		}

		const base = reachableRoot(library, root, service);

		if (base === null || base === '') {
			return null;
		}

		return reported === root ? base : join(base, reported.slice(root.length));
	}

	return null;
};

/** The part of a service this derivation reads, so a caller can pass a row or a fake. */
export interface ServiceRootMappings {
	rootMappings: readonly RootMapping[];
}

/**
 * One reported path, rewritten through the most specific mapping it sits under.
 *
 * Longest prefix, measured in path components, and that is the whole rule. In
 * components because `/data/movies2` is not under `/data/movies` however the letters
 * line up. Longest because nested mounts are a real setup — `/data` on the NAS and
 * `/data/4k` on a faster disk — and a film under `/data/4k` would otherwise be sent
 * to the NAS directory that merely shares its parent. Validation refuses the same
 * prefix listed twice, so the most specific match is always a single answer and never
 * depends on the order somebody typed the rows in.
 *
 * A path climbing out of its prefix with `..` gets nothing: rewriting it would name a
 * directory outside the one the mapping declared, which is a guess, not a mapping.
 */
export const mappedLocalPath = (reported: string, mappings: readonly RootMapping[]): string | null => {
	if (!reported.trim().startsWith('/')) {
		return null;
	}

	const path = pathComponents(reported);

	if (path.some((component) => component === '..' || component === '.')) {
		return null;
	}

	let best: { depth: number; localRoot: string } | null = null;

	for (const mapping of mappings) {
		const prefix = pathComponents(mapping.remoteRoot);
		const local = mapping.localRoot.trim();

		if (local === '' || prefix.length > path.length || (best !== null && prefix.length <= best.depth)) {
			continue;
		}

		if (prefix.every((component, index) => path[index] === component)) {
			best = { depth: prefix.length, localRoot: local };
		}
	}

	if (best === null) {
		return null;
	}

	return join(normaliseRootPath(best.localRoot), ...path.slice(best.depth));
};

/**
 * Where a library's files are for us, worked out from its service's mappings.
 *
 * This is what a service states once per disk instead of every library stating it
 * again: a server with six libraries was six paths to type and six chances to get one
 * wrong, and a library whose two paths do not designate the same directory accepts
 * transfers the media server never sees, with nothing anywhere reporting an error.
 *
 * Null whenever the mappings cannot answer: none stated, no reported path, or no path
 * under any of them. A null is the caller's signal to fall back to what somebody
 * typed, and it is deliberately preferred to a guess — a rewritten prefix that was
 * never declared points the gateway at a directory nobody chose, which is the failure
 * this whole mapping exists to prevent.
 *
 * Only the first reported path the mappings can answer for is used. A library
 * declaring several roots is declaring several places its own service reads from, and
 * a gateway has one directory to write into; taking the first keeps the answer stable
 * across scans, where picking "the best" would depend on the order the service listed
 * them in.
 */
/**
 * Every root of a library the gateway can reach, in the order the service lists them.
 *
 * `derivedLocalPath` answers with the first, on the reasoning that a gateway has one
 * directory to write into. That is true of one transfer and false of the library: a
 * shelf called `Series TV` can be five directories on five disks, and a household that
 * wants a show on the fifth had no way to say so and nothing telling them why. The
 * single answer stays where it is — it is what a scan translates paths with — and this
 * is what a person is offered when they are choosing.
 *
 * A root the mappings cannot answer for is left out rather than guessed at: a rewritten
 * prefix nobody declared points at a directory nobody chose, which is the failure the
 * mapping exists to prevent.
 */
export const derivedLocalRoots = (
	reported: readonly string[],
	service: ServiceRootMappings,
): string[] => {
	const roots: string[] = [];

	for (const entry of reported) {
		const local = mappedLocalPath(entry, service.rootMappings);

		// Distinct, because two reported roots under one mapping can land on the same
		// directory, and offering the same folder twice reads as a fault in the list.
		if (local !== null && !roots.includes(local)) {
			roots.push(local);
		}
	}

	return roots;
};

export const derivedLocalPath = (
	reported: readonly string[],
	service: ServiceRootMappings,
): string | null => {
	for (const entry of reported) {
		const local = mappedLocalPath(entry, service.rootMappings);

		if (local !== null) {
			return local;
		}
	}

	return null;
};
