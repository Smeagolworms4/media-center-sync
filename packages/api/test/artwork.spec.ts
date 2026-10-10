import { Readable } from 'node:stream';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
	UserRole,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { HandlerRegistry, type MediaServiceHandler } from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/** One poster, served by something that is not a media server. */
const POSTER = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * Only the two members this route reaches, cast rather than implemented.
 *
 * A full handler is eighty lines of methods throwing "not part of this test", and what
 * is under test here is the revalidation rather than the handler contract — which has
 * its own suite. Registering the real Jellyfin handler instead would make this depend
 * on a container being up.
 */
const poster = {
	type: MediaServiceType.JELLYFIN,
	fetched: 0,
	openArtwork() {
		poster.fetched += 1;

		return Promise.resolve({
			stream: Readable.from([POSTER]),
			contentLength: POSTER.length,
			totalLength: POSTER.length,
			acceptsRanges: false,
			contentType: 'image/png',
		});
	},
};

/**
 * What a browser is told about a poster it already has.
 *
 * `max-age` alone could not answer this. It buys an hour of silence and then expires,
 * and a reload asks again regardless — so every reload of the library re-sent the whole
 * wall, twenty megabytes over about thirty requests on the owner's catalogue, on the one
 * HTTP/2 connection the event stream and every other call share.
 *
 * Functional rather than a unit test on purpose: the header has to survive the
 * interceptor and the streaming response, and a controller tested in isolation would
 * pass while the shipped route sent no validator at all.
 */
describe('Revalidating a poster', () => {
	let context: TestApp;
	let reader: TestIdentity;
	let real: MediaServiceHandler;
	let itemId: string;

	beforeAll(async () => {
		context = await createTestApp();
		reader = await signInAs(context, UserRole.USER);

		const registry = context.app.get(HandlerRegistry);

		real = registry.get(MediaServiceType.JELLYFIN);
		registry.register(poster as unknown as MediaServiceHandler);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		const service = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:21',
				status: MediaServiceStatus.ONLINE,
			}),
		);

		const library = await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				paths: ['/media/shows'],
			}),
		);

		itemId = (
			await items.save(
				items.create({
					serviceId: service.id,
					libraryId: library.id,
					externalId: 'series-1',
					kind: MediaKind.SERIES,
					title: 'Big Buck Bunny',
					normalizedTitle: 'big buck bunny',
					artworkUrl: '/Items/series-1/Images/Primary',
					syncState: SyncState.LOCAL_ONLY,
				}),
			)
		).id;
	});

	afterAll(async () => {
		// Put the real one back: the registry is the running application's, and a fake
		// left in it would quietly answer for every test added after this file.
		context.app.get(HandlerRegistry).register(real);
		await context.close();
	});

	const poster_ = (tag?: string): request.Test => {
		const call = request(context.app.getHttpServer())
			.get(`/api/media/${itemId}/artwork`)
			.set('Authorization', `Bearer ${reader.token}`);

		return tag === undefined ? call : call.set('If-None-Match', tag);
	};

	it('sends the bytes with a tag the browser can come back with', async () => {
		const response = await poster_().expect(200);

		expect(response.headers.etag).toMatch(/^"[-0-9a-f]+-\d+"$/);
		expect(response.headers['cache-control']).toBe('private, max-age=3600');
		expect(response.body).toEqual(POSTER);
	});

	it('answers a reload with no body at all', async () => {
		const tag = (await poster_().expect(200)).headers.etag as string;
		const fetched = poster.fetched;

		const response = await poster_(tag).expect(304);

		expect(response.body).toEqual({});
		// And the poster was never read: the tag is the row's, answered before the bytes
		// are produced, which is the whole saving.
		expect(poster.fetched).toBe(fetched);
	});

	it('takes a cache that offers whatever it has', async () => {
		await poster_('*').expect(304);
	});

	/*
	 * Pinned as a value rather than by changing the row, because the stamp's resolution
	 * is the database's: SQLite writes `@UpdateDateColumn` with `CURRENT_TIMESTAMP`,
	 * which moves once a second, and a test that wrote twice inside one second would
	 * fail for a reason that has nothing to do with this route. What has to be true is
	 * that the tag *is* the row's stamp — so a rescan that moves it invalidates the
	 * poster, and nothing else does.
	 */
	it('names the row and the moment it last changed, which is what a rescan moves', async () => {
		const items = context.app.get(MediaItemRepository);
		const row = await items.findOneOrFail({ where: { id: itemId } });

		const tag = (await poster_().expect(200)).headers.etag as string;

		expect(tag).toBe(`"${row.id}-${row.updatedAt.getTime()}"`);
	});

	it('does not answer 304 for a tag it never issued', async () => {
		await poster_('"not-one-of-ours"').expect(200);
	});
});
