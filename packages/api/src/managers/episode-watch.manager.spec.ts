import { NotificationEvent } from '@mcs/shared';
import type { SchedulerService, SettingsService } from '@/services';
import { EpisodeWatchManager, WATCH_BATCH } from './episode-watch.manager';
import type { MediaGroupManager } from './media-group.manager';
import type { NotificationManager } from './notification.manager';
import type { ReleaseManager } from './release.manager';

interface Fakes {
	scheduler: { onEpisodeWatch: jest.Mock };
	settings: { get: jest.Mock };
	groups: { groups: jest.Mock };
	releases: { search: jest.Mock };
	notifications: { notify: jest.Mock };
}

const show = (id: string, title = 'Spartacus') => ({ id, title, kind: 'series' });

/** A tracker line that covers a gap, which is the only kind worth saying anything about. */
const fillable = (fills = [{ itemId: 'ep-1', seasonNumber: 1, episodeNumber: 8, title: 'Eight' }]) => ({
	source: 'indexer',
	key: 'grp-1',
	release: { fills },
});

const build = (): { manager: EpisodeWatchManager; fakes: Fakes } => {
	const fakes: Fakes = {
		scheduler: { onEpisodeWatch: jest.fn() },
		settings: { get: jest.fn().mockResolvedValue({ indexer: { enabled: true } }) },
		groups: { groups: jest.fn().mockResolvedValue({ items: [show('series-1')] }) },
		releases: {
			search: jest.fn().mockResolvedValue({
				suggestions: [fillable()],
				missing: [{ itemId: 'ep-1', seasonNumber: 1, episodeNumber: 8, title: 'Eight' }],
			}),
		},
		notifications: { notify: jest.fn().mockResolvedValue(undefined) },
	};

	return {
		manager: new EpisodeWatchManager(
			fakes.scheduler as unknown as SchedulerService,
			fakes.settings as unknown as SettingsService,
			fakes.groups as unknown as MediaGroupManager,
			fakes.releases as unknown as ReleaseManager,
			fakes.notifications as unknown as NotificationManager,
		),
		fakes,
	};
};

describe('EpisodeWatchManager', () => {
	it('claims the hook, so the timer has somebody to call', () => {
		// A hook nobody subscribed is a job scheduled at every boot that fires into
		// nothing — which three of them did for the life of this product.
		const { manager, fakes } = build();

		manager.onModuleInit();

		expect(fakes.scheduler.onEpisodeWatch).toHaveBeenCalled();
	});

	it('asks only about shows that are both followed and worth acting on', async () => {
		// A show with nothing missing is not searched at all: one pass is one search per
		// show against every tracker, and asking about a complete series is asking
		// somebody else's indexer a question with no answer.
		const { manager, fakes } = build();

		await manager.sweep();

		expect(fakes.groups.groups).toHaveBeenCalledWith(
			expect.objectContaining({ watched: true, actionable: true, limit: WATCH_BATCH }),
		);
	});

	it('says so when a gap can be filled', async () => {
		const { manager, fakes } = build();

		expect(await manager.sweep()).toBe(1);
		expect(fakes.notifications.notify).toHaveBeenCalledWith(
			expect.objectContaining({ event: NotificationEvent.EPISODE_AVAILABLE }),
		);
	});

	it('proposes and never fetches', async () => {
		/*
		 * Which release to take is a decision about quality, size, language and who is
		 * seeding it, and the household makes it on a screen that shows them. A gateway
		 * grabbing on its own would be answering a question nobody asked it.
		 */
		const { manager, fakes } = build();

		await manager.sweep();

		expect(Object.keys(fakes.releases)).not.toContain('grab');
	});

	it('stays quiet when nothing on offer covers a gap', async () => {
		// Thirty releases of an episode already on the disk is not news, and a watch that
		// said so every six hours would be silenced within a week.
		const { manager, fakes } = build();

		fakes.releases.search.mockResolvedValue({
			suggestions: [{ source: 'indexer', key: 'grp-1', release: { fills: [] } }],
			missing: [],
		});

		expect(await manager.sweep()).toBe(0);
		expect(fakes.notifications.notify).not.toHaveBeenCalled();
	});

	it('asks nobody when no indexer is configured', async () => {
		// Said once rather than once per show, which is what a loop around a disabled
		// indexer would produce.
		const { manager, fakes } = build();

		fakes.settings.get.mockResolvedValue({ indexer: null });

		expect(await manager.sweep()).toBe(0);
		expect(fakes.groups.groups).not.toHaveBeenCalled();
	});

	it('finishes the pass when one show refuses', async () => {
		// An indexer having a bad evening about one show must not end the pass for the
		// thirty-nine behind it.
		const { manager, fakes } = build();

		fakes.groups.groups.mockResolvedValue({ items: [show('a'), show('b')] });
		fakes.releases.search
			.mockRejectedValueOnce(new Error('the tracker refused'))
			.mockResolvedValue({ suggestions: [fillable()], missing: [{ itemId: 'ep-1' }] });

		expect(await manager.sweep()).toBe(1);
	});

	it('joins a pass already running rather than doubling every search', async () => {
		// "Look now" pressed while the timer's pass is in flight is one pass, not two
		// sets of forty searches against the same trackers.
		const { manager, fakes } = build();

		const [first, second] = await Promise.all([manager.sweep(), manager.sweep()]);

		expect(first).toBe(second);
		expect(fakes.releases.search).toHaveBeenCalledTimes(1);
	});
});
