<script lang="ts" setup>
	import type { CoveragePlan, CoverageStep, EpisodeRef, PeerCopy, ReleaseKind } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';

	/**
	 * A way of covering everything that is missing, shown before it is taken.
	 *
	 * The plan is on screen rather than applied quietly because the two ways of filling
	 * four gaps are genuinely different bargains and only the person looking can pick:
	 * one pack is one torrent and one thing to watch, four singles are four files nobody
	 * has to trim. Pressing is a second act.
	 *
	 * Three things are said out loud, and each of them was a support question before it
	 * was a line here. The order, because a step covering six episodes and a step
	 * covering one are not interchangeable. That a step is *partial* — a pack taken for
	 * fewer files than it holds — because the disk bill somebody expects from a season
	 * pack is the season. And what nothing on offer covers, named episode by episode: a
	 * plan that silently dropped two of them is a plan somebody presses, waits for, and
	 * then discovers was never going to finish the season.
	 *
	 * **A plan is tracker releases and nothing else, and it says so by what it cannot
	 * cover.** One press hands every step to the download client, and a copy on a friend's
	 * gateway is not something a download client can be handed — putting one in here would
	 * make one button act on two unrelated machines, and the half that went to the wrong one
	 * would fail without a word. So the plan stays what it is, and where an episode it could
	 * not cover is sitting on a peer, the uncovered list says which: that turns "two of
	 * these are unobtainable" into "two of these are one press away on the list above",
	 * which is the difference between a dead end and an answer.
	 */
	const props = withDefaults(defineProps<{
		plan: CoveragePlan;
		/** True while the steps are being handed to the download client, one after another. */
		grabbing?: boolean;
		/**
		 * The peer copies the same search answered, read only to mark the uncovered.
		 *
		 * Nothing here acts on them. They belong to the list above, which is where they are
		 * pulled from — this is the plan pointing at them rather than absorbing them.
		 */
		peers?: PeerCopy[];
	}>(), {
		grabbing: false,
		peers: () => [],
	});

	const emit = defineEmits<{ grab: []; close: [] }>();

	const covered = computed(
		() => props.plan.steps.reduce((total, step) => total + step.covers.length, 0));

	/** Everything the plan was built against: what it covers plus what it could not. */
	const wanted = computed(() => covered.value + props.plan.uncovered.length);

	/**
	 * `S02E09`, padded the way a release name writes it.
	 *
	 * The coordinate and not the episode's own title, on purpose: the plan is read
	 * against the release names beside it, and `Ariadne` matching `S02E09` is a
	 * comparison nobody can make at a glance.
	 */
	function code (one: { seasonNumber: number | null; episodeNumber: number | null }): string {
		const season = one.seasonNumber === null ? '' : `S${String(one.seasonNumber).padStart(2, '0')}`;
		const episode = one.episodeNumber === null
			? ''
			: `E${String(one.episodeNumber).padStart(2, '0')}`;

		return season + episode;
	}

	function codes (list: EpisodeRef[]): string {
		return list.map(one => code(one)).join(' ');
	}

	function kindLabel (kind: ReleaseKind): string {
		return `release.kind.${kind}`;
	}

	function keyOf (step: CoverageStep, index: number): string {
		// The same release can legitimately appear twice in a plan, so the position is
		// part of the identity: keyed on the identifier alone, two steps would collapse.
		return `${index}:${step.releaseId}`;
	}

	/**
	 * The coordinates of every episode some peer is holding.
	 *
	 * Matched on the coordinate rather than on the item identifier because that is what the
	 * two lists have in common: the plan is built from our own rows and a peer copy fills
	 * our own rows, so either would work — and the coordinate is the one a reader can check
	 * against what is on screen.
	 */
	const onPeers = computed(() => new Set(
		props.peers.flatMap(copy => copy.fills.map(one => code(one))),
	));

	function heldByPeer (one: EpisodeRef): boolean {
		return onPeers.value.has(code(one));
	}

	/** How many of the uncovered a peer could supply, which is what the line says. */
	const uncoveredOnPeers = computed(
		() => props.plan.uncovered.filter(one => heldByPeer(one)).length);
</script>

<template>
	<div class="release-plan" data-test="release-plan">
		<div class="release-plan_head">
			<p class="text-caption text-medium-emphasis mb-0" data-test="release-plan-summary">
				{{ $t('release.plan.summary', {
					steps: plan.steps.length,
					covered,
					total: wanted,
				}) }}
			</p>

			<v-btn
				data-test="release-plan-close"
				size="small"
				variant="text"
				@click="emit('close')"
			>
				{{ $t('release.plan.close') }}
			</v-btn>
		</div>

		<ol v-if="plan.steps.length > 0" class="release-plan_steps">
			<li
				v-for="(step, index) of plan.steps"
				:key="keyOf(step, index)"
				class="release-plan_step"
				:data-covers="step.covers.length"
				:data-partial="step.partial"
				data-test="release-plan-step"
			>
				<span class="release-plan_name">{{ step.title }}</span>

				<div class="release-plan_marks">
					<v-chip label size="x-small" variant="tonal">{{ $t(kindLabel(step.kind)) }}</v-chip>

					<span class="text-caption" data-test="release-plan-covers">
						{{ $t('release.plan.covers', { episodes: codes(step.covers) }) }}
					</span>

					<!--
						A pack taken for fewer files than it holds. Said on the step rather
						than inferred from the kind: the disk bill somebody expects from a
						season pack is the whole season, and this is the line that says it
						will not be.
					-->
					<v-chip
						v-if="step.partial"
						color="warning"
						data-test="release-plan-partial"
						label
						size="x-small"
						variant="tonal"
					>
						{{ $t('release.plan.partial', { count: step.covers.length }) }}
					</v-chip>

					<span v-if="(step.size ?? 0) > 0" class="text-caption text-medium-emphasis">
						<ByteSize :bytes="step.size" />
					</span>

					<span class="text-caption text-medium-emphasis">
						{{ $t('release.seeders', { count: step.seeders ?? 0 }) }}
					</span>
				</div>
			</li>
		</ol>

		<p
			v-else
			class="text-caption text-medium-emphasis mb-0"
			data-test="release-plan-empty"
		>
			{{ $t('release.plan.empty') }}
		</p>

		<!--
			Named episode by episode, never as a count alone: "two we cannot get" sends
			somebody looking for which two, and the plan is the only thing that knows.
		-->
		<div
			v-if="plan.uncovered.length > 0"
			class="release-plan_uncovered"
			:data-count="plan.uncovered.length"
			data-test="release-plan-uncovered"
		>
			<p class="text-caption text-warning mb-1">
				{{ $t('release.plan.uncovered', { count: plan.uncovered.length }) }}
			</p>

			<div class="release-plan_marks">
				<!--
					An episode no release covers but a peer holds is not an episode nobody
					can get, and drawing it like the rest would read as one. Marked rather
					than moved: it is still uncovered *by this plan*, and the plan is what
					this panel is about.
				-->
				<v-chip
					v-for="one of plan.uncovered"
					:key="`${one.itemId}:${code(one)}`"
					:color="heldByPeer(one) ? 'state-in-sync' : undefined"
					:data-on-peer="heldByPeer(one)"
					data-test="release-plan-uncovered-episode"
					label
					:prepend-icon="heldByPeer(one) ? 'mdi-account-outline' : undefined"
					size="x-small"
					:variant="heldByPeer(one) ? 'tonal' : 'outlined'"
				>
					{{ code(one) || one.title }}
				</v-chip>
			</div>

			<p
				v-if="uncoveredOnPeers > 0"
				class="text-caption mb-0 mt-1"
				data-test="release-plan-uncovered-peer"
			>
				{{ $t('release.plan.uncovered_peer', { count: uncoveredOnPeers }, uncoveredOnPeers) }}
			</p>

			<p class="text-caption text-medium-emphasis mb-0 mt-1">
				{{ $t('release.plan.uncovered_hint') }}
			</p>
		</div>

		<v-btn
			class="mt-3"
			color="primary"
			data-test="release-plan-grab"
			:disabled="plan.steps.length === 0"
			:loading="grabbing"
			prepend-icon="mdi-download-multiple"
			size="small"
			@click="emit('grab')"
		>
			{{ $t('release.plan.grab', { count: plan.steps.length }) }}
		</v-btn>
	</div>
</template>

<style lang="scss">
	.release-plan {
		padding: 8px 12px;
		border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
		border-radius: 4px;

		&_head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
		}

		&_steps {
			margin: 8px 0 0;
			padding-left: 20px;
		}

		&_step {
			padding: 4px 0;
		}

		&_marks {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 6px;
		}

		&_name {
			// A release name is long and has no spaces: it has to break rather than widen
			// the panel past the column it sits in.
			font-family: monospace;
			font-size: 12px;
			overflow-wrap: anywhere;
		}

		&_uncovered {
			margin-top: 12px;
		}
	}
</style>
