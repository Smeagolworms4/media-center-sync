import 'reflect-metadata';
import { LibraryRepository, MediaServiceRepository } from '@/repositories';
import { runCommand } from './context';

/**
 * Lists the registered services in the order a sync consults them.
 *
 * Read straight from the index rather than by probing: this is what the gateway
 * believes, and when it disagrees with reality that disagreement is the answer
 * somebody is looking for. `service/probe` is the command that goes and asks.
 */
runCommand(async (app) => {
	const services = await app.get(MediaServiceRepository).findByPriority();
	const libraries = app.get(LibraryRepository);

	if (services.length === 0) {
		process.stdout.write('No media service registered yet.\n');

		return;
	}

	for (const service of services) {
		const count = await libraries.count({ where: { serviceId: service.id } });

		process.stdout.write(
			[
				service.id,
				service.name,
				service.type,
				service.scope,
				service.status,
				`priority ${service.priority}`,
				`${count} libraries`,
				service.baseUrl,
			].join('\t') + '\n',
		);
	}
});
