<script lang="ts" setup>
	import {
		ActionableReason,
		type MediaGroup,
		type MediaGroupQuery,
		NewsSignal,
	} from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import LibrarySection from '@/components/media/LibrarySection.vue';
	import ViewModeToggle from '@/components/media/ViewModeToggle.vue';
	import { useViewMode } from '@/composables/useViewMode';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useMediaStore } from '@/stores/media';
	import { useServicesStore } from '@/stores/services';

	defineOptions({ name: 'NewReleasesPage' });

	/**
	 * What has come out since, for the shows this household follows.
	 *
	 * Asked for in these words: a series comes up when a new episode has aired and the
	 * series is being watched. Both halves matter — an episode of something nobody here
	 * follows is not news, and a show being followed with nothing new is not either.
	 *
	 * "Watched" is either way of saying it: a sync plan covering the show, or an ask open on
	 * the request source. Nobody writes a plan for a series they have just asked Seerr for,
	 * and a screen that read plans alone would have been empty while the request list was
	 * full — see `MediaGroupQuery.watched`.
	 *
	 * **Two lists, because they are two different decisions.** What is missing is something
	 * to fetch. What is held in a worse copy than exists elsewhere is something to replace,
	 * and it was asked for explicitly that it not be counted among the missing: "if we have
	 * it but in a bad version, that is a version upgrade". Mixing them would put a file that
	 * plays tonight in the same list as one that does not exist here at all.
	 */
	const mediaStore = useMediaStore();

	/**
	 * Drawn the way the library is drawn, because it is the library asking one question.
	 *
	 * It had a list of its own and read as a second product: a bare table of episode names
	 * beside a wall of posters. The band component is the library's own, so the posters,
	 * the states, the quality chips and the grid-or-list preference are the same ones —
	 * and the preference is shared with the library on purpose, since somebody who browses
	 * in rows browses in rows everywhere.
	 */
	const view = useViewMode('mcs.library.view');

	const { t } = useI18n();
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();

	/**
	 * Whether anything is still being read in, so an empty wall can say which empty it is.
	 *
	 * The two look identical and mean opposite things: "nothing new for the shows you
	 * follow" is an answer, and "nobody has finished reading your watchlist yet" is a
	 * wait. Shown as a wait, somebody comes back in a minute; shown as an answer, they
	 * conclude the feature does not work — which is what happened.
	 *
	 * Any service, not only the request source: a scan of the media servers moves rows
	 * between held and missing, so this screen is as unfinished during one of those.
	 */
	const scanning = computed(
		() => Object.values(servicesStore.scans).some(one => one !== undefined && !one.done));

	/** Every scan still going, which is what the two figures below are summed over. */
	const running = computed(
		() => Object.values(servicesStore.scans).filter(one => one !== undefined && !one.done));

	/** Rows read so far. */
	const scanned = computed(
		() => running.value.reduce((count, one) => count + (one?.itemsSeen ?? 0), 0));

	/**
	 * Rows expected, or null when nothing can say.
	 *
	 * The gateway reports what the previous scan of each library found — the honest
	 * estimate, since counting first would mean reading the library twice. Null on a first
	 * scan, and null here unless *every* running scan has a figure: summing the ones that
	 * do against the rows of the ones that do not would draw a bar past its own end.
	 */
	const expected = computed(() => {
		const totals = running.value.map(one => one?.itemsTotal ?? null);

		return totals.length > 0 && totals.every(one => one !== null)
			? totals.reduce((count: number, one) => count + (one as number), 0)
			: null;
	});

	/** How far along, as a percentage, capped: last time's count is an estimate. */
	const scannedPercent = computed(() => (expected.value === null || expected.value === 0
		? null
		: Math.min(100, Math.round((scanned.value / expected.value) * 100))));

	const failed = ref(false);
	const loading = ref(false);

	/**
	 * How much of the wall is drawn before somebody asks for more.
	 *
	 * Across every category rather than per category, because the wall is read in one
	 * request now — see `QUERY`. Twice the library's own band, since this is the whole
	 * screen and not one shelf of it.
	 */
	const WALL_LIMIT = 120;

	/**
	 * One band per category, exactly as the library draws its home screen.
	 *
	 * This screen used to ask for episodes and got what it asked for: a flat wall of sixty
	 * episode tiles with no posters, out of any series, out of any category. Seerr hands us
	 * *series* and the episodes are found inside them — so the wall is series, and opening
	 * one is how you reach its seasons and its episodes, like everywhere else.
	 *
	 * That one change answers all three complaints at once. A series carries the poster the
	 * request source named, where a season and an episode carry none. A series is what a
	 * category sorts. And a series with twelve gaps is one card rather than twelve.
	 */
	/**
	 * One read for the whole wall, cut into bands here rather than asked for band by band.
	 *
	 * It used to ask once per category, and on a household with eight of them that was
	 * eight of the most expensive query this product has: `rootsOnly` together with
	 * `actionable` makes the gateway re-read every descendant of the scope and build a
	 * skeleton for each, and doing that eight times over is where ten seconds of a reload
	 * went. The answer is the same wall either way — the categories are a *presentation*
	 * of what came back, and a category a media belongs to is already known here from the
	 * library it sits in.
	 */
	const KEY = 'new-releases';

	/**
	 * Which half of the news to show, remembered between visits.
	 *
	 * The screen answers two questions at once — something to fetch, something to
	 * replace — and they are not read in the same mood. A new episode is tonight; a
	 * better encoding of a film already on the disk is a weekend job, and on a metered
	 * connection it may be never. Asked for explicitly, and kept per browser rather
	 * than per account because it is a way of reading a screen and not a setting of
	 * the household's.
	 *
	 * Both ticked is the default and is what this screen has always shown, so nobody
	 * loses anything by never touching it.
	 */
	const REASONS_KEY = 'mcs.news.reasons';

	/**
	 * Which of the things that can fill a gap to show, remembered the same way.
	 *
	 * The second half of the same complaint. `actionable` says a show has a hole; it
	 * says nothing about whether anybody can fill it, so the wall offered twelve cards
	 * of which two were obtainable and the rest were shows nobody is seeding and nobody
	 * here holds — "pas juste notifier sur overseer".
	 *
	 * Beware the asymmetry with the reasons above, which is why this takes two pieces of
	 * state rather than one: both ticked here does *not* mean "no filter". A show the
	 * episode watch has not come round to carries no signal at all, so asking for either
	 * signal still drops it. This remembers *which* of the two somebody wants;
	 * `onlyFetchable` below remembers whether to narrow by them at all, and starts off.
	 */
	const SIGNALS_KEY = 'mcs.news.signals';

	/**
	 * A remembered multiple choice, or the default when storage says nothing usable.
	 *
	 * Never an empty answer: a value written by an older build, or edited by hand, must
	 * not leave somebody on a permanently blank screen with no way to tell it from
	 * "nothing new". Written once rather than twice because both toggles want exactly
	 * this and the second would have been the first with a different enum pasted in.
	 */
	function remembered<T extends string> (key: string, known: T[]): T[] {
		try {
			const stored = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;

			if (!Array.isArray(stored)) {
				return known;
			}

			const kept = known.filter(one => stored.includes(one));

			return kept.length > 0 ? kept : known;
		} catch {
			// Private browsing, cleared site data, storage refused. The default reads the
			// same as it always has.
			return known;
		}
	}

	function remember (key: string, value: unknown): void {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {
			// Not worth failing a reload over; the filter simply will not be remembered.
		}
	}

	/** Guarded like every other read of it: storage can refuse outright. */
	function rememberedFlag (key: string): boolean {
		try {
			return localStorage.getItem(key) === 'true';
		} catch {
			return false;
		}
	}

	const REASONS = [ActionableReason.GAP, ActionableReason.UPGRADE];
	const SIGNALS = [NewsSignal.COPY, NewsSignal.RELEASE];

	const reasons = ref<ActionableReason[]>(remembered(REASONS_KEY, REASONS));
	const signals = ref<NewsSignal[]>(remembered(SIGNALS_KEY, SIGNALS));

	/**
	 * Whether the signals narrow the wall at all, which is off until somebody says so.
	 *
	 * Kept apart from *which* signals, because the two answer different questions and
	 * folding them would make the common case unreachable: unticking both to mean "show
	 * me everything" is exactly what `remembered` refuses to store, and it has to stay
	 * sayable. So this is the switch and the toggles below are the choice.
	 *
	 * Off by default, because on by default would hide every show the episode watch has
	 * not come round to yet — most of a fresh watchlist — from the one screen built to
	 * show them.
	 */
	const SIGNALS_ON_KEY = 'mcs.news.signals_on';
	const onlyFetchable = ref(rememberedFlag(SIGNALS_ON_KEY));

	/** Toggling a filter re-asks the gateway: the narrowing is done there, not here. */
	async function chooseReasons (chosen: ActionableReason[]): Promise<void> {
		reasons.value = chosen.length > 0 ? chosen : REASONS;
		remember(REASONS_KEY, reasons.value);

		await load();
	}

	async function chooseSignals (chosen: NewsSignal[]): Promise<void> {
		signals.value = chosen.length > 0 ? chosen : SIGNALS;
		remember(SIGNALS_KEY, signals.value);

		await load();
	}

	async function chooseOnlyFetchable (on: boolean): Promise<void> {
		onlyFetchable.value = on;
		// A bare `true` or `false`, which is what `rememberedFlag` reads back.
		remember(SIGNALS_ON_KEY, on);

		await load();
	}

	const QUERY: MediaGroupQuery = {
		/*
		 * Roots, never episodes. `actionable` is what makes it news rather than a
		 * catalogue: it keeps what has something to fetch or to replace beneath it, and
		 * drops what is complete.
		 */
		rootsOnly: true,
		watched: true,
		actionable: true,
		/*
		 * By the date something came out. For a row nothing holds, that is the only date it
		 * has — the handlers write the air date into `addedAt`, because no server ever
		 * added it. See `RequestsHandler` and `discoverEpisodes`.
		 */
		sort: 'addedAt',
		direction: 'desc',
		limit: WALL_LIMIT,
	};

	async function load (): Promise<void> {
		failed.value = false;
		loading.value = true;

		try {
			await librariesStore.loadCategories();
			await mediaStore.searchGroups(KEY, {
				...QUERY,
				// Both reasons is the same request as no reasons at all, and sending
				// neither keeps the query identical to the one every earlier build sent.
				...(reasons.value.length === 2 ? {} : { reasons: reasons.value }),
				// Unlike the reasons, this is omitted unless it is switched on: a show
				// nobody has searched for yet carries no signal, so sending both values
				// is a real filter and not the absence of one.
				...(onlyFetchable.value ? { signals: signals.value } : {}),
			});
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(load);

	/** Which category each library belongs to, so a group can be filed without asking. */
	const categoryOfLibrary = computed(() => {
		const map = new Map<string, string>();

		for (const category of librariesStore.orderedCategories) {
			for (const libraryId of category.libraryIds) {
				map.set(libraryId, category.key);
			}
		}

		return map;
	});

	const rows = computed<MediaGroup[]>(() => mediaStore.groups[KEY] ?? []);

	/**
	 * The wall, cut into its categories, in the order the library shows them.
	 *
	 * A category with nothing in it is left out rather than drawn as a heading over
	 * nothing, and anything whose library names no category keeps its place at the end:
	 * dropping it would be hiding a media because this screen could not file it.
	 */
	const filled = computed(() => {
		const byCategory = new Map<string, MediaGroup[]>();

		for (const group of rows.value) {
			const key = categoryOfLibrary.value.get(group.libraryId ?? '') ?? '';

			byCategory.set(key, [...(byCategory.get(key) ?? []), group]);
		}

		const bands = librariesStore.orderedCategories
			.filter(one => (byCategory.get(one.key) ?? []).length > 0)
			.map(one => ({ key: one.key, name: one.name, groups: byCategory.get(one.key) ?? [] }));
		const orphans = byCategory.get('') ?? [];

		return orphans.length > 0
			? [...bands, { key: 'other', name: t('news.other'), groups: orphans }]
			: bands;
	});

	const total = computed(() => rows.value.length);
</script>

<template>
	<div class="page-container new-releases">
		<PageHeader
			icon="mdi-new-box"
			:loading="loading"
			:subtitle="$t('news.subtitle')"
			:title="$t('pages.news')"
		>
			<template #actions>
				<!--
					Which half of the news, as two toggles rather than a dropdown: both are
					on by default and the state has to be readable without opening
					anything, or somebody looking at a short wall cannot tell a quiet week
					from a filter they set last month.
				-->
				<v-btn-toggle
					class="news-reasons"
					data-test="news-reasons"
					density="comfortable"
					:model-value="reasons"
					multiple
					variant="outlined"
					@update:model-value="chooseReasons($event as ActionableReason[])"
				>
					<v-btn
						data-test="news-reason-gap"
						prepend-icon="mdi-playlist-plus"
						:value="ActionableReason.GAP"
					>
						{{ $t('news.reason_gap') }}
					</v-btn>

					<v-btn
						data-test="news-reason-upgrade"
						prepend-icon="mdi-arrow-up-bold-circle-outline"
						:value="ActionableReason.UPGRADE"
					>
						{{ $t('news.reason_upgrade') }}
					</v-btn>
				</v-btn-toggle>

				<!--
					And whether it can be had, which is the other half of the same question.
					A switch beside the two marks rather than a third toggle in the group
					above: "only what I can fetch" is a different kind of choice from
					"which half of the news", and three pills in a row read as one filter
					with three boxes — unticking the wrong one then empties the screen.
				-->
				<v-btn
					class="news-fetchable"
					:color="onlyFetchable ? 'primary' : undefined"
					data-test="news-only-fetchable"
					density="comfortable"
					prepend-icon="mdi-download-circle-outline"
					:variant="onlyFetchable ? 'flat' : 'outlined'"
					@click="chooseOnlyFetchable(!onlyFetchable)"
				>
					{{ $t('news.only_fetchable') }}
				</v-btn>

				<v-btn-toggle
					v-if="onlyFetchable"
					class="news-signals"
					data-test="news-signals"
					density="comfortable"
					:model-value="signals"
					multiple
					variant="outlined"
					@update:model-value="chooseSignals($event as NewsSignal[])"
				>
					<v-btn
						data-test="news-signal-copy"
						prepend-icon="mdi-lan-connect"
						:value="NewsSignal.COPY"
					>
						{{ $t('news.signal_copy') }}
					</v-btn>

					<v-btn
						data-test="news-signal-release"
						prepend-icon="mdi-magnet"
						:value="NewsSignal.RELEASE"
					>
						{{ $t('news.signal_release') }}
					</v-btn>
				</v-btn-toggle>

				<ViewModeToggle v-model="view" test-id="news-view-toggle" />

				<v-btn
					data-test="news-refresh"
					:loading="loading"
					prepend-icon="mdi-refresh"
					variant="text"
					@click="load"
				>
					{{ $t('actions.refresh') }}
				</v-btn>
			</template>
		</PageHeader>

		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<!--
				An empty wall during a scan is not an answer, it is a wait, and the two look
				exactly alike. Said as an answer, somebody reads "nothing new" off a screen
				that has not finished reading their watchlist and concludes the feature is
				broken — which is what happened.
			-->
			<EmptyState
				v-if="!loading && total === 0 && scanning"
				data-test="news-scanning"
				icon="mdi-radar"
				:text="scannedPercent === null
					? $t('news.scanning_text', { count: scanned })
					: $t('news.scanning_text_total', { count: scanned, total: expected })"
				:title="$t('news.scanning_title')"
			>
				<!--
					Determinate as soon as anything can say how far along it is, and
					indeterminate when nothing can. A bar that moves against a number is the
					difference between "it is working" and "it is nearly done".
				-->
				<v-progress-linear
					class="mt-4"
					color="primary"
					data-test="news-scanning-progress"
					:indeterminate="scannedPercent === null"
					:model-value="scannedPercent ?? 0"
					rounded
				/>
			</EmptyState>

			<!--
				And the third empty, which is a filter and not an answer either. "Nothing
				new" said while "only what I can fetch" is on would be a lie somebody
				acts on: there may be ten new episodes, none of them seeded and none of
				them on a friend's server yet, and the honest reading is that nothing can
				be had rather than that nothing has happened. Same lesson as the scan
				above, learnt the same way.
			-->
			<EmptyState
				v-else-if="!loading && total === 0 && onlyFetchable"
				data-test="news-empty-fetchable"
				icon="mdi-download-off-outline"
				:text="$t('news.empty_fetchable_text')"
				:title="$t('news.empty_fetchable_title')"
			>
				<v-btn
					class="mt-4"
					data-test="news-show-everything"
					variant="text"
					@click="chooseOnlyFetchable(false)"
				>
					{{ $t('news.show_everything') }}
				</v-btn>
			</EmptyState>

			<EmptyState
				v-else-if="!loading && total === 0"
				data-test="news-empty"
				icon="mdi-new-box"
				:text="$t('news.empty_text')"
				:title="$t('news.empty_title')"
			/>

			<!--
				One band per category, which is the library's own home screen with one filter
				added. A series carries its poster and its gap count; its seasons and episodes
				are a click away, where they belong.
			-->
			<template v-else>
				<LibrarySection
					v-for="category of filled"
					:key="category.key"
					:data-test="`news-band-${category.key}`"
					:groups="category.groups"
					:loading="loading"
					:title="category.name"
					:total="category.groups.length"
					:view="view"
				/>
			</template>
		</template>
	</div>
</template>

<style lang="scss">
	.new-releases {
		// The bands bring their own spacing; nothing else here needs any.
	}
</style>
