import { MediaKind, SyncState } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import NewReleases from '@/pages/NewReleases.vue';
import { mountWithApp, stubFetchRoutes, tooltipStub } from './helpers';

/** Let the mounted page finish its own fetches, as the other page suites do. */
async function settle (times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

/**
 * What has come out for the shows this household follows.
 *
 * Both halves of the rule are pinned here, because either one alone makes the screen
 * useless: an episode of something nobody follows is not news, and a followed show with
 * nothing new is not either. And what is held in a worse copy is kept out of the missing
 * list — asked for in those words, "if we have it but in a bad version, that is a version
 * upgrade".
 */

function episode (overrides: Record<string, unknown> = {}) {
	return {
		id: 'e1',
		kind: MediaKind.EPISODE,
		title: 'The Big Empty',
		seriesTitle: 'The Expanse',
		normalizedTitle: 'the expanse',
		year: null,
		seasonNumber: 1,
		episodeNumber: 2,
		externalIds: {},
		artworkItemId: null,
		sync: SyncState.MISSING,
		quality: null,
		sources: [],
		childCount: 0,
		missingCount: 0,
		versions: [],
		libraryId: 'l1',
		parentId: 's1',
		addedAt: '2026-09-28T00:00:00.000Z',
		...overrides,
	};
}

async function open (items: Record<string, unknown>[]) {
	const stub = stubFetchRoutes({
		'/api/media/groups': {
			body: { items, pagination: { page: 1, limit: 60, total: items.length, pages: 1 } },
		},
	});
	const { wrapper } = mountWithApp(NewReleases, { global: { stubs: tooltipStub } });

	await settle(2);

	return { wrapper, stub };
}

describe('pages/NewReleases', () => {
	it('asks only for aired episodes of what is watched, newest first', async () => {
		const { stub } = await open([]);
		const url = String(stub.mock.calls.find(one => String(one[0]).includes('/media/groups'))?.[0]);

		expect(url).toContain('kind=episode');
		// Either way of saying the household cares: a plan, or an ask on the request
		// source. Reading plans alone would leave this screen empty.
		expect(url).toContain('watched=true');
		expect(url).toContain('sort=addedAt');
		expect(url).toContain('direction=desc');
	});

	it('keeps what is missing apart from what is merely a worse copy', async () => {
		/*
		 * Two different decisions: one is something to fetch, the other something to
		 * replace. Mixed together, a file that plays tonight sits beside one that does not
		 * exist here at all.
		 */
		const { wrapper } = await open([
			episode({ id: 'gone', sync: SyncState.MISSING }),
			episode({ id: 'worse', sync: SyncState.OUTDATED }),
		]);

		const missing = wrapper.find('[data-test="news-missing"]');
		const upgrades = wrapper.find('[data-test="news-upgrades"]');

		expect(missing.exists()).toBe(true);
		expect(upgrades.exists()).toBe(true);
		expect(missing.findAll('[data-test="media-row"]')).toHaveLength(1);
		expect(upgrades.findAll('[data-test="media-row"]')).toHaveLength(1);
	});

	it('draws no upgrade section when there is nothing to upgrade', async () => {
		const { wrapper } = await open([episode()]);

		expect(wrapper.find('[data-test="news-missing"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="news-upgrades"]').exists()).toBe(false);
	});

	it('says nothing is new rather than drawing an empty frame', async () => {
		const { wrapper } = await open([]);

		expect(wrapper.find('[data-test="news-empty"]').exists()).toBe(true);
	});
});
