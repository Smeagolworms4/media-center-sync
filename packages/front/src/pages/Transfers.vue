<script lang="ts" setup>
	import type { ReleaseGrab, Transfer } from '@mcs/shared';
	import { EventName, FINISHED_TRANSFER_STATES, GrabState, HistoryView, TransferSort, TransferState } from '@mcs/shared';
	import { computed, onMounted, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { useRouter } from 'vue-router';
	import ByteSize from '@/components/common/ByteSize.vue';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import Rate from '@/components/common/Rate.vue';
	import StatTile from '@/components/common/StatTile.vue';
	import Pagination from '@/components/paginate/Pagination.vue';
	import ReleaseGrabRow from '@/components/transfer/ReleaseGrabRow.vue';
	import TransferBatch from '@/components/transfer/TransferBatch.vue';
	import TransferRow from '@/components/transfer/TransferRow.vue';
	import Window from '@/components/Window.vue';
	import { useDestinationLibraries } from '@/composables/useDestinationLibraries';
	import { TransferAction } from '@/composables/useTransferError';
	import { useEvents } from '@/hooks/useEvents';
	import { useNotifier } from '@/hooks/useNotifier';
	import { queryRef, queryTypes } from '@/libs/vue3-query-ref';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useReleasesStore } from '@/stores/releases';
	import { useServicesStore } from '@/stores/services';
	import { useSyncStore } from '@/stores/sync';
	import { useTransfersStore } from '@/stores/transfers';

	defineOptions({ name: 'TransfersPage' });

	/**
	 * The queue.
	 *
	 * Rows are keyed by transfer identifier and their numbers come from the store's
	 * progress objects, which the stream mutates in place — so a frame every half
	 * second costs one style update per bar rather than a diff of the whole list.
	 *
	 * It opens on what is still moving. A finished transfer is not deleted and not
	 * hidden: it is one click away under "Finished", which is said on the screen rather
	 * than left to be discovered, because somebody who believes their history was
	 * destroyed will not trust the next screen either. The retention that eventually
	 * removes those rows is a separate, much slower thing — thirty days for what
	 * succeeded, six months for what failed.
	 */
	const transfersStore = useTransfersStore();
	const releasesStore = useReleasesStore();
	const syncStore = useSyncStore();
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();
	const router = useRouter();
	const { t } = useI18n();
	const events = useEvents();
	const { notify, tryCallback } = useNotifier();
	/**
	 * The libraries a pull may be sent to, and the ones left out with the reason why.
	 *
	 * The same composable the dashboard's zone uses, rather than the store's writable
	 * list: a library on a friend's server is writable *for them*, and offering it here
	 * would accept a transfer that reports success and produces nothing anybody can
	 * watch. Saying why a name is missing matters as much as leaving it out — a list
	 * somebody's own shelf has silently vanished from reads as a bug.
	 */
	const { destinations } = useDestinationLibraries();

	const state = queryRef<TransferState>('state', queryTypes.stringEnum({
		values: Object.values(TransferState),
	}));
	/**
	 * In the URL, so that a link to this screen carries which half it was showing.
	 *
	 * The default is the live half rather than everything: on a gateway that has been
	 * running for a month the first page is entirely finished work, and the one
	 * transfer actually moving is on page four.
	 */
	const view = queryRef<HistoryView>('view', queryTypes.stringEnum({
		values: Object.values(HistoryView),
		defaultValue: HistoryView.LIVE,
	}));
	/**
	 * Asking for a finished state overrules the live default.
	 *
	 * The two controls can contradict each other — "live" and "done" describe no
	 * transfer at all — and the gateway answers that honestly with an empty page.
	 * Honest is not helpful here: somebody who picks "Failed" is asking to see the
	 * failures, not to be told there are none. Computed rather than a watcher on
	 * purpose, so that a link somebody was sent carrying `?state=failed` opens on the
	 * failures too, instead of on an empty list nothing on the screen explains.
	 */
	const effectiveView = computed(() => {
		const chosen = view.value ?? HistoryView.LIVE;
		const asksForFinished = !!state.value && FINISHED_TRANSFER_STATES.includes(state.value);

		return chosen === HistoryView.LIVE && asksForFinished ? HistoryView.ALL : chosen;
	});

	/**
	 * What is moving comes first, unless somebody asks otherwise.
	 *
	 * Newest first put a queue of eighty behind whatever finished a minute ago, so the
	 * rows being watched were on page two. In the address, so a sort survives a reload
	 * and a link carries it.
	 */
	const sort = queryRef<TransferSort>('sort', queryTypes.stringEnum({
		values: Object.values(TransferSort),
		defaultValue: TransferSort.ACTIVITY,
	}));

	const sortItems = computed(() => Object.values(TransferSort).map(value => ({
		value,
		title: t(`transfer.sort.${value}`),
	})));

	const page = queryRef<number>('page', queryTypes.integer({ defaultValue: 0 }));
	const limit = queryRef<number>('limit', queryTypes.integer({ defaultValue: 20 }));

	const failed = ref(false);
	const busyId = ref<string | null>(null);
	/**
	 * What is being sent elsewhere: one file, or a whole run.
	 *
	 * The same dialog for both because it is the same question, and because a run
	 * redirected file by file is the thing this must never become — a season that ends
	 * half in one library and half in another, which is what somebody is here to fix.
	 */
	const retargeting = ref<{ title: string; jobId: string | null; transfers: Transfer[] } | null>(
		null);
	const targetLibraryId = ref<string | null>(null);
	/**
	 * The folder inside the chosen library, filled with where the gateway would put it.
	 *
	 * A library is not one folder — a shelf can be five directories on five disks — so
	 * choosing the shelf chose only the first of them. Prefilled rather than blank: a
	 * placeholder cannot be edited, so refining it meant retyping the whole path.
	 */
	const targetFolder = ref<string | null>(null);
	const browsingTarget = ref(false);
	const retargetBusy = ref(false);
	/** The torrent being redirected, when the dialog was opened from one. */
	const retargetingGrab = ref<ReleaseGrab | null>(null);
	const resumingAll = ref(false);

	/**
	 * Whether pressing the button will move bytes or rewrite a row.
	 *
	 * The single most important thing this dialog says. A transfer that has not landed
	 * yet is writing into the scratch directory and its destination is not read until
	 * the very end, so changing it costs nothing and interrupts nothing. One that has
	 * landed is in a library, and the same button is a real copy between two real
	 * filesystems that can take three quarters of an hour on a season. Offering both
	 * under one unqualified "move" is how somebody starts forty gigabytes of disk
	 * traffic believing they corrected a form field.
	 */
	const movesBytes = computed(
		() => (retargeting.value?.transfers ?? []).some(one => one.state === TransferState.DONE));

	/** The run's own files, when what is being redirected is a run and not one file. */
	const retargetCount = computed(() => retargeting.value?.transfers.length ?? 0);

	/** Every directory of the chosen shelf, which is as far as browsing may go. */
	const chosenRoots = computed<string[]>(() => {
		const chosen = destinations.value.find(one => one.id === targetLibraryId.value);

		return chosen ? (chosen.roots.length > 0 ? chosen.roots : [chosen.path ?? '']) : [];
	});

	const targetRoot = computed(
		() => destinations.value.find(one => one.id === targetLibraryId.value)?.path ?? null);

	/*
	 * Reset rather than kept, because a folder of the shelf somebody just left sits
	 * under no root of the new one, and the gateway would refuse it — which reads here
	 * as the dialog being broken.
	 */
	watch(targetLibraryId, () => {
		targetFolder.value = targetRoot.value;
	});

	// The path under the name, because a choice made against `Shows` and a choice made
	// against `/mnt/nas/shows` are not the same choice on a gateway with two of each.
	// The marks ride along on the same `item-props`, which is how the offer itself can
	// be read back — "only libraries this gateway writes into are proposed" is a
	// statement about the options, and nothing else on the screen shows them.
	const destinationItems = computed(() => destinations.value.map(one => ({
		'value': one.id,
		'title': one.name,
		'subtitle': one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
		'data-test': 'retarget-option',
		'data-library': one.id,
	})));

	const pageModel = computed({
		get: () => page.value ?? 0,
		set: (value: number) => {
			page.value = value;
		},
	});
	const limitModel = computed({
		get: () => limit.value ?? 20,
		set: (value: number) => {
			limit.value = value;
		},
	});

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await Promise.all([
				transfersStore.load({
					// The pagination control counts from zero; the API counts from one.
					page: (page.value ?? 0) + 1,
					limit: limit.value ?? 20,
					state: state.value,
					view: effectiveView.value,
					sort: sort.value ?? undefined,
				}),
				transfersStore.loadStats(),
			]);
		} catch {
			failed.value = true;
		}
	}

	onMounted(async () => {
		await Promise.all([
			librariesStore.loaded ? Promise.resolve() : librariesStore.load().catch(() => undefined),
			librariesStore.loadChecks().catch(() => undefined),
			servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
			// Swallowed like the rest: a gateway with no download client configured has
			// none of these, and a queue that failed to draw because of a feature nobody
			// turned on would be the whole screen lost to an optional part of it.
			releasesStore.loadGrabs().catch(() => undefined),
		]);
		await load();
	});

	watch([state, view, limit, sort], () => {
		page.value = 0;
		void load();
	});

	watch(page, () => {
		void load();
	});

	// `item-props`, so an option carries a mark of its own: the labels are translated
	// and a journey that picked one by its wording would break the day the interface
	// is read in another language.
	const stateItems = computed(() => Object.values(TransferState).map(value => ({
		'value': value,
		'title': t(`transfer.state.${value}`),
		'data-test': 'transfer-state-option',
		'data-value': value,
	})));

	const viewItems = computed(() => Object.values(HistoryView).map(value => ({
		value,
		title: t(`history.view.${value}`),
	})));

	const viewModel = computed({
		get: () => effectiveView.value,
		set: (value: HistoryView) => {
			view.value = value;
		},
	});

	/** Said on the screen, so nobody has to guess that the finished rows still exist. */
	const showingLiveOnly = computed(() => viewModel.value === HistoryView.LIVE);

	const transfers = computed(() => transfersStore.transfers);

	/** The grab states that are still going to move on their own. */
	const LIVE_GRAB_STATES: Set<GrabState> = new Set([GrabState.SENT, GrabState.DOWNLOADING, GrabState.FETCHED]);

	/**
	 * A torrent's states, in the vocabulary the filter above is written in.
	 *
	 * The two vocabularies are genuinely different — a torrent is `sent` and then
	 * `fetched`, a transfer is `pending` and then `placing` — and this is the one place
	 * they meet. Mapped rather than merged: they are different things with different
	 * lifecycles, and the screen only has to agree on what somebody means when they ask
	 * for "failed".
	 */
	const GRABS_BY_TRANSFER_STATE: Partial<Record<TransferState, GrabState[]>> = {
		[TransferState.QUEUED]: [GrabState.SENT],
		[TransferState.DOWNLOADING]: [GrabState.DOWNLOADING],
		// A torrent the client has finished is waiting to be copied into the library,
		// which is what a transfer calls `placing`.
		[TransferState.PLACING]: [GrabState.FETCHED],
		[TransferState.DONE]: [GrabState.PLACED],
		[TransferState.FAILED]: [GrabState.FAILED],
		[TransferState.CANCELLED]: [GrabState.CANCELLED],
	};

	/**
	 * The torrents this view is about.
	 *
	 * They used to be listed whatever was being asked for, which read as a list that
	 * ignored its own filters — and, worse, they vanished entirely whenever no *transfer*
	 * matched, because the empty state above them was decided on transfers alone. A
	 * torrent that failed was then invisible on the one screen somebody goes to when a
	 * download has failed, which is exactly where its own row was written.
	 */
	const grabs = computed(() => {
		const wanted = state.value === null || state.value === undefined
			? null
			: (GRABS_BY_TRANSFER_STATE[state.value] ?? []);

		if (wanted !== null) {
			return releasesStore.grabs.filter(one => wanted.includes(one.state));
		}

		if (viewModel.value === HistoryView.LIVE) {
			return releasesStore.grabs.filter(one => LIVE_GRAB_STATES.has(one.state));
		}

		if (viewModel.value === HistoryView.FINISHED) {
			return releasesStore.grabs.filter(one => !LIVE_GRAB_STATES.has(one.state));
		}

		return releasesStore.grabs;
	});

	/**
	 * The queue as downloads rather than as files — the store's grouping, not a second
	 * one. See `QueueBatch`: the lot decides, the run is its fallback for rows written
	 * before the lot was recorded.
	 */
	const batches = computed(() => transfersStore.batches);

	const pausedTransfers = computed(
		() => transfers.value.filter(one => one.state === TransferState.PAUSED));

	/**
	 * A queue that is entirely paused is a state, not an empty one: nothing moves,
	 * every bar keeps its position, and the only thing missing is somebody pressing
	 * resume. Said once at the top rather than repeated on every row.
	 */
	const queuePaused = computed(
		() => transfersStore.stats.paused > 0 && transfersStore.stats.active === 0);

	const resumeAll = tryCallback(async () => {
		resumingAll.value = true;
		try {
			for (const transfer of pausedTransfers.value) {
				await transfersStore.resume(transfer.id);
			}
			void notify('transfer.resumed_all');
		} finally {
			resumingAll.value = false;
		}
	});

	/**
	 * A verification answers a question somebody asked minutes ago, possibly from
	 * another tab, so it is worth a notification even when nothing else changes:
	 * a clean answer means the source was fine and the problem is elsewhere.
	 */
	events.on(EventName.TRANSFER_VERIFIED, verification => {
		void notify(
			verification.ok ? 'transfer.verify_ok' : 'transfer.verify_corrupt',
			verification.ok ? 'success' : 'warning',
		);
	});

	// Only a revalidation that decided something is worth interrupting for; the
	// rest are history, and the expanded row already shows them.
	events.on(EventName.TRANSFER_REVALIDATED, revalidation => {
		if (revalidation.action) {
			void notify('transfer.revalidated', 'warning');
		}
	});

	function progressOf (transfer: Transfer) {
		return transfersStore.progress[transfer.id] ?? {
			id: transfer.id,
			state: transfer.state,
			bytesDone: transfer.bytesDone,
			bytesTotal: transfer.bytesTotal,
			rate: transfer.rate,
			etaSeconds: transfer.etaSeconds,
			chunksDone: transfer.chunksDone,
			chunksTotal: transfer.chunksTotal,
			sourceCount: transfer.sources?.length ?? 0,
		};
	}

	/**
	 * Planning the item again is how "look for another source" is expressed: the
	 * gateway re-picks the sources from the priority order, which is exactly what a
	 * source that has gone away calls for — and what a retry would refuse to do.
	 */
	const replan = tryCallback(async (transfer: Transfer, libraryId: string | null) => {
		await syncStore.run({
			scope: { itemIds: [transfer.itemId] },
			...(libraryId ? { targetLibraryId: libraryId } : {}),
		});
		void notify('transfer.replanned');
	});

	const handle = tryCallback(async (action: TransferAction, transfer: Transfer) => {
		busyId.value = transfer.id;
		try {
			switch (action) {
			case TransferAction.PAUSE: {
				await transfersStore.pause(transfer.id);
				break;
			}
			case TransferAction.RESUME: {
				await transfersStore.resume(transfer.id);
				break;
			}
			case TransferAction.CANCEL: {
				await transfersStore.cancel(transfer.id);
				break;
			}
			case TransferAction.ARCHIVE: {
				await transfersStore.archive(transfer.id);
				void notify('transfer.archived');
				break;
			}
			case TransferAction.RETRY: {
				await transfersStore.retry(transfer.id);
				break;
			}
			case TransferAction.REPAIR: {
				await transfersStore.repair(transfer.id);
				break;
			}
			case TransferAction.VERIFY: {
				// No toast here: the answer lands in the row itself, and the gateway
				// also announces it — notifying as well would say it twice.
				await transfersStore.verify(transfer.id);
				break;
			}
			case TransferAction.ANOTHER_SOURCE: {
				await replan(transfer, null);
				break;
			}
			case TransferAction.ANOTHER_TARGET: {
				// The target is a choice, so it is asked for rather than guessed.
				retargeting.value = { title: transfer.title, jobId: null, transfers: [transfer] };
				targetLibraryId.value = null;
				targetFolder.value = null;
				break;
			}
			case TransferAction.FIX_SERVICE: {
				const serviceId = transfer.sources[0]?.serviceId;
				await (serviceId
					? router.push({ name: 'service', params: { id: serviceId } })
					: router.push({ name: 'services' }));
				break;
			}
			}
		} finally {
			busyId.value = null;
		}
	});

	/**
	 * Send this transfer somewhere else, rather than planning the item again.
	 *
	 * Re-planning was what this button used to do, and it was the wrong answer to the
	 * question being asked: it starts the item over from its sources, so a season three
	 * quarters downloaded into the wrong library would be fetched again from the top.
	 * The gateway knows how to re-point a transfer where it stands — one row write
	 * before it lands, a tracked move after — so that is what is asked of it.
	 */
	/**
	 * Where what is being redirected goes today, named before anything is chosen.
	 *
	 * The dialog asked "which library instead?" without ever saying instead of what. On a
	 * gateway with four shelves and a rule nobody remembers, that is a question somebody
	 * cannot answer — and the answer is already in hand: the path once it is filed, the
	 * folder somebody pinned, the destination worked out when the download was sent, or
	 * failing all three the library's name.
	 *
	 * Null when genuinely nothing is known, and then the line is not drawn: an
	 * "Actuellement:" with nothing after it is worse than the silence it replaces.
	 */
	const currentDestination = computed<string | null>(() => {
		const grab = retargetingGrab.value;
		const source = grab ?? retargeting.value?.transfers[0] ?? null;

		if (source === null) {
			return null;
		}

		const planned = grab?.plannedPath ?? null;
		const pinned = 'targetFolder' in source ? source.targetFolder : null;
		const named = source.targetPath ?? pinned ?? planned;

		if (named) {
			return named;
		}

		const library = source.targetLibraryId === null
			? null
			: librariesStore.libraries.find(one => one.id === source.targetLibraryId);

		return library ? (library.alias ?? library.name) : null;
	});

	/**
	 * Look again at a torrent that failed, after the repair that made it fail was made.
	 *
	 * The whole gesture: a root mapping that named a folder the client could not write
	 * failed every download, and once it was corrected there was nothing to press — the
	 * torrents were still in the client, most of them finished, and the only way back was
	 * to search for the same release and grab it again.
	 */
	const retryGrab = tryCallback(async (grab: ReleaseGrab) => {
		busyId.value = grab.id;

		try {
			await releasesStore.retry(grab.id);
			void notify('release.retried');
		} finally {
			busyId.value = null;
		}
	});

	const confirmRetarget = tryCallback(async () => {
		const asked = retargeting.value;

		if (!asked || !targetLibraryId.value) {
			return;
		}
		retargetBusy.value = true;

		/*
		 * The prefilled root is not a choice, so it is not sent as one.
		 *
		 * The field opens on where the gateway would put it, which is a display of the
		 * default and not an answer. Sending it back would pin that exact directory —
		 * and a library is several roots on several disks, so pinning the first of them
		 * takes away the gateway's ability to place the file on the one with room. Only
		 * a folder somebody actually changed is a folder somebody asked for.
		 */
		const chosen = targetFolder.value?.trim() || null;
		const folder = chosen === targetRoot.value ? null : chosen;

		// A torrent takes the same answer by a route of its own: it is not a transfer and
		// has no row in that table, but where it lands is the very same decision.
		if (retargetingGrab.value !== null) {
			try {
				await releasesStore.setDestination(
					retargetingGrab.value.id, targetLibraryId.value, folder);
				void notify('transfer.retarget.repointed');
				retargeting.value = null;
				retargetingGrab.value = null;
			} finally {
				retargetBusy.value = false;
			}

			return;
		}

		try {
			/*
			 * One request for the whole run, rather than a loop over its files.
			 *
			 * The gateway checks every file before it touches any of them, so a run that
			 * cannot go somewhere in full does not go there in part. A loop from here
			 * would move four episodes and then report a failure on the fifth, leaving
			 * exactly the split somebody opened this dialog to repair — and it would take
			 * the already-landed files with it, one slow copy at a time, with no way to
			 * stop halfway.
			 */
			await (asked.jobId === null
				? transfersStore.setDestination(asked.transfers[0].id, targetLibraryId.value, folder)
				: transfersStore.setJobDestination(asked.jobId, targetLibraryId.value, folder));

			void notify(movesBytes.value ? 'transfer.retarget.moved' : 'transfer.retarget.repointed');
			retargeting.value = null;
		} finally {
			retargetBusy.value = false;
		}
	});

	/**
	 * Send a torrent elsewhere, before it is filed.
	 *
	 * The same dialog as a transfer's, because it is the same question and the same
	 * answer — a library, then a folder inside it. A second control for it would be a
	 * second way of saying one thing, and the two would drift.
	 */
	function retargetGrab (grab: ReleaseGrab): void {
		retargetingGrab.value = grab;
		retargeting.value = { title: grab.title, jobId: null, transfers: [] };
		targetLibraryId.value = grab.targetLibraryId;
		targetFolder.value = grab.targetFolder;
	}

	/**
	 * Send a whole download elsewhere, from the block's own button.
	 *
	 * Any run of the block will do, because the gateway widens from the run to the lots
	 * it carried: a block spanning three nights is moved whole whichever of its nights is
	 * named. The first row that has a run is taken rather than the first row outright,
	 * since a block can hold a pull that belonged to no run at all.
	 */
	function retargetBatch (transfers: Transfer[]): void {
		const jobId = transfers.find(one => one.jobId !== null)?.jobId ?? null;

		if (jobId === null) {
			return;
		}

		retargeting.value = { title: transfers[0].title, jobId, transfers };
		targetLibraryId.value = null;
		targetFolder.value = null;
	}
</script>

<template>
	<div class="page-container transfers">
		<PageHeader
			icon="mdi-transfer-down"
			:loading="transfersStore.loading"
			:subtitle="$t('transfer.subtitle')"
			:title="$t('pages.transfers')"
		>
			<template #actions>
				<v-select
					v-model="sort"
					class="transfers_sort"
					data-test="transfer-sort"
					density="compact"
					hide-details
					item-title="title"
					item-value="value"
					:items="sortItems"
					:label="$t('transfer.sort.label')"
					variant="outlined"
				/>

				<v-btn-toggle
					v-model="viewModel"
					class="transfers_view"
					data-test="transfer-view"
					density="compact"
					mandatory
					variant="outlined"
				>
					<v-btn
						v-for="item of viewItems"
						:key="item.value"
						:data-test="`transfer-view-${item.value}`"
						size="small"
						:value="item.value"
					>
						{{ item.title }}
					</v-btn>
				</v-btn-toggle>

				<v-select
					v-model="state"
					class="transfers_filter"
					clearable
					data-test="transfer-state-filter"
					density="compact"
					hide-details
					item-props
					item-title="title"
					item-value="value"
					:items="stateItems"
					:label="$t('transfer.filter_state')"
				/>

				<v-btn
					:loading="transfersStore.loading"
					prepend-icon="mdi-refresh"
					variant="text"
					@click="load"
				>
					{{ $t('actions.refresh') }}
				</v-btn>
			</template>
		</PageHeader>

		<v-alert
			v-if="queuePaused"
			class="mb-3"
			data-test="queue-paused"
			density="comfortable"
			type="info"
			variant="tonal"
		>
			<div class="transfers_pausedBanner">
				<span>{{ $t('transfer.queue_paused', { count: transfersStore.stats.paused }) }}</span>

				<v-spacer />

				<v-btn
					color="primary"
					data-test="transfer-resume-all"
					:disabled="pausedTransfers.length === 0"
					:loading="resumingAll"
					prepend-icon="mdi-play"
					size="small"
					variant="tonal"
					@click="resumeAll"
				>
					{{ $t('transfer.resume_all') }}
				</v-btn>
			</div>
		</v-alert>

		<v-row data-test="transfer-stats" density="compact">
			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-play-circle-outline"
					:title="$t('transfer.stats.active')"
					:value="transfersStore.stats.active"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-tray-full"
					:title="$t('transfer.stats.queued')"
					:value="transfersStore.stats.queued"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-pause-circle-outline"
					:title="$t('transfer.stats.paused')"
					:value="transfersStore.stats.paused"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile
					icon="mdi-alert-circle-outline"
					:title="$t('transfer.stats.failed')"
					:tone="transfersStore.stats.failed > 0 ? 'error' : 'neutral'"
					:value="transfersStore.stats.failed"
				/>
			</v-col>

			<v-col cols="6" md="3">
				<StatTile icon="mdi-speedometer" :title="$t('transfer.stats.rate')">
					<template #default>
						<p class="text-caption text-medium-emphasis mb-0">
							{{ $t('transfer.stats.remaining') }}
							<ByteSize :bytes="transfersStore.stats.bytesRemaining" />
						</p>
					</template>

					<template #value><Rate :rate="transfersStore.stats.rate" /></template>
				</StatTile>
			</v-col>
		</v-row>

		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<EmptyState
				v-if="!transfersStore.loading && transfers.length === 0 && grabs.length === 0"
				icon="mdi-download-off-outline"
				:text="showingLiveOnly ? $t('history.empty_live_text') : $t('transfer.empty_text')"
				:title="showingLiveOnly ? $t('history.empty_live_title') : $t('transfer.empty_title')"
			>
				<v-btn
					v-if="showingLiveOnly"
					data-test="transfer-see-finished"
					variant="tonal"
					@click="viewModel = HistoryView.FINISHED"
				>
					{{ $t('history.see_finished') }}
				</v-btn>
			</EmptyState>

			<div v-else class="transfers_list mt-3" data-test="transfer-list">
				<!--
					Torrents first, and on this screen rather than one of their own. "Where
					are my downloads" is one question, and a household that has to look in
					two places to answer it will eventually look in only one. Only what this
					gateway started: the client is filtered on a category of ours, so
					somebody's own torrents are never listed, tracked or filed.
				-->
				<ReleaseGrabRow
					v-for="grab of grabs"
					:key="grab.id"
					:busy="busyId === grab.id"
					:grab="grab"
					@retarget="retargetGrab"
					@retry="retryGrab"
				/>

				<template v-for="batch of batches" :key="batch.key">
					<!--
						A run of one file is not folded: a single row inside a container
						saying "one file" is a frame around nothing.
					-->
					<TransferRow
						v-if="batch.transfers.length === 1"
						:busy="busyId === batch.transfers[0].id"
						:progress="progressOf(batch.transfers[0])"
						:transfer="batch.transfers[0]"
						@action="handle"
					/>

					<TransferBatch
						v-else
						:busy-id="busyId"
						:progress="progressOf"
						:transfers="batch.transfers"
						@action="handle"
						@retarget="retargetBatch"
					/>
				</template>
			</div>

			<Pagination
				v-if="transfers.length > 0"
				v-model:limit="limitModel"
				v-model:page="pageModel"
				class="mt-2"
				:label="$t('components.paginate.table.lines_per_page')"
				:total="transfersStore.pagination.total"
			/>

			<p
				v-if="showingLiveOnly && transfers.length > 0"
				class="text-caption text-medium-emphasis mt-2"
				data-test="transfer-history-hint"
			>
				{{ $t('history.hint_transfers') }}
			</p>
		</template>

		<Window
			:max-width="560"
			:model-value="retargeting !== null"
			:title="$t('transfer.retarget.title')"
			@update:model-value="retargeting = null"
		>
			<p class="text-body-2 mb-1" data-test="retarget-subject">
				{{ retargeting?.jobId
					? $t('transfer.retarget.whole_lot', { title: retargeting?.title, count: retargetCount })
					: retargeting?.title }}
			</p>

			<!--
				Where it goes today, which is what "another library" is being asked against.
				The dialog used to open on the question alone.
			-->
			<p
				v-if="currentDestination"
				class="text-body-2 text-medium-emphasis mb-1 transfers_path"
				data-test="retarget-current"
			>
				{{ $t('transfer.retarget.current', { path: currentDestination }) }}
			</p>

			<!--
				Said only when bytes are about to move. The other half of this used to
				explain that re-pointing a download copies nothing — which is what anybody
				would expect of a destination field, so it was three lines saying that
				nothing surprising was about to happen.
			-->
			<p
				v-if="movesBytes"
				class="text-body-2 text-medium-emphasis mb-4"
				data-test="retarget-hint"
			>
				{{ $t('transfer.retarget.hint_move') }}
				<!--
					Said before the click, because this is the expensive half of the answer:
					the files of the download that already landed are moved for real, and the
					folders they leave empty behind them are removed. It says "earlier runs"
					as well, because the count above it is what this page holds and the
					gateway moves the whole lot — a season pulled over three nights included.
				-->
				<template v-if="retargeting?.jobId && movesBytes">
					{{ $t('transfer.retarget.hint_lot_landed') }}
				</template>
			</p>

			<v-select
				v-model="targetLibraryId"
				data-test="retarget-library"
				item-props
				item-title="title"
				item-value="value"
				:items="destinationItems"
				:label="$t('transfer.retarget.library')"
			/>

			<!--
				Only once a shelf is chosen: a folder with no shelf to sit in is a field
				that cannot be filled, and browsing from nowhere has nothing to show. The
				folder need not exist — nothing is created until the bytes are written.
			-->
			<div v-if="targetLibraryId">
				<v-text-field
					v-model="targetFolder"
					clearable
					data-test="retarget-folder"
					density="compact"
					hide-details
					:label="$t('transfer.unconfigured.folder')"
					:placeholder="targetRoot ?? ''"
				>
					<template #append-inner>
						<v-btn
							data-test="retarget-browse"
							icon="mdi-folder-open-outline"
							size="small"
							:title="$t('browse.open')"
							variant="text"
							@click="browsingTarget = true"
						/>
					</template>
				</v-text-field>

				<!--
					Bounded by the chosen shelf's own directories, for the same reason the
					correction dialog is: a folder picked outside the library is a
					destination that library will never scan.
				-->
				<DirectoryPicker
					v-model="browsingTarget"
					:path="targetFolder ?? targetRoot"
					:roots="chosenRoots"
					@choose="targetFolder = $event"
				/>
			</div>

			<p
				v-if="destinations.length === 0"
				class="text-caption text-warning mb-0 mt-2"
				data-test="retarget-none"
			>
				{{ $t('settings.destination.none') }}
			</p>

			<!--
				The shelves this gateway cannot write into are not listed here. They were,
				one line each with the reason, and on a household with a friend's server
				that is four lines of "you cannot pick this" under a field with two
				choices in it — noise in front of the decision. The warning above still
				answers the case that matters, which is when there is nothing to pick at
				all; the settings screen is where a shelf that should be writable and is
				not gets explained.
			-->

			<template #actions>
				<v-spacer />

				<v-btn variant="text" @click="retargeting = null">{{ $t('actions.cancel') }}</v-btn>

				<v-btn
					color="primary"
					data-test="retarget-confirm"
					:disabled="!targetLibraryId"
					:loading="retargetBusy"
					@click="confirmRetarget"
				>
					{{ movesBytes ? $t('transfer.retarget.confirm_move') : $t('transfer.retarget.confirm') }}
				</v-btn>
			</template>
		</Window>
	</div>
</template>

<style lang="scss">
	.transfers {
		&_sort {
			// Narrow enough to sit beside the view toggle rather than pushing it onto a
			// line of its own on a laptop.
			max-width: 200px;
		}

		&_filter {
			min-width: 180px;
		}

		&_view {
			margin-right: 8px;
		}

		&_pausedBanner {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		&_list {
			display: flex;
			flex-direction: column;
			gap: 10px;
		}
	}
</style>
