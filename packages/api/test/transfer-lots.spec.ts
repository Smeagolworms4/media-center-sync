import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import {
	LibraryKind,
	MediaKind,
	MediaServiceType,
	TransferState,
	UserRole,
	type ResultList,
	type TransferLot,
} from '@mcs/shared';
import {
	LibraryRepository,
	MediaItemRepository,
	MediaServiceRepository,
	TransferRepository,
} from '@/repositories';
import { createTestApp, signInAs, type TestApp, type TestIdentity } from './utils/app-factory';

/**
 * The queue read as downloads rather than as files.
 *
 * The complaint this exists for, in the owner's words: "a single transfer with files inside,
 * that was my request" and "there it gets cut across several pages, which makes no sense if
 * it is one download". A page of twenty *files* cut a season of twenty-two into two blocks on
 * two pages — two percentages to add up, two sets of buttons to press, and a queue of nine
 * downloads announcing a hundred and eighty-seven rows.
 *
 * Its own file rather than a case in `transfer.spec.ts`: that one asserts the queue counters
 * against every row it seeds, and a season of twenty-two would move all of them.
 */
describe('The queue as downloads', () => {
	let context: TestApp;
	let manager: TestIdentity;
	let seasonKey: string;
	let filmKey: string;
	let doneId: string;
	/**
	 * A directory that really exists and really is writable.
	 *
	 * The renaming probes the disk rather than trusting the row — a library whose path is not
	 * there is refused, and rightly — so a made-up path would fail for the right reason and
	 * prove nothing about the route.
	 */
	let root: string;

	beforeAll(async () => {
		context = await createTestApp();
		manager = await signInAs(context, UserRole.ADMIN);

		const transfers = context.app.get(TransferRepository);
		const items = context.app.get(MediaItemRepository);
		const services = context.app.get(MediaServiceRepository);
		const libraries = context.app.get(LibraryRepository);

		root = mkdtempSync(join(tmpdir(), 'mcs-lots-'));

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
				externalId: 'shows',
				name: 'Shows',
				kind: LibraryKind.SHOWS,
				localPath: root,
				writable: true,
			}),
		);

		const item = async (
			kind: MediaKind,
			title: string,
			parentId: string | null,
			seasonNumber: number | null = null,
			episodeNumber: number | null = null,
		): Promise<string> => (
			await items.save(
				items.create({
					id: randomUUID(),
					serviceId: service.id,
					libraryId: library.id,
					externalId: randomUUID(),
					kind,
					title,
					normalizedTitle: title.toLowerCase(),
					parentId,
					seasonNumber,
					episodeNumber,
				}),
			)
		).id;

		/*
		 * A show with two seasons, because one season would not show that the card heads
		 * itself with the show: the deepest thing every file shares would be the season, and
		 * "Season 1" over a download of Les Schtroumpfs says less than the show does.
		 */
		const series = await item(MediaKind.SERIES, 'Les Schtroumpfs', null);
		const first = await item(MediaKind.SEASON, 'Saison 1', series, 1);
		const second = await item(MediaKind.SEASON, 'Saison 2', series, 2);

		const file = async (
			itemId: string,
			title: string,
			state: TransferState,
			lot: string | null,
			jobId: string | null = null,
			targetPath = join(root, `${title}.mkv`),
		): Promise<string> => {
			const id = randomUUID();

			/*
			 * A file that has landed really exists on disk, because renaming one moves its
			 * bytes: the whole point of the feature is that it applies to what is already
			 * filed, and a fixture of rows alone would assert the easy half.
			 */
			if (state === TransferState.DONE) {
				await mkdir(dirname(targetPath), { recursive: true });
				await writeFile(targetPath, 'x'.repeat(1_000));
			}

			await transfers.save(
				transfers.create({
					id,
					itemId,
					title,
					state,
					lot,
					jobId,
					targetPath,
					targetLibraryId: library.id,
					workPath: `/var/transfer/${id}.part`,
					bytesTotal: 1_000,
					bytesDone: state === TransferState.DONE ? 1_000 : 250,
					chunkSize: 1_000,
					chunksTotal: 1,
				}),
			);

			return id;
		};

		const film = await item(MediaKind.MOVIE, 'Le Cinquième Élément', null);

		filmKey = randomUUID();
		await file(film, 'Le Cinquième Élément', TransferState.QUEUED, filmKey, null);

		seasonKey = randomUUID();

		// Twenty-two files, which is more than a page of files holds: the whole point is that
		// the download is not cut by that boundary any more.
		for (let episode = 1; episode <= 12; episode += 1) {
			const itemId = await item(MediaKind.EPISODE, `S01E${episode}`, first, 1, episode);

			await file(
				itemId,
				`Les Schtroumpfs — S01E${episode}`,
				episode === 1 ? TransferState.DONE : TransferState.QUEUED,
				seasonKey,
				// Three nights, one download: a season pulled over several runs is one season,
				// which is why the run may not be what groups them.
				episode <= 4 ? 'run-1' : 'run-2',
				join(root, 'Les Schtroumpfs', 'Season 01', `S01E${episode}.mkv`),
			);
		}

		doneId = (await transfers.find({ where: { lot: seasonKey, state: TransferState.DONE } }))[0].id;

		for (let episode = 1; episode <= 10; episode += 1) {
			const itemId = await item(MediaKind.EPISODE, `S02E${episode}`, second, 2, episode);

			await file(
				itemId,
				`Les Schtroumpfs — S02E${episode}`,
				TransferState.QUEUED,
				seasonKey,
				'run-2',
				join(root, 'Les Schtroumpfs', 'Season 02', `S02E${episode}.mkv`),
			);
		}

	});

	afterAll(async () => {
		await context.close();
	});

	const lots = async (query = ''): Promise<ResultList<TransferLot>> => (
		await request(context.app.getHttpServer())
			.get(`/api/transfers/lots${query}`)
			.set('Authorization', `Bearer ${manager.token}`)
			.expect(200)
	).body;

	it('answers one download carrying every one of its files, page size notwithstanding', async () => {
		/*
		 * The regression in one assertion. `limit=1` is a page of one *download*, and that
		 * download is twenty-two files: the old route answered one file, so the card drew a
		 * season as `1 file`, one twenty-second of a percentage, and a pause button that
		 * stopped one episode — with the rest of it on other pages.
		 *
		 * Which of the two downloads lands on which page is not asserted: both are live and
		 * both were created in the same millisecond, so they tie on the sort and the tie
		 * breaks however the engine feels. What matters is that neither page holds a piece of
		 * one.
		 */
		const first = await lots('?limit=1');
		const second = await lots('?limit=1&page=2');

		expect(first.items).toHaveLength(1);
		expect(second.items).toHaveLength(1);

		const pages = [...first.items, ...second.items];
		const season = pages.find(one => one.key === seasonKey);

		expect(season?.transfers).toHaveLength(22);
		expect(pages.find(one => one.key === filmKey)?.transfers).toHaveLength(1);
	});

	it('counts downloads and not rows, so the pagination stops lying about its size', async () => {
		// Twenty-three files, two downloads. The screen said `187` for nine.
		const page = await lots();

		expect(page.pagination.total).toBe(2);
		expect(page.items.map(one => one.transfers.length).sort()).toEqual([1, 22]);
	});

	it('heads a download with the show rather than with its first episode', async () => {
		const page = await lots();
		const season = page.items.find(one => one.key === seasonKey);
		const film = page.items.find(one => one.key === filmKey);

		expect(season?.title).toBe('Les Schtroumpfs');
		// A download of one thing keeps that thing's own name: there is no show above it.
		expect(film?.title).toBe('Le Cinquième Élément');
	});

	it('keeps the show as the title when one file\'s media has gone from the catalogue',
		async () => {
			/*
			 * Seen on the owner's queue: a download of a hundred and four files titled "Les
			 * Schtroumpfs — S01E10 — Episode 10". One row dropped by a scan had no ancestry
			 * left, counting it as a chain of its own title shared nothing with the rest, the
			 * common ancestor collapsed, and the card took the name of whichever episode came
			 * back first.
			 *
			 * Built as a lot of its own rather than by deleting a row the other tests rely
			 * on: a fixture that destroys itself half-way through a file is a suite whose
			 * failures depend on the order it happens to run in.
			 */
			const transfers = context.app.get(TransferRepository);
			const known = (await transfers.findByLotKeys([seasonKey]))[0];
			const key = randomUUID();

			for (const [index, itemId] of [known.itemId, randomUUID()].entries()) {
				await transfers.save(
					transfers.create({
						id: randomUUID(),
						itemId,
						title: `Les Schtroumpfs — S01E0${index + 1} — Episode ${index + 1}`,
						state: TransferState.QUEUED,
						lot: key,
						jobId: null,
						targetPath: join(root, 'Les Schtroumpfs', 'Season 01', `orphan-${index}.mkv`),
						targetLibraryId: known.targetLibraryId,
						workPath: `/var/transfer/orphan-${index}.part`,
						bytesTotal: 1_000,
						bytesDone: 0,
						chunkSize: 1_000,
						chunksTotal: 1,
					}),
				);
			}

			const answer = await request(context.app.getHttpServer())
				.get(`/api/transfers/lots/${key}`)
				.set('Authorization', `Bearer ${manager.token}`)
				.expect(200);

			expect(answer.body.title).toBe('Les Schtroumpfs');
		});

	it('carries the season and the episode of each file, off the catalogue', async () => {
		// What the card groups by. Parsed out of the title it would put a show whose episodes
		// are named differently into one heap and blame the household's files.
		const page = await lots();
		const season = page.items.find(one => one.key === seasonKey);
		const numbers = new Set(season?.transfers.map(one => one.seasonNumber));

		expect(numbers).toEqual(new Set([1, 2]));
		expect(season?.transfers.every(one => one.episodeNumber !== null)).toBe(true);
	});

	it('keeps every file of a download even when the filter chose it for one of them', async () => {
		/*
		 * The filter picks which downloads appear and never which of their files do. A live
		 * view showing a season minus the episode that already landed would report `21 files`
		 * for a season of twenty-two, against a percentage computed on the wrong total.
		 */
		const page = await lots('?state=done');

		expect(page.items).toHaveLength(1);
		expect(page.items[0].transfers).toHaveLength(22);
	});

	it('pauses a whole download in one request, skipping the files it cannot', async () => {
		/*
		 * The card used to emit one action per file and the page answered with one request
		 * each: twenty requests racing each other and the engine, so pausing a season came
		 * back as a column of `409`s about the files that had finished in between. The file
		 * that is done is skipped rather than refused — pressing pause on a season that is
		 * half done means "stop the rest".
		 */
		const answer = await request(context.app.getHttpServer())
			.post(`/api/transfers/lots/${seasonKey}/pause`)
			.set('Authorization', `Bearer ${manager.token}`)
			.expect(200);
		const paused = (answer.body as TransferLot).transfers;

		expect(paused).toHaveLength(22);
		expect(paused.filter(one => one.state === TransferState.PAUSED)).toHaveLength(21);
		expect(paused.find(one => one.id === doneId)?.state).toBe(TransferState.DONE);
	});

	describe('renaming', () => {
		/*
		 * Asked for in these words: "on the season part one can rename the season folder's
		 * name only", and "renaming applies afterwards too — really moving what is already
		 * filed". Both halves are asserted, because a rename that only changed where the rest
		 * would go would leave one season in two folders.
		 */
		it('renames the folder of one season, and of that season alone', async () => {
			const answer = await request(context.app.getHttpServer())
				.post(`/api/transfers/lots/${seasonKey}/rename-season`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ seasonNumber: 1, name: 'Saison 1' })
				.expect(200);
			const renamed = (answer.body as TransferLot).transfers;
			const first = renamed.filter(one => one.seasonNumber === 1);
			const second = renamed.filter(one => one.seasonNumber === 2);

			expect(first.every(one => one.targetPath.includes('/Saison 1/'))).toBe(true);

			/*
			 * And the bytes with them. This is the half that cannot be faked: the episode that
			 * had already landed is on the disk, and a rename that only rewrote rows would
			 * leave it in `Season 01` while everything still coming went to `Saison 1`.
			 */
			const landed = first.find(one => one.id === doneId);

			await expect(access(landed?.targetPath as string)).resolves.toBeUndefined();
			await expect(access(join(root, 'Les Schtroumpfs', 'Season 01'))).rejects.toThrow();
			// The other season is untouched, and so is the show's folder above both.
			expect(second.every(one => one.targetPath.includes('/Season 02/'))).toBe(true);
			expect(renamed.every(one => one.targetPath.includes('/Les Schtroumpfs/'))).toBe(true);
		});

		it('refuses a name that is a path, rather than creating folders nobody asked for',
			async () => {
				const answer = await request(context.app.getHttpServer())
					.post(`/api/transfers/lots/${seasonKey}/rename-season`)
					.set('Authorization', `Bearer ${manager.token}`)
					.send({ seasonNumber: 2, name: 'Saison 2/VF' })
					.expect(400);

				expect(answer.body.message).toBe('error.transfer.invalid_name');
			});

		it('renames one file and keeps it in its folder, extension included', async () => {
			const page = await lots();
			const target = page.items
				.find(one => one.key === seasonKey)
				?.transfers.find(one => one.seasonNumber === 2) as { id: string; targetPath: string };

			const answer = await request(context.app.getHttpServer())
				.post(`/api/transfers/${target.id}/rename`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ name: 'Les Schtroumpfs - 2x01' })
				.expect(200);

			// The extension is kept although the new name carries none: a file a media server
			// cannot recognise is intact, invisible, and reports no fault.
			expect(answer.body.targetPath)
				.toBe(join(root, 'Les Schtroumpfs', 'Season 02', 'Les Schtroumpfs - 2x01.mkv'));
		});

		it('refuses to rename a file that is in no library', async () => {
			/*
			 * The landing record is written against a library, and inventing one would tell a
			 * media server to scan a folder it has never heard of. Explicit rather than a
			 * failure further down, and actionable where it is raised: sending the file to a
			 * library first is a button away.
			 */
			const transfers = context.app.get(TransferRepository);
			const row = (await transfers.find({ where: { lot: filmKey } }))[0];

			row.targetLibraryId = null;
			await transfers.save(row);

			const answer = await request(context.app.getHttpServer())
				.post(`/api/transfers/${row.id}/rename`)
				.set('Authorization', `Bearer ${manager.token}`)
				.send({ name: 'Le Cinquieme Element.mkv' })
				.expect(409);

			expect(answer.body.message).toBe('error.transfer.destination_invalid');
		});
	});

	it('refuses a download nobody has', async () => {
		await request(context.app.getHttpServer())
			.get(`/api/transfers/lots/${randomUUID()}`)
			.set('Authorization', `Bearer ${manager.token}`)
			.expect(404);
	});
});
