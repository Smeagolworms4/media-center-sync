import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	ErrorKey,
	LibraryKind,
	MediaServiceType,
	PeerStatus,
	ServerStructureSupport,
	UserRole,
	type Library,
	type LibraryCheck,
	type MediaService,
	type ServerStructure,
	type ServerStructureRequest,
} from '@mcs/shared';
import { LibraryRepository, MediaServiceRepository, PeerRepository } from '@/repositories';
import {
	HandlerRegistry,
	peerBaseUrl,
	serverParentOf,
	type MediaServiceHandler,
	type NormalisedLibrary,
} from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * A port that refuses immediately.
 *
 * The registration probes the service, and a real address would either hang for the
 * handler's whole timeout or — worse — reach something. Port 9 is the discard service:
 * nothing listens on it in a container, so the connection is refused at once and the
 * probe answers "unreachable", which is exactly the case worth exercising here.
 */
const UNREACHABLE = 'http://127.0.0.1:9';

/**
 * A media server that reports folders of its own and never opens a socket.
 *
 * Only the two calls the structure route makes are implemented; everything else
 * throws, so a route that quietly started using one of them fails here rather than in
 * production.
 */
class StructureHandler implements MediaServiceHandler {
	public readonly type = MediaServiceType.JELLYFIN;

	public probe(): never {
		throw new Error('not part of this test');
	}

	public authenticate(): never {
		throw new Error('not part of this test');
	}

	public listLibraries(): Promise<NormalisedLibrary[]> {
		return Promise.resolve([
			{
				externalId: 'folder-1',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/data/media/shows'],
			},
			{
				externalId: 'folder-2',
				name: 'Films',
				kind: LibraryKind.MOVIES,
				paths: ['/data/media/films'],
			},
		]);
	}

	public async listServerDirectories(
		_connection: unknown,
		request: ServerStructureRequest = {},
	): Promise<ServerStructure> {
		if (!request.path) {
			const libraries = await this.listLibraries();

			return {
				support: ServerStructureSupport.REPORTED,
				path: null,
				parent: null,
				entries: libraries.flatMap((library) =>
					library.paths.map((path) => ({
						path,
						name: path.split('/').at(-1) ?? path,
						root: true,
						libraryExternalId: library.externalId,
						libraryName: library.name,
						directory: true,
					})),
				),
			};
		}

		return {
			support: ServerStructureSupport.REPORTED,
			path: request.path,
			parent: serverParentOf(request.path),
			entries: [
				{
					path: `${request.path}/The Expanse`,
					name: 'The Expanse',
					root: false,
					libraryExternalId: null,
					libraryName: null,
					directory: true,
				},
			],
		};
	}

	public scanLibrary(): never {
		throw new Error('not part of this test');
	}

	public refreshLibrary(): never {
		throw new Error('not part of this test');
	}

	/** Nothing to ask a fixture for: what it reports is what the test put in it. */
	public refreshItem(): Promise<boolean> {
		return Promise.resolve(false);
	}

	public requestRescan(): never {
		throw new Error('not part of this test');
	}

	public getItem(): never {
		throw new Error('not part of this test');
	}

	public openArtwork(): never {
		throw new Error('not part of this test');
	}

	public openStream(): never {
		throw new Error('not part of this test');
	}

	public getDownloadUrl(): never {
		throw new Error('not part of this test');
	}
}

describe('Media services', () => {
	let context: TestApp;
	let admin: TestIdentity;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context);
	});

	afterAll(async () => {
		await context.close();
	});

	const authorised = (): request.Test =>
		request(context.app.getHttpServer())
			.post('/api/services')
			.set('Authorization', `Bearer ${admin.token}`);

	it('registers a service and answers with it', async () => {
		const response = await authorised()
			.send({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: UNREACHABLE,
				token: 'a-very-secret-api-key',
			})
			.expect(201);
		const service = response.body as MediaService;

		expect(service.id).toEqual(expect.any(String));
		expect(service.name).toBe('Living room');
		// Registering a service that does not answer is allowed: somebody configures the
		// gateway before starting the media server as often as the other way round.
		expect(service.status).toBe('offline');
	});

	it('never returns the token, on create or on any read afterwards', async () => {
		const created = await authorised()
			.send({
				name: 'Kitchen',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://127.0.0.1:10',
				token: 'a-very-secret-api-key',
			})
			.expect(201);

		const list = await request(context.app.getHttpServer())
			.get('/api/services')
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		const one = await request(context.app.getHttpServer())
			.get(`/api/services/${(created.body as MediaService).id}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		for (const payload of [created.body, list.body, one.body]) {
			expect(JSON.stringify(payload)).not.toContain('a-very-secret-api-key');
			expect(JSON.stringify(payload)).not.toContain('"token"');
		}

		// And it really was stored: the leak being tested is the response, not the write.
		const stored = await context.app
			.get(MediaServiceRepository)
			.findWithSecrets((created.body as MediaService).id);

		expect(stored?.token).toBe('a-very-secret-api-key');
	});

	it('refuses the same base URL twice', async () => {
		const body = {
			name: 'Twice',
			type: MediaServiceType.JELLYFIN,
			baseUrl: 'http://127.0.0.1:11',
		};

		await authorised().send(body).expect(201);

		const response = await authorised().send({ ...body, name: 'Again' }).expect(409);

		expect(response.body).toMatchObject({ message: 'error.service.duplicate' });
	});

	describe('validation', () => {
		it('rejects a bad body with one message per field', async () => {
			const response = await authorised()
				.send({ name: '', type: 'betamax', baseUrl: 'not a url' })
				.expect(400);
			const messages = (response.body as { message: string[] }).message;

			expect(messages.some((entry) => entry.startsWith('name'))).toBe(true);
			expect(messages.some((entry) => entry.startsWith('type'))).toBe(true);
			expect(messages.some((entry) => entry.startsWith('baseUrl'))).toBe(true);
		});

		it('refuses a property the DTO never declared', async () => {
			// Without `forbidNonWhitelisted` this would be dropped quietly, and a body
			// carrying `role: "admin"` into an update meant for a display name would look
			// like nothing had happened.
			const response = await authorised()
				.send({
					name: 'Sneaky',
					type: MediaServiceType.JELLYFIN,
					baseUrl: 'http://127.0.0.1:12',
					status: 'online',
				})
				.expect(400);

			expect((response.body as { message: string[] }).message.join(' ')).toContain('status');
		});

		it('accepts an address with no top-level domain, which is the only kind that matters', async () => {
			await authorised()
				.send({
					name: 'By hostname',
					type: MediaServiceType.JELLYFIN,
					baseUrl: 'http://jellyfin:8096',
				})
				.expect(201);
		});
	});

	it('answers a probe of something unregistered rather than throwing', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/services/probe')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ type: MediaServiceType.JELLYFIN, baseUrl: UNREACHABLE, token: 'wrong' })
			.expect(200);

		expect(response.body).toMatchObject({ reachable: false, authenticated: false });
	});

	describe('the root mappings', () => {
		let localRoot: string;
		let nas2: string;
		let serviceId: string;
		let derivedId: string;
		let exceptionId: string;
		let secondDiskId: string;

		const patchService = (body: Record<string, unknown>): request.Test =>
			request(context.app.getHttpServer())
				.patch(`/api/services/${serviceId}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.send(body);

		const readLibrary = async (id: string): Promise<Library> => {
			const response = await request(context.app.getHttpServer())
				.get(`/api/libraries/${id}`)
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);

			return response.body as Library;
		};

		/** A registration refused by key, on the one input that is wrong. */
		const refusal = async (rootMappings: unknown): Promise<{ key: string; field: string }> => {
			const response = await authorised()
				.send({
					name: 'Refused',
					type: MediaServiceType.JELLYFIN,
					baseUrl: 'http://127.0.0.1:15',
					rootMappings,
				})
				.expect(400);

			return response.body as { key: string; field: string };
		};

		beforeAll(async () => {
			// Directories that really exist, because the derived path is probed like any
			// other: a made-up one would come back unwritable for the right reason and
			// prove nothing about the derivation.
			localRoot = mkdtempSync(join(tmpdir(), 'mcs-roots-'));
			mkdirSync(join(localRoot, 'Shows'));
			nas2 = mkdtempSync(join(tmpdir(), 'mcs-roots-nas2-'));

			const created = await authorised()
				.send({
					name: 'Mapped',
					type: MediaServiceType.JELLYFIN,
					baseUrl: 'http://127.0.0.1:14',
				})
				.expect(201);

			serviceId = (created.body as MediaService).id;
			expect((created.body as MediaService).rootMappings).toEqual([]);

			// Written straight to the repository: the probe above could not reach
			// anything, so the service has no libraries of its own to adopt.
			const libraries = context.app.get(LibraryRepository);

			derivedId = (
				await libraries.save(
					libraries.create({
						serviceId,
						externalId: 'lib-shows',
						name: 'Shows',
						kind: LibraryKind.SHOWS,
						paths: ['/media/Shows'],
					}),
				)
			).id;

			exceptionId = (
				await libraries.save(
					libraries.create({
						serviceId,
						externalId: 'lib-films',
						name: 'Films',
						kind: LibraryKind.MOVIES,
						paths: ['/media/Films'],
						localPath: localRoot,
						writable: true,
					}),
				)
			).id;

			secondDiskId = (
				await libraries.save(
					libraries.create({
						serviceId,
						externalId: 'lib-docs',
						name: 'Documentaries',
						kind: LibraryKind.MOVIES,
						paths: ['/srv/docs'],
					}),
				)
			).id;
		});

		it('stores the pairs, in one spelling, and reads them back', async () => {
			const response = await patchService({
				rootMappings: [
					{ remoteRoot: '/media/', localRoot },
					{ remoteRoot: '/srv/docs', localRoot: `${nas2}/` },
				],
			}).expect(200);

			expect((response.body as MediaService).rootMappings).toEqual([
				{ remoteRoot: '/media', localRoot },
				{ remoteRoot: '/srv/docs', localRoot: nas2 },
			]);
			expect((response.body as MediaService).filesMounted).toBe(true);
		});

		it('gives each library with no path of its own the one its disk implies', async () => {
			const library = await readLibrary(derivedId);

			expect(library.localPath).toBe(join(localRoot, 'Shows'));
			// Probed, not assumed: the directory exists, so this library really can
			// receive transfers.
			expect(library.writable).toBe(true);
			expect((await readLibrary(secondDiskId)).localPath).toBe(nas2);
		});

		it('leaves a path somebody typed for one library alone', async () => {
			// That field is for the exceptions the mapping cannot express, and the
			// mapping overwriting it would undo the fix at the next scan.
			expect((await readLibrary(exceptionId)).localPath).toBe(localRoot);
		});

		it('says which paths it worked out and which somebody typed', async () => {
			const response = await request(context.app.getHttpServer())
				.get('/api/libraries/check')
				.set('Authorization', `Bearer ${admin.token}`)
				.expect(200);
			const checks = response.body as LibraryCheck[];

			expect(checks.find((check) => check.libraryId === derivedId)?.derived).toBe(true);
			expect(checks.find((check) => check.libraryId === exceptionId)?.derived).toBe(false);
		});

		it('moves the derived paths when a pair is corrected, and drops them when it is removed', async () => {
			const moved = mkdtempSync(join(tmpdir(), 'mcs-roots-moved-'));

			await patchService({ rootMappings: [{ remoteRoot: '/media', localRoot: moved }] }).expect(200);

			expect((await readLibrary(derivedId)).localPath).toBe(join(moved, 'Shows'));
			// Its disk is no longer mapped: no path, rather than the one it had.
			expect((await readLibrary(secondDiskId)).localPath).toBeNull();
			// And the exception is still the exception.
			expect((await readLibrary(exceptionId)).localPath).toBe(localRoot);
		});

		it('lets the most specific of two nested prefixes win', async () => {
			await patchService({
				rootMappings: [
					{ remoteRoot: '/media/Shows', localRoot: nas2 },
					{ remoteRoot: '/media', localRoot },
				],
			}).expect(200);

			expect((await readLibrary(derivedId)).localPath).toBe(nas2);
		});

		it('withdraws every mapping on an empty list, keeping the service ours through its typed path', async () => {
			const response = await patchService({ rootMappings: [] }).expect(200);

			expect((response.body as MediaService).rootMappings).toEqual([]);
			expect((await readLibrary(derivedId)).localPath).toBeNull();
			// The typed path is a mapping of its own, so the files are still ours.
			expect((response.body as MediaService).filesMounted).toBe(true);
		});

		it('refuses an empty side by key, naming the input', async () => {
			await expect(refusal([{ remoteRoot: '/media', localRoot: '' }])).resolves.toEqual(
				expect.objectContaining({ key: ErrorKey.SERVICE_MAPPING_EMPTY, field: 'rootMappings.0.localRoot' }),
			);
			await expect(refusal([{ localRoot: '/mnt/nas' }])).resolves.toEqual(
				expect.objectContaining({ key: ErrorKey.SERVICE_MAPPING_EMPTY, field: 'rootMappings.0.remoteRoot' }),
			);
		});

		it('refuses a relative path, which means a different directory in every process', async () => {
			await expect(
				refusal([
					{ remoteRoot: '/media', localRoot: '/mnt/nas' },
					{ remoteRoot: 'srv/docs', localRoot: '/mnt/nas2' },
				]),
			).resolves.toEqual(
				expect.objectContaining({ key: ErrorKey.SERVICE_MAPPING_RELATIVE, field: 'rootMappings.1.remoteRoot' }),
			);
		});

		it('refuses the same server prefix twice, however it is spelled', async () => {
			await expect(
				refusal([
					{ remoteRoot: '/media', localRoot: '/mnt/nas' },
					{ remoteRoot: '/media/', localRoot: '/mnt/other' },
				]),
			).resolves.toEqual(
				expect.objectContaining({ key: ErrorKey.SERVICE_MAPPING_DUPLICATE, field: 'rootMappings.1.remoteRoot' }),
			);
		});

		it('refuses what is not a list of pairs of strings', async () => {
			// `null` included: an empty list already says "none", and a second spelling
			// is the one a client ends up sending untested.
			for (const [body, field] of [
				[null, 'rootMappings'],
				['/media=/mnt/nas', 'rootMappings'],
				[['/media'], 'rootMappings.0'],
				[[{ remoteRoot: '/media', localRoot: '/mnt/nas', extra: true }], 'rootMappings.0'],
				[[['/media', '/mnt/nas']], 'rootMappings.0'],
				[[{ remoteRoot: `/${'a'.repeat(1100)}`, localRoot: '/mnt/nas' }], 'rootMappings.0.remoteRoot'],
			] as const) {
				await expect(refusal(body)).resolves.toEqual(
					expect.objectContaining({ key: ErrorKey.SERVICE_MAPPING_INVALID, field }),
				);
			}
		});

		it('registers a service with no mapping at all, which is the ordinary case', async () => {
			await authorised()
				.send({
					name: 'Unmapped',
					type: MediaServiceType.JELLYFIN,
					baseUrl: 'http://127.0.0.1:17',
				})
				.expect(201);
		});
	});

	it('answers 202 for a scan, because a full one takes minutes', async () => {
		const created = await authorised()
			.send({
				name: 'Scannable',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://127.0.0.1:13',
			})
			.expect(201);

		await request(context.app.getHttpServer())
			.post(`/api/services/${(created.body as MediaService).id}/scan`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(202);
	});

	/**
	 * What the server says about its own folders, over HTTP.
	 *
	 * The handler is faked rather than reached: what is being proved here is that the
	 * route, the guard and the serialisation carry a handler's answer through
	 * unchanged, and a lab Jellyfin would make that depend on a container being up.
	 */
	describe('the folders a service reports as its own', () => {
		let jellyfinId: string;
		let peerId: string;
		let real: MediaServiceHandler;

		beforeAll(async () => {
			const registry = context.app.get(HandlerRegistry);

			real = registry.get(MediaServiceType.JELLYFIN);
			registry.register(new StructureHandler());

			const services = context.app.get(MediaServiceRepository);

			jellyfinId = (
				await services.save(
					services.create({
						name: 'Structured',
						type: MediaServiceType.JELLYFIN,
						baseUrl: 'http://127.0.0.1:41',
					}),
				)
			).id;

			// A real peer row, because the registration carries a foreign key to one —
			// and because a peer-backed service that stands for no peer is a state the
			// application never produces.
			const peers = context.app.get(PeerRepository);
			const friend = await peers.save(
				peers.create({
					name: "A friend's gateway",
					fingerprint: 'ff'.repeat(16),
					publicKey: 'not-a-real-key',
					status: PeerStatus.LINKED,
				}),
			);

			peerId = (
				await services.save(
					services.create({
						name: "A friend's shelves",
						type: MediaServiceType.PEER,
						baseUrl: peerBaseUrl(friend.id),
						peerId: friend.id,
					}),
				)
			).id;
		});

		afterAll(() => {
			// Put the real one back: the registry is the running application's, and a
			// fake left in it would quietly answer for every test added after this file.
			context.app.get(HandlerRegistry).register(real);
		});

		const structure = (id: string, query = ''): request.Test =>
			request(context.app.getHttpServer())
				.get(`/api/services/${id}/structure${query}`)
				.set('Authorization', `Bearer ${admin.token}`);

		it('names the library roots the server declares', async () => {
			const response = await structure(jellyfinId).expect(200);
			const answer = response.body as ServerStructure;

			expect(answer.support).toBe('reported');
			expect(answer.entries).toEqual([
				expect.objectContaining({
					path: '/data/media/shows',
					name: 'shows',
					root: true,
					libraryName: 'Shows',
				}),
				expect.objectContaining({ path: '/data/media/films', libraryName: 'Films' }),
			]);
		});

		it('walks into one of them when asked', async () => {
			const response = await structure(jellyfinId, '?path=/data/media/shows').expect(200);
			const answer = response.body as ServerStructure;

			expect(answer.path).toBe('/data/media/shows');
			expect(answer.parent).toBe('/data/media');
			expect(answer.entries.map((entry) => entry.name)).toEqual(['The Expanse']);
		});

		it('offers none of a peer-backed service, because their paths are not ours', async () => {
			// A path on a friend's disk designates nothing here. Offered as a candidate
			// it would be written into a local path field and accepted, which is the
			// silent failure this whole feature exists to catch — with the gateway's own
			// interface as the source of the bad value.
			const response = await structure(peerId).expect(200);

			expect(response.body).toEqual({
				support: 'unsupported',
				path: null,
				parent: null,
				entries: [],
			});
		});

		it('is refused to somebody who does not configure this gateway', async () => {
			const reader = await signInAs(context, UserRole.USER);

			await request(context.app.getHttpServer())
				.get(`/api/services/${jellyfinId}/structure`)
				.set('Authorization', `Bearer ${reader.token}`)
				.expect(403);
		});
	});
});
