import { Logger, type INestApplicationContext } from '@nestjs/common';
import { DiscoveryService, NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';

/**
 * A Nest container with no HTTP server in front of it.
 *
 * The maintenance commands need the repositories, the configuration and the
 * schedulers' dependencies, and none of them need a port. Booting the full
 * application would also bind 4200, which fails the moment one of these is run while
 * the gateway is up — which is exactly when they are useful.
 */
export const createContext = async (): Promise<INestApplicationContext> =>
	NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

/**
 * Looks a provider up by its class name.
 *
 * Commands are written before every manager exists, and a missing one should print a
 * sentence rather than break the build of the whole package. Resolving by name is the
 * only way to ask the container for something the compiler has never heard of; it is
 * deliberately confined to this file, and never used by the application itself.
 */
export const findProviderByName = <T>(app: INestApplicationContext, name: string): T | null => {
	const wrapper = app
		.get(DiscoveryService)
		.getProviders()
		.find((candidate) => candidate.name === name && candidate.instance !== undefined);

	return (wrapper?.instance as T | undefined) ?? null;
};

/** Says, once and clearly, that a command cannot do its job yet. */
export const reportMissing = (name: string): void => {
	process.stdout.write(`${name} is not available yet: this command needs it to do anything.\n`);
};

/**
 * Runs a command and makes its failure visible to the shell.
 *
 * Without the non-zero exit a broken command is a silent success in a Makefile
 * target, and the next target runs on data the previous one never wrote.
 */
export const runCommand = (command: (app: INestApplicationContext) => Promise<void>): void => {
	void (async (): Promise<void> => {
		let app: INestApplicationContext | null = null;

		try {
			app = await createContext();
			await command(app);
		} catch (error) {
			Logger.error(error instanceof Error ? error.stack : String(error), 'Command');
			process.exitCode = 1;
		} finally {
			await app?.close();
		}
	})();
};
