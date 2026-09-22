import request from 'supertest';
import {
	LibraryKind,
	MatchStrategy,
	MediaKind,
	MediaServiceStatus,
	MediaServiceType,
	SyncState,
	UserRole,
	type MediaMatch,
} from '@mcs/shared';
import { MediaManager } from '@/managers';
import { LibraryRepository, MediaItemRepository, MediaServiceRepository } from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * A show published as one continuous run against the same show cut into seasons.
 *
 * Anime is routinely numbered straight through — episode 1 to 291 — while another
 * library files the same episodes as nine seasons, so `E153` here and `S06E12` there
 * looked like two different things and the gateway called missing what the owner
 * already owned. Two shows are seeded, both correlated through the real pass rather
 * than through seeded matches, because what changed is which rows correlation writes:
 *
 * - *Dragon Ball*, twenty-five episodes straight through here and two seasons of
 *   thirteen and twelve there. It must pair, and the pairing must read
 *   `absolute_episode` — somebody debugging a wrong pair has to see at a glance that
 *   arithmetic put it there rather than a server.
 * - *Cowboy Bebop*, the near miss: twenty-six episodes here against the same two
 *   seasons of twenty-five there. Nothing lines up end to end, so nothing may pair.
 *   One episode too many is exactly what a neighbouring cut of a show looks like, and
 *   a wrong merge files the wrong episode under a name for ever.
 */
describe('A series numbered straight through against one cut into seasons', () => {
	let context: TestApp;
	let admin: TestIdentity;
	const id: Record<string, string> = {};

	beforeAll(async () => {
		context = await createTestApp();
		admin = await signInAs(context, UserRole.ADMIN);

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

		const ourLibrary = await libraries.save(
			libraries.create({
				serviceId: ours.id,
				externalId: 'lib-ours',
				name: 'Animes',
				kind: LibraryKind.SHOWS,
				paths: ['/media/animes'],
			}),
		);
		const theirLibrary = await libraries.save(
			libraries.create({
				serviceId: theirs.id,
				externalId: 'lib-theirs',
				name: 'Animes',
				kind: LibraryKind.SHOWS,
				paths: ['/srv/animes'],
			}),
		);

		const put = async (
			key: string,
			local: boolean,
			values: {
				kind: MediaKind;
				title: string;
				parent?: string;
				year?: number | null;
				seasonNumber?: number | null;
				episodeNumber?: number | null;
			},
		): Promise<void> => {
			const saved = await items.save(
				items.create({
					serviceId: local ? ours.id : theirs.id,
					libraryId: local ? ourLibrary.id : theirLibrary.id,
					externalId: key,
					kind: values.kind,
					parentId: values.parent === undefined ? null : id[values.parent],
					title: values.title,
					normalizedTitle: values.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
					year: values.year ?? null,
					seasonNumber: values.seasonNumber ?? null,
					episodeNumber: values.episodeNumber ?? null,
					externalIds: {},
					syncState: SyncState.UNKNOWN,
					// No file, deliberately: a content identity would pair these rows on the
					// bytes and prove nothing about the numbering.
					file: null,
				}),
			);

			id[key] = saved.id;
		};

		/** One show straight through on our side, and cut into seasons on theirs. */
		const seed = async (show: string, title: string, run: number, lengths: number[]) => {
			await put(`${show}-run`, true, { kind: MediaKind.SERIES, title, year: 1998 });

			for (let episode = 1; episode <= run; episode += 1) {
				await put(`${show}-e${episode}`, true, {
					kind: MediaKind.EPISODE,
					parent: `${show}-run`,
					title: `Episode ${episode}`,
					seasonNumber: 1,
					episodeNumber: episode,
				});
			}

			await put(`${show}-cut`, false, { kind: MediaKind.SERIES, title, year: 1998 });

			for (const [index, length] of lengths.entries()) {
				const season = index + 1;

				await put(`${show}-s${season}`, false, {
					kind: MediaKind.SEASON,
					parent: `${show}-cut`,
					title: `Season ${season}`,
					seasonNumber: season,
				});

				for (let episode = 1; episode <= length; episode += 1) {
					await put(`${show}-s${season}e${episode}`, false, {
						kind: MediaKind.EPISODE,
						parent: `${show}-s${season}`,
						title: `Chapter ${season}.${episode}`,
						seasonNumber: season,
						episodeNumber: episode,
					});
				}
			}
		};

		await seed('ball', 'Dragon Ball', 25, [13, 12]);
		// One episode more than the seasons account for: a near miss, and the shape a
		// neighbouring cut of the same show has.
		await seed('bebop', 'Cowboy Bebop', 26, [13, 12]);

		await context.app.get(MediaManager).correlateService(ours.id);
	});

	afterAll(async () => {
		await context.close();
	});

	const matchesOf = async (key: string): Promise<MediaMatch[]> => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${id[key]}/matches`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		return response.body as MediaMatch[];
	};

	it('relates an absolute number to the season and episode it falls in', async () => {
		// Episode 14 is the first of season 2, which is the whole arithmetic: thirteen
		// episodes of season 1 came before it, as the other side is indexed.
		// Both halves of the pair are listed: an item is the near side of some rows and
		// the far side of others, and the page concerned shows both.
		const related = (await matchesOf('ball-e14')).map(
			(one) => (one.localItemId === id['ball-e14'] ? one.remoteItemId : one.localItemId),
		);

		expect(new Set(related)).toEqual(new Set([id['ball-s2e1']]));
		expect((await matchesOf('ball-e14')).every(
			(one) => one.strategy === MatchStrategy.ABSOLUTE_EPISODE,
		)).toBe(true);
	});

	it('relates the last episode of the run to the last of the last season', async () => {
		const related = (await matchesOf('ball-e25')).map(
			(one) => (one.localItemId === id['ball-e25'] ? one.remoteItemId : one.localItemId),
		);

		expect(new Set(related)).toEqual(new Set([id['ball-s2e12']]));
	});

	it('says arithmetic put the pair there, not a server', async () => {
		// The strategy is on the row precisely so a wrong pairing can be told apart from
		// one two servers agreed on. It is also above the default threshold, so it is
		// applied rather than merely proposed.
		const [match] = await matchesOf('ball-e14');

		expect(match.strategy).toBe(MatchStrategy.ABSOLUTE_EPISODE);
		expect(match.confidence).toBeGreaterThanOrEqual(0.8);
	});

	it('stops calling an episode missing once it is related under the other numbering', async () => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${id['ball-e14']}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		expect((response.body as { sync: SyncState }).sync).not.toBe(SyncState.MISSING);
	});

	it('pairs nothing at all when the two sides do not account for the same show', async () => {
		// The near miss. Twenty-six against twenty-five is one episode of disagreement,
		// and a conversion built on the wrong season lengths is wrong from the first
		// season boundary onwards — silently, and for ever.
		expect(await matchesOf('bebop-e14')).toEqual([]);
		expect(await matchesOf('bebop-e26')).toEqual([]);
	});

	it('leaves the near miss unrelated rather than guessing at the season lengths', async () => {
		const response = await request(context.app.getHttpServer())
			.get(`/api/media/${id['bebop-e14']}`)
			.set('Authorization', `Bearer ${admin.token}`)
			.expect(200);

		// Held here and correlated with nothing: the twenty-sixth episode the other side
		// does not account for is enough to refuse the whole show, and that is the trade
		// this feature was written to make.
		expect((response.body as { sync: SyncState }).sync).toBe(SyncState.LOCAL_ONLY);
	});
});
