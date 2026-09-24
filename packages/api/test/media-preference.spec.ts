import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	ReleasePreferenceDimension,
	SyncState,
	UserRole,
	type MediaNode,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * A media's own search order, written and cancelled over HTTP.
 *
 * This is a functional test and not a unit one for a single reason: the shape being
 * validated is **nested**, and whether the validation pipe reaches into it is a property
 * of the application's wiring rather than of any manager. `whitelist` and
 * `forbidNonWhitelisted` are configured once in `bootstrap.ts`; a DTO that declares a
 * nested class without `@ValidateNested()` compiles, passes every unit test, and lets an
 * arbitrary object through into a settings blob that something else will later read as a
 * preference. A manager test cannot see any of that.
 *
 * The other half is the distinction the whole feature turns on and which is the easiest
 * thing here to validate away by accident: **absent and empty are two different
 * sentences.** No key says "I have no opinion, use the order above"; an empty one says
 * "here, order by nothing" — which is how one series opts out of a household order that
 * is wrong for it. A validator with an `ArrayMinSize` anywhere in it makes that second
 * sentence unsayable, and the only way left to say it would be to list every value in the
 * order they already arrive in.
 */

const order = (dimension: ReleasePreferenceDimension, values: string[]): unknown => ({
	ranks: [{ dimension, values }],
});

describe('a media’s own search order', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let itemId: string;

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		const service = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				baseUrl: 'http://jellyfin.invalid:8096',
				status: MediaServiceStatus.ONLINE,
				priority: 10,
			}),
		);
		const library = await libraries.save(
			libraries.create({
				serviceId: service.id,
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				externalId: 'shows',
				paths: ['/media/shows'],
				localPath: '/srv/shows',
			}),
		);
		const show = await items.save(
			items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: 'spartacus',
				kind: MediaKind.SERIES,
				title: 'Spartacus',
				normalizedTitle: 'spartacus',
				syncState: SyncState.LOCAL_ONLY,
			}),
		);

		itemId = show.id;
	});

	afterAll(async () => {
		await context.close();
	});

	const put = (body: unknown): request.Test =>
		request(context.app.getHttpServer())
			.put(`/api/media/${itemId}/override`)
			.set('Authorization', `Bearer ${admin.token}`)
			.send(body as object);

	const read = async (): Promise<MediaNode> => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${itemId}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return response.body as MediaNode;
	};

	it('keeps an order somebody wrote, dimensions and values in the order given', async () => {
		await put({
			releasePreference: {
				ranks: [
					{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p', '2160p'] },
					{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
				],
			},
		}).expect(200);

		const item = await read();

		// Both orders survive the round trip: the values inside a dimension, and the
		// dimensions against each other. The second is the one a JSON column could quietly
		// lose, and preferring 1080p then x265 is a different answer from preferring x265
		// first — which is the whole reason this is a list and not a set of fields.
		expect(item.overrides?.releasePreference?.ranks).toEqual([
			{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p', '2160p'] },
			{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
		]);
	});

	it('accepts an order that separates nothing, because that is a sentence too', async () => {
		// "Order by nothing" — how one series opts out of a household order. Refused, the
		// only way to say it would be to list every value in the order they arrive in.
		await put({ releasePreference: { ranks: [] } }).expect(200);
		expect(await read().then((item) => item.overrides?.releasePreference)).toEqual({ ranks: [] });

		await put({
			releasePreference: order(ReleasePreferenceDimension.TEAM, []),
		}).expect(200);
		expect(await read().then((item) => item.overrides?.releasePreference?.ranks[0]?.values))
			.toEqual([]);
	});

	it('cancels it on null, and leaves no trace of a correction nobody made', async () => {
		await put({ releasePreference: order(ReleasePreferenceDimension.CODEC, ['x265']) })
			.expect(200);
		await put({ releasePreference: null }).expect(200);

		const item = await read();

		/*
		 * The key is **gone**, not stored as null. `resolveReleasePreference` picks a level
		 * on presence, so a stored null resolves exactly like an absent key while still
		 * counting as a correction: the media would read as corrected for ever, the dialog
		 * would offer to restore something nobody wrote, and every rescan would re-apply an
		 * instruction that says nothing.
		 */
		expect(item.overrides?.releasePreference).toBeUndefined();
	});

	describe('what the pipe refuses', () => {
		it('refuses a dimension this build has never heard of', async () => {
			await put({ releasePreference: { ranks: [{ dimension: 'vibes', values: ['good'] }] } })
				.expect(400);
		});

		it('refuses the same dimension twice, which would make the order unreadable', async () => {
			await put({
				releasePreference: {
					ranks: [
						{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
						{ dimension: ReleasePreferenceDimension.CODEC, values: ['x264'] },
					],
				},
			}).expect(400);
		});

		it('refuses values that are not strings', async () => {
			await put({
				releasePreference: {
					ranks: [{ dimension: ReleasePreferenceDimension.RESOLUTION, values: [1080] }],
				},
			}).expect(400);
		});

		/*
		 * The assertion that proves the pipe reaches inside.
		 *
		 * An undeclared key on a *nested* object is the one case where the two plausible
		 * wirings differ: without `@ValidateNested()` and a `@Type()`, the subtree is an
		 * untyped blob, this passes with a 200, and `weight` is written into the database
		 * to be read one day by something that has no idea it is there.
		 */
		it('refuses a key the shape does not have, however deep it is', async () => {
			await put({
				releasePreference: {
					ranks: [
						{
							dimension: ReleasePreferenceDimension.RESOLUTION,
							values: ['1080p'],
							weight: 3,
						},
					],
				},
			}).expect(400);
		});

		it('refuses a preference that is not an object at all', async () => {
			await put({ releasePreference: '1080p' }).expect(400);
		});

		it('leaves the stored order alone when it refuses', async () => {
			await put({ releasePreference: order(ReleasePreferenceDimension.CODEC, ['x265']) })
				.expect(200);
			await put({ releasePreference: { ranks: [{ dimension: 'vibes', values: [] }] } })
				.expect(400);

			// A refusal that had written half of itself first would be worse than either
			// answer: the screen says it failed and the gateway searches by something else.
			expect(await read().then((item) => item.overrides?.releasePreference?.ranks)).toEqual([
				{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
			]);
		});
	});
});
