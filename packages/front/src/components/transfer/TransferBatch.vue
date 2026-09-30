<script lang="ts" setup>
	import type { TransferAction } from '@/composables/useTransferError';
	import type { Transfer, TransferLot, TransferProgress } from '@mcs/shared';
	import { FINISHED_TRANSFER_STATES, MediaLandingState, TransferState } from '@mcs/shared';
	import { computed, ref } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Rate from '@/components/common/Rate.vue';
	import TransferRow from '@/components/transfer/TransferRow.vue';

	/**
	 * One download, shown the way one download should be: one line, one title, one
	 * destination, one percentage, and the files inside it a fold away — grouped by season,
	 * because that is how a season is arranged on the disk it is going to.
	 *
	 * Fetching a season produced twenty rows in the queue, each with its own destination,
	 * its own bar and its own three buttons, spread over two pages of a list that announced
	 * a hundred and eighty-seven of them. So "how far is this" was twenty numbers to add up
	 * across two pages, and stopping it was twenty clicks that answered errors. It is one
	 * piece of work made of many files.
	 *
	 * **The download is the gateway's grouping now**, not this screen's. It arrives whole —
	 * every file of it, whatever page they would have fallen on — which is what makes the
	 * percentage, the file count and the actions true. See `TransferLot`.
	 *
	 * **A download is not a run.** The files of one can come from several runs: a season
	 * pulled over three nights is one season. So nothing here reads a run — the destination
	 * is computed from the paths, and an action hands up the download's key.
	 */
	const props = defineProps<{
		lot: TransferLot;
		progress: (transfer: Transfer) => TransferProgress;
		busyId?: string | null;
		/** Set while an action on the whole download is in flight. */
		busyKey?: string | null;
	}>();

	const emit = defineEmits<{
		/** One file, from inside the fold. */
		'action': [action: TransferAction, transfer: Transfer];
		/** The whole download, in one request rather than one per file. */
		'lot-action': [action: 'pause' | 'resume' | 'cancel', key: string];
		/** Send the whole download elsewhere, files already landed included. */
		'retarget': [transfers: Transfer[]];
		/** Rename the folder one season lands in — that folder alone. */
		'rename-season': [seasonNumber: number | null, name: string];
		/** Rename one file, keeping it in its folder. */
		'rename-file': [transfer: Transfer, name: string];
	}>();

	const expanded = ref(false);

	/**
	 * What is being renamed, and to what.
	 *
	 * One field at a time and held here rather than per row, so opening a second closes the
	 * first: two open fields over the same season would be two answers to one question, and
	 * whichever was submitted last would silently win.
	 */
	const renaming = ref<{ key: string; value: string } | null>(null);

	/**
	 * The seasons somebody has opened. Empty to begin with: every season is closed.
	 *
	 * Asked for in those words, and the numbers say why: one card here holds a hundred and
	 * four files, fifty-two of them in one season. Opening the card to be given that list is
	 * the same wall of rows the download itself was split out of — four season headings, one
	 * of which somebody actually wants, is the readable answer.
	 *
	 * Which is only tolerable because a closed season still carries its folder, its count and
	 * its progress: the fold hides the files, not the facts.
	 */
	const open = ref(new Set<string>());

	function toggle (key: string): void {
		if (open.value.has(key)) {
			open.value.delete(key);
		} else {
			open.value.add(key);
		}
	}

	function edit (key: string, current: string): void {
		renaming.value = { key, value: current };
	}

	/** Nothing is sent for a name nobody changed, so confirming twice is harmless. */
	function submitSeason (seasonNumber: number | null, current: string | null): void {
		const asked = renaming.value;

		renaming.value = null;

		if (asked !== null && asked.value.trim() !== '' && asked.value.trim() !== current) {
			emit('rename-season', seasonNumber, asked.value.trim());
		}
	}

	function submitFile (transfer: Transfer): void {
		const asked = renaming.value;

		renaming.value = null;

		if (asked !== null && asked.value.trim() !== '' && asked.value.trim() !== fileNameOf(transfer)) {
			emit('rename-file', transfer, asked.value.trim());
		}
	}

	/** The name on disk, which is not the title: a title is a sentence about the media. */
	function fileNameOf (transfer: Transfer): string {
		return transfer.targetPath.split('/').at(-1) ?? '';
	}

	const transfers = computed(() => props.lot.transfers);

	const bytes = computed(() => transfers.value.reduce(
		(total, one) => {
			const live = props.progress(one);

			return {
				done: total.done + live.bytesDone,
				total: total.total + live.bytesTotal,
			};
		},
		{ done: 0, total: 0 },
	));

	const percent = computed(
		() => (bytes.value.total > 0 ? Math.min(100, (bytes.value.done / bytes.value.total) * 100) : 0));

	const rate = computed(
		() => transfers.value.reduce((total, one) => total + props.progress(one).rate, 0));

	/**
	 * The files of the download that are still on their way onto a media server.
	 *
	 * Kept apart from the states because it outlives them: a transfer is `done` the moment
	 * the last byte is written, and the file only exists for whoever is looking at their
	 * media server once a scan has taken it.
	 *
	 * Read through `?? null` rather than against `null` alone: a gateway answering without
	 * the field at all — an older image — would otherwise have every finished download of
	 * its history counted as still landing.
	 */
	const landing = computed(() => transfers.value.filter(one => (one.landing ?? null) !== null));

	/**
	 * `stale` wins over `waiting` when both are in the download: one file nothing indexed is
	 * the thing somebody has to act on, and a line counting the ones still on schedule would
	 * bury it.
	 */
	const stale = computed(
		() => landing.value.filter(one => one.landing === MediaLandingState.STALE));

	/**
	 * A file counts as done when its bytes are in **and** nothing is still waiting for it to
	 * appear on a media server.
	 *
	 * "11 of 11 files" over a run no server had indexed is the claim that hid this: every
	 * number on the card agreed the work was over, so nobody looked, and the episodes were
	 * never there to play.
	 */
	const finished = computed(() => transfers.value.filter(
		one => props.progress(one).state === TransferState.DONE && (one.landing ?? null) === null,
	).length);

	/**
	 * The folder every file of this download shares, which is where the download lands.
	 *
	 * Computed from the paths rather than stored, because a download has no destination of
	 * its own: each file is placed on its own, and they agree in practice because the
	 * planner pins every file of a lot under one root. Compared by whole path components — a
	 * prefix on the raw strings would call `/mnt/media2` a parent of `/mnt/media`.
	 */
	const destination = computed(() => {
		const parts = transfers.value.map(one => one.targetPath.split('/').slice(0, -1));

		if (parts.length === 0) {
			return null;
		}

		const [first, ...rest] = parts;
		let shared = first;

		for (const other of rest) {
			let index = 0;

			while (index < shared.length && index < other.length && shared[index] === other[index]) {
				index += 1;
			}

			shared = shared.slice(0, index);
		}

		return shared.join('/') || '/';
	});

	/**
	 * The files of the download, in seasons.
	 *
	 * Asked for in those words — "for a series one sees the episodes grouped by season" —
	 * and it is not decoration: twenty files under one card is a list nobody reads, while
	 * four seasons of five is the shape of the thing on the disk. The number comes from the
	 * catalogue and never from the title: see `Transfer.seasonNumber`.
	 *
	 * Sorted by season, which is not the order the files were planned in when a pack brought
	 * several. Everything without a season stays at the end in the order it arrived — a
	 * film, or an episode whose source never declared one.
	 */
	const seasons = computed(() => {
		const groups = new Map<number | null, Transfer[]>();

		for (const transfer of transfers.value) {
			const season = transfer.seasonNumber ?? null;

			groups.set(season, [...(groups.get(season) ?? []), transfer]);
		}

		return [...groups.entries()]
			.map(([seasonNumber, held]) => ({
				key: seasonNumber === null ? 'none' : String(seasonNumber),
				seasonNumber,
				transfers: held,
				/*
				 * The folder this season's files are going into, named rather than implied.
				 * Taken off the paths because that is where it is decided, and shown so that
				 * a season heading answers "and where does this land" without unfolding
				 * every file under it.
				 */
				folder: folderOf(held),
				/*
				 * How far this season has got, on the heading, because the heading is what a
				 * closed season leaves on screen. A fold that hid the progress would trade one
				 * unreadable list for a row of names that answer nothing, and somebody would
				 * open all four seasons every time — which is the state this fold exists to
				 * get out of.
				 */
				...progressOfSeason(held),
			}))
			// `sort` and not `toSorted`: the interface's TypeScript target does not declare the
			// latter, and `map` above has already produced an array of our own to order.
			// eslint-disable-next-line unicorn/no-array-sort
			.sort((left, right) => {
				if (left.seasonNumber === null) {
					return right.seasonNumber === null ? 0 : 1;
				}

				return right.seasonNumber === null ? -1 : left.seasonNumber - right.seasonNumber;
			});
	});

	/** What a season comes to: its bytes, and the files of it that are properly over. */
	function progressOfSeason (held: Transfer[]) {
		const bytes = held.reduce(
			(total, one) => {
				const live = props.progress(one);

				return { done: total.done + live.bytesDone, total: total.total + live.bytesTotal };
			},
			{ done: 0, total: 0 },
		);

		return {
			bytes,
			percent: bytes.total > 0 ? Math.min(100, (bytes.done / bytes.total) * 100) : 0,
			// The same rule as the card's own count: a file whose bytes are in but which no
			// media server has indexed is not finished. See `finished` above.
			done: held.filter(
				one => props.progress(one).state === TransferState.DONE && (one.landing ?? null) === null,
			).length,
		};
	}

	/** The directory a set of files shares, by its own name alone. */
	function folderOf (held: Transfer[]): string | null {
		const folders = new Set(held.map(one => one.targetPath.split('/').slice(0, -1).join('/')));

		if (folders.size !== 1) {
			return null;
		}

		return [...folders][0].split('/').at(-1) ?? null;
	}

	/**
	 * Whether the fold shows season headings at all.
	 *
	 * A film, or a single episode, has one group and no season worth naming: a heading over
	 * it would be a frame around nothing. A series shows them even when it is one season,
	 * because the heading says which.
	 */
	const grouped = computed(
		() => seasons.value.some(one => one.seasonNumber !== null) && transfers.value.length > 1);

	const running = computed(
		() => transfers.value.filter(one => !FINISHED_TRANSFER_STATES.includes(one.state)));

	const paused = computed(
		() => transfers.value.filter(one => one.state === TransferState.PAUSED));

	/**
	 * Stopped, and nothing left moving — which is when resume is the one thing to offer.
	 *
	 * Read over the whole download rather than per file: a season with one file paused and
	 * six running is a season that is running, and a play button on it would be a button
	 * that appears to do nothing.
	 */
	const stopped = computed(() => paused.value.length > 0 && running.value.length === paused.value.length);

	const busy = computed(
		() => props.busyKey === props.lot.key || transfers.value.some(one => one.id === props.busyId));
</script>

<template>
	<v-card class="transfer-batch" data-test="transfer-batch" variant="tonal">
		<v-card-text class="py-3">
			<div class="transfer-batch_head">
				<v-btn
					data-test="transfer-batch-expand"
					:icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
					size="small"
					variant="text"
					@click="expanded = !expanded"
				/>

				<div class="transfer-batch_identity">
					<!--
						The show, not its first episode. A card headed "Les Schtroumpfs — S01E02
						— L'Œuf et les Schtroumpfs" over twenty files reads as one episode that
						has gone wrong, which is how it was read.
					-->
					<strong data-test="transfer-batch-title">{{ lot.title }}</strong>

					<span class="text-caption text-medium-emphasis">
						{{ $t('transfer.batch.files', { done: finished, total: transfers.length }) }}
					</span>
				</div>

				<span class="text-caption text-medium-emphasis">
					<ByteSize :bytes="bytes.done" /> / <ByteSize :bytes="bytes.total" />
				</span>

				<!--
					The rate of the download and not of one file: several files move at once,
					and what somebody wants to know is how fast the season is coming.
				-->
				<span v-if="rate > 0" class="text-caption text-medium-emphasis" data-test="transfer-batch-rate">
					<Rate :rate="rate" />
				</span>
			</div>

			<v-progress-linear
				class="mt-2"
				data-test="transfer-batch-progress"
				height="6"
				:model-value="percent"
				rounded
			/>

			<!--
				The destination once for the download rather than once per file: twenty lines
				saying the same folder is twenty lines nobody reads.
			-->
			<p class="text-caption text-medium-emphasis mt-1 mb-0 text-break-anywhere">
				{{ $t('transfer.batch.into') }}
				<span class="transfer-batch_path" data-test="transfer-batch-path">{{ destination }}</span>
			</p>

			<!--
				Said on the download and not only inside the fold, because the fold is shut: a
				season whose bytes are all in shows a full bar and a closed card, and the files
				nothing indexed would be three clicks away from anybody's attention.
			-->
			<p
				v-if="landing.length > 0"
				class="text-caption mt-1 mb-0"
				:class="stale.length > 0 ? 'text-warning' : 'text-medium-emphasis'"
				:data-landing="stale.length > 0 ? 'stale' : 'waiting'"
				data-test="transfer-batch-landing"
			>
				{{ stale.length > 0
					? $t('transfer.landing.batch_stale', { count: stale.length }, stale.length)
					: $t('transfer.landing.batch_waiting', { count: landing.length }, landing.length) }}
			</p>

			<div class="transfer-batch_actions mt-2">
				<!--
					One request for the whole download, and not one per file. Twenty requests
					racing each other and the engine is how pressing pause on a season came
					back as a column of errors about the files that had finished in between.
				-->
				<v-btn
					v-if="running.length > paused.length"
					data-test="transfer-batch-pause"
					:disabled="busy"
					prepend-icon="mdi-pause"
					size="small"
					variant="text"
					@click="emit('lot-action', 'pause', lot.key)"
				>
					{{ $t('transfer.action.pause') }}
				</v-btn>

				<v-btn
					v-if="stopped"
					color="primary"
					data-test="transfer-batch-resume"
					:disabled="busy"
					prepend-icon="mdi-play"
					size="small"
					variant="tonal"
					@click="emit('lot-action', 'resume', lot.key)"
				>
					{{ $t('transfer.action.resume') }}
				</v-btn>

				<!--
					On the download and not only on each file, because a destination is a
					property of the download: a season redirected file by file ends half in one
					library and half in another, which is the state somebody pressing this is
					trying to get out of. Offered whatever the state — a download that has
					entirely landed is exactly the one worth moving, and the files that landed
					are moved for real rather than left behind.
				-->
				<v-btn
					data-test="transfer-batch-retarget"
					:disabled="busy"
					prepend-icon="mdi-folder-move-outline"
					size="small"
					variant="text"
					@click="emit('retarget', transfers)"
				>
					{{ $t('transfer.retarget.action') }}
				</v-btn>

				<v-btn
					v-if="running.length > 0"
					color="error"
					data-test="transfer-batch-cancel"
					:disabled="busy"
					prepend-icon="mdi-close"
					size="small"
					variant="text"
					@click="emit('lot-action', 'cancel', lot.key)"
				>
					{{ $t('transfer.action.cancel') }}
				</v-btn>
			</div>

			<v-expand-transition>
				<div v-if="expanded" class="transfer-batch_files mt-3">
					<template v-for="season of seasons" :key="season.key">
						<!--
							The season, and the folder it is going into. Two facts on one line
							because they are one question: a season heading that did not say
							where it lands would send somebody unfolding five episodes to read
							the same path five times.
						-->
						<div
							v-if="grouped"
							class="transfer-batch_season"
							:data-open="open.has(season.key) ? 'yes' : 'no'"
							data-test="transfer-batch-season"
						>
							<!--
								Closed to begin with, and every one of them. One card here holds a
								hundred and four files with fifty-two under a single season, so a
								card that opened onto all of them would be the same wall of rows
								the download was split out of.
							-->
							<v-btn
								data-test="transfer-batch-season-toggle"
								:icon="open.has(season.key) ? 'mdi-chevron-up' : 'mdi-chevron-down'"
								size="x-small"
								variant="text"
								@click="toggle(season.key)"
							/>

							<!--
								The label opens it too. A four-pixel chevron is not the target
								somebody aims at, and everything else on this line is either a
								fact or a field.
							-->
							<strong
								class="text-caption transfer-batch_seasonName"
								@click="toggle(season.key)"
							>
								{{ season.seasonNumber === null
									? $t('transfer.batch.no_season')
									: season.seasonNumber === 0
										? $t('transfer.batch.specials')
										: $t('transfer.batch.season', { number: season.seasonNumber }) }}
							</strong>

							<!--
								The folder's name, and the one thing on this card that can be
								typed into. Asked for in those words: the season folder only. The
								show's folder is shared with every other season and with whatever
								was filed there before, so renaming that here would move
								somebody else's episodes.
							-->
							<v-text-field
								v-if="renaming?.key === `season:${season.key}`"
								v-model="renaming.value"
								autofocus
								data-test="transfer-batch-season-field"
								density="compact"
								hide-details
								variant="outlined"
								@blur="submitSeason(season.seasonNumber, season.folder)"
								@keyup.enter="submitSeason(season.seasonNumber, season.folder)"
								@keyup.esc="renaming = null"
							/>

							<template v-else>
								<span
									v-if="season.folder"
									class="transfer-batch_path text-caption text-medium-emphasis"
									data-test="transfer-batch-season-folder"
								>
									{{ season.folder }}
								</span>

								<v-tooltip
									v-if="season.folder"
									location="top"
									:text="$t('transfer.batch.rename_season')"
								>
									<template #activator="{ props: tip }">
										<v-btn
											data-test="transfer-batch-season-rename"
											:disabled="busy"
											icon="mdi-pencil-outline"
											size="x-small"
											variant="text"
											v-bind="tip"
											@click="edit(`season:${season.key}`, season.folder)"
										/>
									</template>
								</v-tooltip>

								<span class="text-caption text-medium-emphasis">
									{{ $t('transfer.batch.files', {
										done: season.done,
										total: season.transfers.length,
									}) }}
								</span>

								<!--
									And its bytes, which is what the fold would otherwise take away:
									a season closed on "5 files" says nothing about whether it is
									nearly here or has not started.
								-->
								<span class="text-caption text-medium-emphasis">
									<ByteSize :bytes="season.bytes.done" /> /
									<ByteSize :bytes="season.bytes.total" />
								</span>

								<v-progress-linear
									class="transfer-batch_seasonBar"
									data-test="transfer-batch-season-progress"
									height="4"
									:model-value="season.percent"
									rounded
								/>
							</template>
						</div>

						<template
							v-for="transfer of (grouped && !open.has(season.key) ? [] : season.transfers)"
							:key="transfer.id"
						>
							<!--
								Compact, because this is a list: the destination and the sources
								belong to the download and are said once above, so what is left on
								the line is what tells one file from the next.

								The rename goes in the row's own `name` slot, beside the file name
								it changes — under the row it read as a control belonging to
								nothing.
							-->
							<TransferRow
								:busy="busyId === transfer.id"
								compact
								:progress="progress(transfer)"
								:transfer="transfer"
								@action="(action, one) => emit('action', action, one)"
							>
								<template #name>
									<v-text-field
										v-if="renaming?.key === `file:${transfer.id}`"
										v-model="renaming.value"
										autofocus
										data-test="transfer-batch-file-field"
										density="compact"
										hide-details
										variant="outlined"
										@blur="submitFile(transfer)"
										@keyup.enter="submitFile(transfer)"
										@keyup.esc="renaming = null"
									/>

									<v-tooltip v-else location="top" :text="$t('transfer.batch.rename_file')">
										<template #activator="{ props: tip }">
											<v-btn
												data-test="transfer-batch-file-rename"
												:disabled="busyId === transfer.id"
												icon="mdi-pencil-outline"
												size="x-small"
												variant="text"
												v-bind="tip"
												@click="edit(`file:${transfer.id}`, fileNameOf(transfer))"
											/>
										</template>
									</v-tooltip>
								</template>
							</TransferRow>
						</template>
					</template>
				</div>
			</v-expand-transition>
		</v-card-text>
	</v-card>
</template>

<style lang="scss">
	.transfer-batch {
		&_head {
			display: flex;
			align-items: center;
			gap: 10px;
		}

		&_identity {
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-width: 0;
		}

		&_path {
			font-family: monospace;
			opacity: 0.85;
		}

		&_actions {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}

		&_files > * + * {
			margin-top: 8px;
		}

		&_seasonName {
			cursor: pointer;
		}

		&_seasonBar {
			/* Last on the line and taking what is left of it, so the headings line up. */
			flex: 1 1 80px;
			min-width: 60px;
			max-width: 200px;
		}

		&_season {
			display: flex;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
			/* Set off from the files under it, so a heading reads as a heading. */
			margin-top: 12px;
			padding-bottom: 2px;
			border-bottom: 1px solid rgb(var(--v-border-color), var(--v-border-opacity));
		}
	}
</style>
