import 'reflect-metadata';
import type { Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApp } from '@/bootstrap';
import { EventGatewayService } from '@/services';

const start = async (): Promise<void> => {
	const app = await createApp();
	const config = app.get(ConfigService);
	const port = config.getOrThrow<number>('port');
	const prefix = config.getOrThrow<string>('prefix');

	// `0.0.0.0` and not the default: bound to the loopback interface, the process is
	// unreachable from outside its own container, and the only symptom is a port that
	// answers nothing.
	await app.listen(port, '0.0.0.0');

	// The progress stream shares the HTTP port, so it can only be attached once that
	// port is listening. Forgetting this call costs nothing visible: the API answers
	// normally, the interface connects and is refused, and every progress bar stays
	// at zero while the files arrive perfectly well.
	app.get(EventGatewayService).attach(app.getHttpServer() as Server);

	Logger.log(`Gateway listening on http://0.0.0.0:${port}/${prefix}`, 'Bootstrap');
};

start().catch((error: unknown) => {
	// A gateway that failed to start must not linger: the container has to see it exit
	// so that it is restarted rather than reported as running.
	Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap');
	process.exit(1);
});
