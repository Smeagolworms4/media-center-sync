import { expect, test } from '@playwright/test';
import { ADMIN, API_URL, apiToken } from './helpers';

/**
 * Where a file for a show we already hold would be filed.
 *
 * The rule the settings screen calls unconditional — *a series you already have keeps
 * its own folder* — and the one this gateway got wrong four times running. Three of
 * those repairs were to the placement itself and changed nothing anybody could see,
 * because the screen a person reads while a download runs is a *prediction* that called
 * the same chain without the input the rule reads. It answered the default library for
 * hours and the placement then quietly did something else.
 *
 * Every one of those rounds passed the unit tests. They passed because the fakes said
 * what the code expected; nothing ran the rule against a real catalogue produced by a
 * real media server. So this asks the gateway, over its own API, about a show a real
 * Jellyfin really scanned — which is the only arrangement in which the question and the
 * answer come from different places.
 *
 * No download: the endpoint exists to answer before anything is fetched, which is the
 * screen that was wrong.
 */
test.describe('placement', () => {
	test('files a show we already hold back into its own folder', async ({ request }) => {
		const headers = { Authorization: `Bearer ${await apiToken(request, ADMIN)}` };

		const groups = (await (await request.get(
			`${API_URL}/media/groups?search=Big Buck Bunny&limit=20`,
			{ headers },
		)).json()) as { items: { id: string; title: string; kind: string }[] };

		const show = groups.items.find(one => one.kind === 'series' || one.kind === 'episode');

		expect(show, 'the dataset should hold Big Buck Bunny').toBeTruthy();

		/*
		 * Where this gateway really reaches the show's files, as the group reports it.
		 *
		 * Taken from the catalogue rather than written here, which is what makes the
		 * assertion worth anything: a template builds `Big Buck Bunny/Season 01` under
		 * whatever root it is given, so comparing against the show's name would pass under
		 * the default library just as happily as under the show's own. The directory the
		 * media server reported is the only thing the two answers disagree about.
		 */
		const group = (await (await request.get(
			`${API_URL}/media/groups/${show?.id}`,
			{ headers },
		)).json()) as { sources: { local: boolean; localPath: string | null }[] };

		const held = group.sources.find(one => one.local && one.localPath);

		expect(held?.localPath, 'the dataset should be reachable on disk').toBeTruthy();

		const planned = (await (await request.get(
			`${API_URL}/releases/placement/${show?.id}`,
			{ headers },
		)).json()) as { folder: string | null };

		expect(planned.folder, 'the gateway should answer a folder at all').toBeTruthy();

		// The show's own directory, not a folder of the same name under another root.
		// Split rather than matched: a path is segments, and a pattern that has to decide
		// where a name ends and an extension begins is a pattern that can be made to work
		// hard for nothing.
		const segments = (held?.localPath as string).split('/');

		segments.pop();

		const home = segments.join('/');

		expect(planned.folder).toContain(home);
	});
});
