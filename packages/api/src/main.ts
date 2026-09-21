import 'reflect-metadata';
import type { Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApp } from '@/bootstrap';
import {
	EVENTS_PATH,
	EventGatewayService,
	PEER_LINK_PATH,
	PEER_RELAY_PATH,
	PeerGatewayService,
	refuseUnknownUpgrades,
} from '@/services';

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
	const server = app.getHttpServer() as Server;

	app.get(EventGatewayService).attach(server);

	// Peer links share the same port, and that is the whole networking story: one port
	// to open, one certificate, one reverse-proxy entry. Each gateway claims a path and
	// ignores the others, so the order they are attached in does not matter.
	app.get(PeerGatewayService).attach(server);

	// Last, and it has to be last: both handlers above return rather than reject when
	// the path is not theirs, so without this an upgrade to anything else is left half
	// open until some timeout somewhere gives up on it.
	refuseUnknownUpgrades(server, [EVENTS_PATH, PEER_LINK_PATH, PEER_RELAY_PATH]);

	Logger.log(`Gateway listening on http://0.0.0.0:${port}/${prefix}`, 'Bootstrap');
};

start().catch((error: unknown) => {
	// A gateway that failed to start must not linger: the container has to see it exit
	// so that it is restarted rather than reported as running.
	Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap');
	process.exit(1);
});
