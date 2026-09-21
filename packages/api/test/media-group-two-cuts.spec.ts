import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
	UserRole,
	type ExternalIds,
	type MediaFileInfo,
	type MediaGroup,
	type ResultList,
	type SyncPreview,
} from '@mcs/shared';
import { MediaManager } from '@/managers';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * The identifier decides the work; the running time decides the version.
 *
 * Three films, each held once here and once on a friend's server, and each testing one
 * side of that rule:
 *
 * - *Titanic*, theatrical here and extended there, sharing an IMDb number. It used to
 *   be two cards: correlation vetoed the pair on its running time before it read the
 *   identifier, so the `conflict` state built for exactly this could never be reached
 *   by a film. It must now be one card reading `conflict` — and the extended cut must
 *   still be something a sync fetches rather than something we are told we hold. The
 *   friend's library files it under another title, so the pair also proves the
 *   identifier can introduce two copies the title lookup would never have compared.
 * - *Arrival*, the same cut with a studio logo trimmed off one copy: one card, in an
 *   ordinary state, because twenty-five seconds is not another version.
 * - *The Thing*, two films sharing a title and a year and nothing else but a Plex row
 *   key — the key the owner's own database carried. Six minutes apart with nothing
 *   vouching for them, they may be two different films, and stay two cards.
 *
 * The rows go through the real `correlateService` rather than seeded matches, because
 * what changed is which rows correlation writes; a seeded match would pass either way.
 */
describe('Two cuts of one film', () => {
	let context: TestApp;
	let admin: TestIdentity;
	let destination: string;
	const id: Record<string, string> = {};

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);
		destination = await mkdtemp(join(tmpdir(), 'mcs-cuts-'));

		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);
		const items = context.app.get(MediaItemRepository);

		const ours = await services.save(
			services.create({
				name: 'Living room',
				type: MediaServiceType.JELLYFIN,
				filesMounted: true,
				baseUrl: 'http://127.0.0.1:8096',
				status: MediaServiceStatus.ONLINE,
				priority: 100,
			}),
		);
		const theirs = await services.save(
			services.create({
				name: 'Cabin',
				type: MediaServiceType.PLEX,
				filesMounted: false,
				baseUrl: 'http://127.0.0.1:32400',
				status: MediaServiceStatus.ONLINE,
				priority: 200,
			}),
		);

		// Ours has to be writable, or the preview below has nowhere to place a pull and
		// refuses before it ever decides what is held.
		const ourLibrary = await libraries.save(
			libraries.create({
				serviceId: ours.id,
				externalId: 'lib-ours',
				name: 'Films',
				kind: LibraryKind.MOVIES,
				paths: ['/media/movies'],
				localPath: destination,
				writable: true,
				isDefaultTarget: true,
			}),
		);
		const theirLibrary = await libraries.save(
			libraries.create({
				serviceId: theirs.id,
				externalId: 'lib-theirs',
				name: 'Films',
				kind: LibraryKind.MOVIES,
				paths: ['/srv/movies'],
			}),
		);

		const film = (path: string, durationMs: number, overrides: Partial<MediaFileInfo> = {}) => ({
			path,
			size: 4096,
			container: 'mkv',
			videoCodec: 'hevc',
			audioCodec: 'eac3',
			width: 1920,
			height: 1080,
			durationMs,
			bitrate: 8_000_000,
			quickHash: null,
			contentId: `v1:${path}`,
			checksum: null,
			edition: null,
			...overrides,
		});

		const put = async (
			key: string,
			local: boolean,
			title: string,
			year: number,
			externalIds: ExternalIds,
			file: MediaFileInfo,
		): Promise<void> => {
			const saved = await items.save(
				items.create({
					serviceId: local ? ours.id : theirs.id,
					libraryId: local ? ourLibrary.id : theirLibrary.id,
					externalId: key,
					kind: MediaKind.MOVIE,
					title,
					normalizedTitle: title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
					year,
					externalIds,
					syncState: SyncState.UNKNOWN,
					file,
				}),
			);

			id[key] = saved.id;
		};

		await put('titanic-ours', true, 'Titanic', 1997, { imdb: 'tt0120338', provider: 'jf-1' },
			film('/media/movies/Titanic (1997).mkv', 194 * 60_000));
		await put('titanic-theirs', false, 'Titanic Special Edition', 1997, { imdb: 'tt0120338', provider: '11' },
			film('/srv/movies/Titanic (1997) {edition-Extended}.mkv', 209 * 60_000, { height: 2160, width: 3840 }));

		await put('arrival-ours', true, 'Arrival', 2016, { tmdb: '329865', provider: 'jf-2' },
			film('/media/movies/Arrival (2016).mkv', 116 * 60_000));
		await put('arrival-theirs', false, 'Arrival', 2016, { tmdb: '329865', provider: '12' },
			film('/srv/movies/Arrival.2016.mkv', 116 * 60_000 - 25_000));

		await put('thing-ours', true, 'The Thing', 1982, { provider: '5' },
			film('/media/movies/The Thing (1982).mkv', 109 * 60_000));
		await put('thing-theirs', false, 'The Thing', 1982, { provider: '5' },
			film('/srv/movies/The Thing.mkv', 103 * 60_000));

		await context.app.get(MediaManager).correlateService(ours.id);
	});

	afterAll(async () => {
		await context.close();
		await rm(destination, { recursive: true, force: true });
	});

	const films = async (extra = ''): Promise<MediaGroup[]> => {
		const page = await request(context.app.getHttpServer())
			.get(`/api/media/groups?kind=movie&limit=50${extra}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return (page.body as ResultList<MediaGroup>).items;
	};

	const groupOf = (groups: MediaGroup[], key: string): MediaGroup | undefined =>
		groups.find((group) => group.sources.some((source) => source.itemId === id[key]));

	it('shows the two cuts as one group in conflict, where it used to show two', async () => {
		const groups = await films();
		const titanic = groupOf(groups, 'titanic-ours');

		expect(groupOf(groups, 'titanic-theirs')).toBe(titanic);
		expect(titanic?.sync).toBe(SyncState.CONFLICT);
		expect(titanic?.sources.map((source) => source.itemId).sort()).toEqual(
			[id['titanic-ours'], id['titanic-theirs']].sort(),
		);
		expect(titanic?.versions).toEqual([
			expect.objectContaining({ heldLocally: true }),
			expect.objectContaining({ heldLocally: false }),
		]);
	});

	it('says which cut is which on the correlation itself', async () => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${id['titanic-ours']}/matches`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		// Both directions are rows — the settling pass correlates the friend's copy back
		// — and each states the pair from its own side.
		expect(response.body).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					localItemId: id['titanic-ours'],
					state: SyncState.CONFLICT,
					reason: 'different cut (209 min there against 194 min here)',
				}),
				expect.objectContaining({
					localItemId: id['titanic-theirs'],
					state: SyncState.CONFLICT,
				}),
			]),
		);
	});

	it('shows a copy with a logo trimmed off as one group in an ordinary state', async () => {
		const groups = await films();
		const arrival = groupOf(groups, 'arrival-ours');

		expect(groupOf(groups, 'arrival-theirs')).toBe(arrival);
		expect(arrival?.sync).toBe(SyncState.IN_SYNC);
	});

	it('keeps two namesakes apart when only a server row key agrees', async () => {
		const groups = await films();

		expect(groupOf(groups, 'thing-ours')).not.toBe(groupOf(groups, 'thing-theirs'));
		expect(groups).toHaveLength(4);
	});

	it('does not hide the other cut behind "hide what I already have"', async () => {
		const groups = await films('&hideOwned=true');

		expect(groupOf(groups, 'titanic-theirs')).toBeDefined();
		expect(groupOf(groups, 'arrival-theirs')).toBeUndefined();
	});

	it('fetches the extended cut when asked for it, beside the theatrical one', async () => {
		const response = await request(context.app.getHttpServer())
			.post('/api/sync/preview')
			.set('Authorization', `Bearer ${admin.token}`)
			.send({ scope: { itemIds: [id['titanic-theirs']] } })
			.expect(200);
		const preview = response.body as SyncPreview;

		// `missing` is the planner saying nothing local holds this version. Had it counted
		// the theatrical copy as ours, the state would be the pair's `conflict` and the
		// run would have been told to skip it.
		expect(preview.items).toEqual([
			expect.objectContaining({ itemId: id['titanic-theirs'], state: SyncState.MISSING }),
		]);
		expect(preview.items[0].targetPath).not.toBe(join(destination, 'Titanic (1997).mkv'));
	});
});
