import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	IndexerType,
	MediaServiceType,
	SyncState,
	UserRole,
} from '@mcs/shared';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { SettingsService } from '@/services';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * What the gateway actually asks a tracker for, over HTTP, as a browser asks it.
 *
 * Here rather than on the manager because the defect was neither in the manager nor in
 * the words it builds — both were right. `?seasonPack=false` is the five characters
 * `false`, the DTO converted it with `Boolean('false')`, and the route was handed **true**:
 * every search for one episode arrived asking for the whole season, dropped the
 * coordinate — a pack names no episode — and sent `Futurama S11E10` out as `Futurama S11`.
 *
 * Measured on the owner's gateway before the fix, with the episode and the season both
 * stated on every call:
 *
 * | sent                | asked for         |
 * |---------------------|-------------------|
 * | `seasonPack` absent | `Futurama S11E10` |
 * | `seasonPack=false`  | `Futurama S11`    |
 * | `seasonPack=0`      | `Futurama S11`    |
 * | `seasonPack=true`   | `Futurama S11`    |
 *
 * Every spelling of no arriving as yes, and the interface sends the flag on every search
 * for a show — so this was every episode search this product has ever run. Nothing
 * failed and nothing logged, which is why it lasted: the screen showed a search that had
 * plainly been performed, against three hundred rows for the wrong episode.
 *
 * The answer's `query` field is what is asserted because it is the one thing that cannot
 * drift from what was sent — `searchTerms` spells it once, for the indexer and for this
 * line. No indexer is configured here, so the search finds nothing, which is beside the
 * point: what it was asked is already decided by then.
 */
describe('What a release search asks for', () => {
	let context: TestApp;
	let reader: TestIdentity;
	let episodeId: string;

	beforeAll(async () => {
		context = await createTestApp();
		reader = await signInAs(context, UserRole.USER);

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

		const series = await items.save(
			items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: 'series-1',
				kind: MediaKind.SERIES,
				title: 'Futurama',
				normalizedTitle: 'futurama',
				syncState: SyncState.LOCAL_ONLY,
			}),
		);

		const episode = await items.save(
			items.create({
				serviceId: service.id,
				libraryId: library.id,
				externalId: 'episode-10',
				parentId: series.id,
				kind: MediaKind.EPISODE,
				title: 'The Last Conclusion',
				normalizedTitle: 'futurama the last conclusion',
				seasonNumber: 11,
				episodeNumber: 10,
				syncState: SyncState.MISSING,
			}),
		);

		episodeId = episode.id;

		/*
		 * An indexer that exists and answers nothing, pointed at a closed port.
		 *
		 * Configured because the route refuses outright without one, and no more than
		 * that because what it finds is not the question: the words are decided before a
		 * request leaves this process, and they are what the answer reports back.
		 */
		await context.app.get(SettingsService).update({
			indexer: {
				type: IndexerType.PROWLARR,
				baseUrl: 'http://127.0.0.1:21',
				apiKey: 'not-a-real-key',
				enabled: true,
			},
		});
	});

	afterAll(async () => {
		await context.close();
	});

	const asked = async (query: string): Promise<string> => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/releases/search?itemId=${episodeId}&kind=show${query}`)
			.set('Authorization', `Bearer ${reader.token}`)
			.expect(200);

		return (response.body as { query: string }).query;
	};

	it('names the episode when the season pack was refused', async () => {
		await expect(asked('&seasonPack=false')).resolves.toBe('Futurama S11E10');
	});

	it('names the episode when the whole-season box was never mentioned', async () => {
		await expect(asked('')).resolves.toBe('Futurama S11E10');
	});

	it.each(['0', 'false'])('reads ?seasonPack=%s as a refusal, not as a yes', async (sent) => {
		await expect(asked(`&seasonPack=${sent}`)).resolves.toBe('Futurama S11E10');
	});

	it('asks for the season, and names no episode, when somebody did tick the box', async () => {
		// The other half, and the reason the flag exists: a pack is a season and names no
		// episode. Asking for `S11E10` would come back with one file.
		await expect(asked('&seasonPack=true')).resolves.toBe('Futurama S11');
	});
});
