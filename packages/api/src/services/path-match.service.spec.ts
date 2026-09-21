import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MediaServiceType,
	PathMatch,
	ServerStructureSupport,
	type ServerStructure,
} from '@mcs/shared';
import type { HandlerRegistry, ServiceConnection } from './handlers';
import { PathMatchService } from './path-match.service';

const connection: ServiceConnection = {
	id: 'service-1',
	type: MediaServiceType.JELLYFIN,
	baseUrl: 'http://jellyfin:8096',
	token: 'a-token',
	username: null,
	password: null,
};

/** A listing of `names`, in the shape a handler answers. */
const reported = (path: string, names: string[]): ServerStructure => ({
	support: ServerStructureSupport.REPORTED,
	path,
	parent: null,
	entries: names.map((name) => ({
		path: `${path}/${name}`,
		name,
		root: false,
		libraryExternalId: null,
		libraryName: null,
		directory: false,
	})),
});

const unsupported: ServerStructure = {
	support: ServerStructureSupport.UNSUPPORTED,
	path: null,
	parent: null,
	entries: [],
};

/**
 * A server that answers whatever the test hands it, and never a socket.
 *
 * What is pinned down here is the conclusion drawn from an answer, so the answer is a
 * fixture. A lab Jellyfin would make the verdict depend on a container being up,
 * which is the one thing a check about mounts must not do.
 */
const registryOver = (
	answer: (path: string) => Promise<ServerStructure>,
): { handlers: HandlerRegistry; asked: string[] } => {
	const asked: string[] = [];
	const handler = {
		listServerDirectories: async (
			_connection: ServiceConnection,
			request: { path?: string | null } = {},
		): Promise<ServerStructure> => {
			asked.push(request.path ?? '');

			return answer(request.path ?? '');
		},
	};

	return { asked, handlers: { find: () => handler } as unknown as HandlerRegistry };
};

describe('PathMatchService', () => {
	let local: string;

	beforeEach(async () => {
		local = await mkdtemp(join(tmpdir(), 'mcs-path-match-'));
	});

	afterEach(async () => {
		await rm(local, { recursive: true, force: true });
	});

	it('concludes the two are the same directory when the server sees the marker', async () => {
		// The only proof that holds. The two path strings are legitimately different
		// whenever the service runs in its own container — the server says
		// `/data/media/shows`, we see `/mnt/nas/shows` — so comparing them would report
		// a mismatch on every correct deployment.
		const { handlers, asked } = registryOver(async (path) =>
			reported(path, await readdir(local)),
		);

		await expect(
			new PathMatchService(handlers).verify(connection, local, ['/data/media/shows']),
		).resolves.toBe(PathMatch.MATCHED);
		expect(asked).toEqual(['/data/media/shows']);
	});

	it('reports a mismatch when the server looked and the marker was not there', async () => {
		// The failure the whole feature exists to catch: both directories are real, the
		// gateway writes into one and the server scans the other, every transfer
		// succeeds and nothing ever appears.
		const { handlers } = registryOver((path) =>
			Promise.resolve(reported(path, ['The Expanse', 'Firefly'])),
		);

		await expect(
			new PathMatchService(handlers).verify(connection, local, ['/data/media/shows']),
		).resolves.toBe(PathMatch.MISMATCHED);
	});

	it('says it does not know when the server has no way to list a directory', async () => {
		// Reported as a mismatch, this would put a warning on every correctly
		// configured Plex whose build has no browse route — and a warning that is wrong
		// more often than right stops being read.
		const { handlers } = registryOver(() => Promise.resolve(unsupported));

		await expect(
			new PathMatchService(handlers).verify(connection, local, ['/data/media/shows']),
		).resolves.toBe(PathMatch.UNKNOWN);
	});

	it('says it does not know when the listing failed outright', async () => {
		const { handlers } = registryOver(() => Promise.reject(new Error('ECONNRESET')));

		await expect(
			new PathMatchService(handlers).verify(connection, local, ['/data/media/shows']),
		).resolves.toBe(PathMatch.UNKNOWN);
	});

	it('asks nothing at all when there is no server path to compare against', async () => {
		const { handlers, asked } = registryOver((path) => Promise.resolve(reported(path, [])));

		await expect(new PathMatchService(handlers).verify(connection, local, [])).resolves.toBe(
			PathMatch.UNKNOWN,
		);
		await expect(
			new PathMatchService(handlers).verify(connection, null, ['/data/media/shows']),
		).resolves.toBe(PathMatch.UNKNOWN);
		expect(asked).toEqual([]);
	});

	it('leaves nothing behind in somebody’s media folder', async () => {
		// The marker lands inside a directory a media server is watching. It is hidden
		// and carries an extension no scanner recognises, and it is removed even when
		// the listing threw — a file left behind would be indexed as a zero-byte film.
		const { handlers } = registryOver(() => Promise.reject(new Error('ECONNRESET')));

		await new PathMatchService(handlers).verify(connection, local, ['/data/media/shows']);

		await expect(readdir(local)).resolves.toEqual([]);
	});

	it('takes one matching root as the answer, however many the library declares', async () => {
		// A library split across two mounts is mapped onto one of them, and the other
		// is expected not to hold the marker.
		const { handlers, asked } = registryOver(async (path) =>
			path === '/data/anime' ? reported(path, await readdir(local)) : reported(path, []),
		);

		await expect(
			new PathMatchService(handlers).verify(connection, local, ['/data/shows', '/data/anime']),
		).resolves.toBe(PathMatch.MATCHED);
		expect(asked).toEqual(['/data/shows', '/data/anime']);
	});
});
