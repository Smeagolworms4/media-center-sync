import 'reflect-metadata';
import { constants } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import type { LibraryCheck } from '@mcs/shared';
import { LibraryRepository } from '@/repositories';
import { runCommand } from './context';

const checkPath = async (
	localPath: string | null,
): Promise<Omit<LibraryCheck, 'libraryId' | 'name' | 'localPath' | 'derived'>> => {
	if (localPath === null || localPath === '') {
		return { exists: false, readable: false, writable: false, freeBytes: null, error: 'no local path' };
	}

	try {
		await access(localPath, constants.F_OK);
	} catch {
		return { exists: false, readable: false, writable: false, freeBytes: null, error: 'missing' };
	}

	// Read and write are probed separately because they fail for different reasons and
	// call for different fixes: a readable library that cannot be written to is a
	// permissions problem on the gateway's side, and it only shows up on the first
	// transfer otherwise.
	const readable = await access(localPath, constants.R_OK).then(
		() => true,
		() => false,
	);
	const writable = await access(localPath, constants.W_OK).then(
		() => true,
		() => false,
	);
	const freeBytes = await statfs(localPath).then(
		(stats) => Number(stats.bavail) * Number(stats.bsize),
		() => null,
	);

	return { exists: true, readable, writable, freeBytes, error: null };
};

/**
 * Reports what the gateway can actually do with each declared library.
 *
 * The usual failure is not an error at all: the mount is there, the transfer
 * succeeds, and the media service never sees the file because the two sides do not
 * point at the same directory. This command is what turns that into something visible
 * before a transfer is started rather than after one has finished.
 */
runCommand(async (app) => {
	const libraries = await app.get(LibraryRepository).find({ order: { name: 'ASC' } });

	if (libraries.length === 0) {
		process.stdout.write('No library registered yet.\n');

		return;
	}

	for (const library of libraries) {
		const result = await checkPath(library.localPath);
		const state = result.error ?? `${result.readable ? 'r' : '-'}${result.writable ? 'w' : '-'}`;
		const free = result.freeBytes === null ? '' : ` ${Math.round(result.freeBytes / 1024 ** 3)} GiB free`;
		// Where the path came from, because the two are fixed in different places: a
		// typed path is wrong on its own, a derived one is wrong for every library of
		// the service at once and the mapping is what to correct.
		const origin = library.localPathDerived ? ' (derived)' : '';

		process.stdout.write(
			`${library.name}\t${library.localPath ?? '-'}${origin}\t${state}${free}\n`,
		);
	}
});
