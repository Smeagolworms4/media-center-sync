import request from 'supertest';
import {
	LibraryHintKind,
	LibraryKind,
	LibraryLayoutSignal,
	MediaKind,
	MediaServiceType,
	SyncState,
	UserRole,
	type LibraryHint,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * The two lines that explain a library nothing else explains, over HTTP.
 *
 * Tested through the route rather than only through the manager because of one thing a
 * unit test cannot see: `GET /libraries/:id` would swallow `/libraries/hints` if it
 * were declared first, and the failure is a `400` about a malformed UUID that says
 * nothing about route order. The rest is the behaviour the owner asked for — a
 * suspicion he can dismiss for good, and a line about mounts that goes on its own.
 */
describe('Library hints', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let guest: TestIdentity;
	let seriesId: string;

	const hints = async (identity: TestIdentity = admin): Promise<LibraryHint[]> => {
		const response = await request(context.app.getHttpServer())
			.get('/api/libraries/hints')
			.set('Authorization', `Bearer ${identity.token}`)
			.expect(200);

		return response.body as LibraryHint[];
	};

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		guest = await signInAs(context, UserRole.GUEST);

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		// Mounted, so the gateway-wide line is silent and the suspicion is the only thing
		// the route can be answering with.
		const service = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:41',
			}),
		);
		const library = await libraries.save(
			libraries.create({
				serviceId: service.id,
				externalId: 'lib-shows',
				name: 'Series TV',
				kind: LibraryKind.SHOWS,
				paths: ['/media/SeriesTV'],
			}),
		);

		const put = async (
			externalId: string,
			kind: MediaKind,
			title: string,
			parentId: string | null,
		): Promise<string> => {
			const saved = await items.save(
				items.create({
					serviceId: service.id,
					libraryId: library.id,
					externalId,
					kind,
					parentId,
					title,
					normalizedTitle: title.toLowerCase(),
					externalIds: {},
					syncState: SyncState.UNKNOWN,
					file: null,
				}),
			);

			return saved.id;
		};

		// The owner's Marvel folder, as Jellyfin reported it: numbered seasons for what it
		// could number, and the show folders' own names for the rest.
		seriesId = await put('folder', MediaKind.SERIES, 'Marvel Comics', null);

		for (const name of ['Saison 1', 'Saison 2', 'Agent Carter', 'Agents of SHIELD']) {
			await put(`season-${name}`, MediaKind.SEASON, name, seriesId);
		}
	});

	afterAll(async () => {
		await context.close();
	});

	it('answers the suspicion on its own route rather than through the one for an item', async () => {
		const [hint] = await hints();

		expect(hint).toMatchObject({
			key: `misread-folder:${seriesId}`,
			kind: LibraryHintKind.MISREAD_FOLDER,
			itemId: seriesId,
			title: 'Marvel Comics',
			libraryName: 'Series TV',
			serviceName: 'Living room',
			signals: [LibraryLayoutSignal.NAMED_SEASONS],
			seasonCount: 4,
		});
		expect(hint.examples).toEqual(['Agent Carter', 'Agents of SHIELD']);
	});

	it('shows it to anybody who may read the library, because it explains what they see', async () => {
		expect(await hints(guest)).toHaveLength(1);
	});

	it('stops answering it once it has been dismissed, and starts again when undismissed', async () => {
		const dismiss = (keys: string[]) =>
			request(context.app.getHttpServer())
				.patch('/api/settings')
				.set('Authorization', `Bearer ${admin.token}`)
				.send({ dismissedLibraryHints: keys })
				.expect(200);

		await dismiss([`misread-folder:${seriesId}`]);

		expect(await hints()).toEqual([]);

		await dismiss([]);

		expect(await hints()).toHaveLength(1);
	});

	it('says in one line when no server has its folders declared', async () => {
		const services = context.app.get(MediaServiceRepository);
		const [service] = await services.find();

		await services.update({ id: service.id }, { filesMounted: false });

		const listed = await hints();

		// First, because it explains every row underneath it: told that a show looks odd
		// while nothing at all is mounted, somebody would go and investigate the show.
		expect(listed[0]).toMatchObject({
			key: 'nothing-mounted',
			kind: LibraryHintKind.NOTHING_MOUNTED,
			itemId: null,
		});

		await services.update({ id: service.id }, { filesMounted: true });

		expect((await hints()).some((one) => one.kind === LibraryHintKind.NOTHING_MOUNTED)).toBe(false);
	});
});
