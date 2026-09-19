import 'reflect-metadata';
import type { MediaServiceProbe } from '@mcs/shared';
import { MediaServiceRepository } from '@/repositories';
import { findProviderByName, reportMissing, runCommand } from './context';

/** The one method this command needs from whatever ends up owning the handlers. */
interface Prober {
	probe(id: string): Promise<MediaServiceProbe>;
}

/**
 * Asks one service whether it is really there, and what it holds.
 *
 * The probe itself belongs to the handler of that service type, which knows how to
 * authenticate against Jellyfin or Plex. The command only resolves it and prints the
 * answer.
 */
runCommand(async (app) => {
	const id = process.argv[2];

	if (id === undefined || id === '') {
		process.stdout.write('Usage: service:probe <service id>\n');
		process.exitCode = 1;

		return;
	}

	const service = await app.get(MediaServiceRepository).findOne({ where: { id } });

	if (service === null) {
		process.stdout.write(`No service with id ${id}.\n`);
		process.exitCode = 1;

		return;
	}

	const prober = findProviderByName<Prober>(app, 'ServiceManager');

	if (prober === null) {
		reportMissing('ServiceManager');
		process.stdout.write(`Known: ${service.name} (${service.type}) at ${service.baseUrl}, last seen ${service.status}.\n`);

		return;
	}

	const result = await prober.probe(id);

	process.stdout.write(
		`${service.name}: ${result.reachable ? 'reachable' : 'unreachable'}, ` +
			`${result.authenticated ? 'authenticated' : 'not authenticated'}, ` +
			`version ${result.version ?? 'unknown'}, ${result.libraries.length} libraries` +
			`${result.error === null ? '' : `, error ${result.error}`}\n`,
	);
});
