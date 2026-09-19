import { MediaServiceType } from '@mcs/shared';
import { CacheService } from '@/services/cache.service';
import { JellyfinHandler } from '@/services/handlers/jellyfin.handler';
import type {
	MediaServiceHandler,
	ServiceConnection,
} from '@/services/handlers/media-handler.interface';
import { PlexHandler } from '@/services/handlers/plex.handler';

/**
 * Runs both handlers against the lab servers and prints what they made of them.
 *
 * It exists because a handler tested only against recorded payloads is a handler
 * tested against what we believed a server answers. This one talks to the real thing,
 * with no database and no application around it, so what it prints is exactly what the
 * indexing layer would have been handed.
 *
 *     make lab/up
 *     make lab/probe JF_KEY=<the key lab/up printed>
 *
 * Reading the output is the point: the normalised titles of two servers holding the
 * same show have to come out identical, or correlation has nothing to join on. That is
 * how the show-title rule in both handlers was found.
 */
const probe = async (label: string, handler: MediaServiceHandler, connection: ServiceConnection): Promise<void> => {
	console.log(`\n=== ${label} ===`);

	const result = await handler.probe(connection);
	console.log(
		`reachable: ${result.reachable} | authenticated: ${result.authenticated}` +
			` | version: ${result.version} | server: ${result.serverName}` +
			(result.error ? ` | error: ${result.error}` : ''),
	);

	if (!result.reachable) {
		return;
	}

	for (const library of await handler.listLibraries(connection)) {
		const kinds: Record<string, number> = {};
		const lines: string[] = [];

		for await (const item of handler.scanLibrary(connection, library)) {
			kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;

			if (!item.file) {
				continue;
			}

			const { videoCodec, width, height, size, bitrate } = item.file;
			const episode =
				item.seasonNumber === null ? '' : ` S${item.seasonNumber}E${item.episodeNumber}`;

			lines.push(
				`${item.normalizedTitle}${episode} [${videoCodec} ${width}x${height} ${size}b ${bitrate}bps]`,
			);
		}

		console.log(`  ${library.name} ${JSON.stringify(kinds)}`);
		lines.sort().forEach((line) => console.log(`    ${line}`));
	}
};

const main = async (): Promise<void> => {
	const cache = new CacheService();

	// The lab Plex runs unclaimed and needs no token; the lab Jellyfin mints one, and
	// `make lab/up` prints it.
	const targets: [string, MediaServiceHandler, ServiceConnection][] = [
		[
			'Jellyfin',
			new JellyfinHandler(),
			{
				id: 'lab-jellyfin',
				type: MediaServiceType.JELLYFIN,
				baseUrl: process.env.JF_URL ?? 'http://localhost:8096',
				token: process.env.JF_KEY ?? null,
				username: null,
				password: null,
			},
		],
		[
			'Plex',
			new PlexHandler(cache),
			{
				id: 'lab-plex',
				type: MediaServiceType.PLEX,
				baseUrl: process.env.PLEX_URL ?? 'http://localhost:32400',
				token: process.env.PLEX_TOKEN ?? null,
				username: null,
				password: null,
			},
		],
	];

	for (const [label, handler, connection] of targets) {
		// One unreachable server must not hide what the other says: this is a
		// diagnostic, and half an answer beats none.
		await probe(label, handler, connection).catch((error: unknown) => {
			console.error(`${label} failed:`, error instanceof Error ? error.message : error);
		});
	}
};

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
