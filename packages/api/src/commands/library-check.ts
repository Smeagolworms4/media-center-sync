import 'reflect-metadata';
import { PathMatch } from '@mcs/shared';
import { LibraryManager } from '@/managers';
import { runCommand } from './context';

/**
 * Reports what the gateway can actually do with each declared library.
 *
 * The usual failure is not an error at all: the mount is there, the transfer
 * succeeds, and the media service never sees the file because the two sides do not
 * point at the same directory. This command is what turns that into something visible
 * before a transfer is started rather than after one has finished.
 *
 * It asks the manager rather than probing the paths itself, and that is a repair: the
 * two implementations had already drifted — this one walked every library including a
 * peer's, printing "no local path" for shelves that can never have one and cannot be
 * fixed. More importantly, only the manager can ask the media server whether it sees
 * a file we have just written, which is the one thing that actually proves the two
 * paths are the same directory. A command that printed `rw` for a library the server
 * has never heard of is precisely the false reassurance this whole check exists to
 * remove.
 */
const STATE_BY_MATCH: Record<PathMatch, string> = {
	[PathMatch.MATCHED]: 'server sees it',
	[PathMatch.MISMATCHED]: 'NOT THE SAME DIRECTORY AS THE SERVER READS',
	// Said plainly rather than left blank: "nobody could be asked" is a different
	// thing from "asked and fine", and a blank column reads as the second.
	[PathMatch.UNKNOWN]: 'server could not say',
};

runCommand(async (app) => {
	const checks = await app.get(LibraryManager).check();

	if (checks.length === 0) {
		process.stdout.write('No library the gateway could write into is registered yet.\n');

		return;
	}

	for (const check of checks) {
		const state = check.error ?? `${check.readable ? 'r' : '-'}${check.writable ? 'w' : '-'}`;
		const free = check.freeBytes === null ? '' : ` ${Math.round(check.freeBytes / 1024 ** 3)} GiB free`;
		// Where the path came from, because the two are fixed in different places: a
		// typed path is wrong on its own, a derived one is wrong for every library of
		// the service at once and the mapping is what to correct.
		const origin = check.derived ? ' (derived)' : '';
		const server = check.serverPaths.length === 0 ? '-' : check.serverPaths.join(', ');

		process.stdout.write(
			`${check.name}\t${check.localPath ?? '-'}${origin}\t${state}${free}\n`
				+ `\tserver: ${server}\t${STATE_BY_MATCH[check.match]}\n`,
		);
	}
});
