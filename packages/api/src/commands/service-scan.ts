import 'reflect-metadata';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { findProviderByName, reportMissing, runCommand } from './context';

/** The one method this command needs from whatever ends up owning the scans. */
interface Scanner {
	scan(id: string): Promise<unknown>;
}

/**
 * Re-reads everything a service holds.
 *
 * A full pass, not a refresh: refreshes only see what a service reports as new, so
 * files moved, deleted or re-encoded in place stay wrong in the index until one of
 * these runs.
 */
runCommand(async (app) => {
	const id = process.argv[2];

	if (id === undefined || id === '') {
		process.stdout.write('Usage: service:scan <service id>\n');
		process.exitCode = 1;

		return;
	}

	const service = await app.get(MediaServiceRepository).findOne({ where: { id } });

	if (service === null) {
		process.stdout.write(`No service with id ${id}.\n`);
		process.exitCode = 1;

		return;
	}

	const scanner = findProviderByName<Scanner>(app, 'ScanManager');

	if (scanner === null) {
		const libraries = await app.get(LibraryRepository).findByService(id);
		const items = await app.get(MediaItemRepository).countByService(id);

		reportMissing('ScanManager');
		process.stdout.write(
			`Indexed today: ${libraries.length} libraries, ${items} items for ${service.name}.\n`,
		);

		return;
	}

	await scanner.scan(id);
	process.stdout.write(`Scan of ${service.name} finished.\n`);
});
