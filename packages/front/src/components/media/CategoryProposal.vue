<script lang="ts" setup>
	import type {
		CategoryProposal as Candidate,
		ClassificationEvidence,
		ClassificationProposal,
	} from '@mcs/shared';
	import { computed, ref } from 'vue';
	import { useI18n } from 'vue-i18n';

	/**
	 * Where the gateway thinks this media might belong, offered and never applied.
	 *
	 * The gateway can often tell that something on the `Films` shelf is an anime, or that
	 * a two-hour file called `Live at Wembley` is a concert. Acting on that would be the
	 * worst version of the feature: media moved with nobody having decided, and the only
	 * honest account of it being "some code guessed". So this block is a sentence somebody
	 * is asked to agree with, and agreeing performs the one write the dialog around it
	 * already owns — the override, with the library the suggestion names. There is no
	 * second path and nothing here writes anything.
	 *
	 * **The evidence is on the screen, not behind a disclosure triangle.** That is the
	 * whole safety of the feature rather than a nicety: a suggestion nobody can check is
	 * one people learn to accept without reading, and at that point the filing is
	 * automatic again — by a route nobody chose, which is the one thing the household
	 * ruled out. Somebody asked to agree that this is an anime has to be able to see that
	 * the genre said `Shounen`, and that the other line is only a folder name that may say
	 * nothing but where somebody already put it.
	 *
	 * What was **considered and not suggested** is behind a disclosure, and that is the
	 * one thing that legitimately is: it answers "why is there nothing here", which is a
	 * question somebody asks rather than a fact they have to weigh. Both halves are always
	 * rendered, so "nothing to suggest" can be told apart from a block that failed to load.
	 */
	const props = withDefaults(defineProps<{
		/** Null while it has not been read, or when the route could not answer. */
		proposal: ClassificationProposal | null;
		loading?: boolean;
		failed?: boolean;
		/** The category whose acceptance is in flight, so one press cannot be repeated. */
		accepting?: string | null;
	}>(), {
		loading: false,
		failed: false,
		accepting: null,
	});

	const emit = defineEmits<{ accept: [candidate: Candidate]; retry: [] }>();

	const { t } = useI18n();

	const explaining = ref(false);

	/**
	 * Where it sits today, in one line, so the question reads as "from … to …".
	 *
	 * A media on a shelf whose name this gateway reads as no category at all is the
	 * ordinary case on a library nobody has tidied, and it is the case a suggestion is
	 * most useful for — so it is named rather than left blank.
	 */
	const current = computed(
		() => props.proposal?.currentCategoryName ?? t('classification.current_none'));

	/** Whole percents: a confidence printed to two decimals invites arithmetic nobody can do. */
	function percent (confidence: number): number {
		return Math.round(confidence * 100);
	}

	/**
	 * The shelf a suggestion would file it on, or the category it merely recognised.
	 *
	 * The local name whenever there is one, because that is the word the household uses
	 * for its own shelf. A blocked suggestion has no local shelf by definition, and there
	 * the detected category is the only thing there is to name.
	 */
	function nameOf (candidate: { category: string; categoryName?: string | null }): string {
		return candidate.categoryName ?? t(`classification.category.${candidate.category}`);
	}

	/**
	 * What the blocker's sentence is about, which is not the same thing in all three cases.
	 *
	 * `no_such_category` is the one where there *is* no local shelf, so the word in the
	 * sentence has to be the detected category — the household is being told what to
	 * create. The other two name a shelf that exists and cannot be written to, or the one
	 * the media is already on.
	 */
	function blockerValue (candidate: Candidate): string {
		return candidate.blocker === 'no_such_category'
			? t(`classification.category.${candidate.category}`)
			: nameOf(candidate);
	}

	/** Counter-evidence, whose own sentence already begins "Against:". */
	function against (evidence: ClassificationEvidence): boolean {
		return evidence.weight < 0;
	}
</script>

<template>
	<div class="category-proposal" data-test="category-proposal">
		<p class="text-subtitle-2 mb-1">{{ $t('classification.title') }}</p>

		<p class="text-caption text-medium-emphasis mb-2">{{ $t('classification.intro') }}</p>

		<div v-if="loading" class="py-2">
			<v-progress-circular color="primary" indeterminate size="20" />
		</div>

		<!--
			A failure is said and retried here rather than taken up to the dialog: the rest
			of the correction is perfectly usable without a suggestion, and a route that
			cannot answer must not stand between somebody and the title they came to fix.
		-->
		<div v-else-if="failed" class="category-proposal_failed">
			<span class="text-caption" data-test="category-proposal-failed">
				{{ $t('classification.failed') }}
			</span>

			<v-btn
				data-test="category-proposal-retry"
				prepend-icon="mdi-refresh"
				size="small"
				variant="text"
				@click="emit('retry')"
			>
				{{ $t('classification.reread') }}
			</v-btn>
		</div>

		<template v-else-if="proposal">
			<p class="text-caption text-medium-emphasis mb-2" data-test="category-proposal-current">
				{{ $t('classification.current', { value: current }) }}
			</p>

			<p
				v-if="proposal.proposals.length === 0"
				class="text-body-2 mb-0"
				data-test="category-proposal-none"
			>
				{{ $t('classification.none') }}
			</p>

			<div
				v-for="candidate of proposal.proposals"
				:key="candidate.category"
				class="category-proposal_item"
				:class="{ 'category-proposal_item--blocked': candidate.blocker !== null }"
				:data-test="`category-proposal-item-${candidate.category}`"
			>
				<div class="category-proposal_head">
					<strong class="text-body-2">
						{{ $t('classification.move', { from: current, to: nameOf(candidate) }) }}
					</strong>

					<v-chip
						:data-test="`category-proposal-confidence-${candidate.category}`"
						label
						size="x-small"
						variant="tonal"
					>
						{{ $t('classification.confidence', { value: percent(candidate.confidence) }) }}
					</v-chip>

					<!--
						No button at all on a blocked suggestion, rather than a disabled one:
						`libraryId` is null exactly when `blocker` is set, so there is nothing
						to write, and a greyed button says "later" where the sentence beside it
						says what to go and create.
					-->
					<v-btn
						v-if="candidate.blocker === null"
						class="category-proposal_accept"
						color="primary"
						:data-test="`category-proposal-accept-${candidate.category}`"
						:loading="accepting === candidate.category"
						prepend-icon="mdi-folder-move-outline"
						size="small"
						variant="tonal"
						@click="emit('accept', candidate)"
					>
						{{ $t('classification.accept') }}
					</v-btn>
				</div>

				<p
					v-if="candidate.blocker !== null"
					class="text-caption mb-1"
					:data-test="`category-proposal-blocker-${candidate.category}`"
				>
					{{ $t(`classification.blocker.${candidate.blocker}`, { value: blockerValue(candidate) }) }}
				</p>

				<!--
					Beside the proposal and never behind a fold. See the block comment above:
					evidence somebody has to open is evidence somebody stops opening, and a
					suggestion accepted unread is an automatic move by another name.
				-->
				<ul
					class="category-proposal_evidence"
					:data-test="`category-proposal-evidence-${candidate.category}`"
				>
					<li
						v-for="one of candidate.evidence"
						:key="`${one.signal}-${one.value}`"
						class="text-caption"
						:class="{ 'category-proposal_against': against(one) }"
						:data-test="`category-proposal-signal-${candidate.category}-${one.signal}`"
					>
						{{ $t(`classification.signal.${one.signal}`, { value: one.value }) }}

						<v-chip class="ml-1" label size="x-small" variant="text">
							{{ $t(`classification.source.${one.source}`) }}
						</v-chip>
					</li>
				</ul>
			</div>

			<!--
				The only thing here that is legitimately behind a disclosure: it answers "why
				is there nothing to accept", which is a question somebody asks rather than a
				fact they have to weigh before agreeing to anything. It is always offered, so
				an empty answer can be told apart from a route that failed.
			-->
			<div v-if="proposal.withheld.length > 0" class="category-proposal_withheld">
				<v-btn
					:append-icon="explaining ? 'mdi-chevron-up' : 'mdi-chevron-down'"
					data-test="category-proposal-withheld-toggle"
					size="small"
					variant="text"
					@click="explaining = !explaining"
				>
					{{ $t('classification.withheld_title') }}
				</v-btn>

				<div v-if="explaining" data-test="category-proposal-withheld">
					<p class="text-caption text-medium-emphasis mb-1">
						{{ $t('classification.withheld_intro') }}
					</p>

					<div
						v-for="candidate of proposal.withheld"
						:key="candidate.category"
						class="category-proposal_item"
						:data-test="`category-proposal-withheld-${candidate.category}`"
					>
						<div class="category-proposal_head">
							<strong class="text-body-2">
								{{ $t(`classification.category.${candidate.category}`) }}
							</strong>

							<span class="text-caption text-medium-emphasis">
								{{ $t('classification.evidence_counts', { count: candidate.evidence.length }) }}
							</span>
						</div>

						<p class="text-caption mb-1">
							{{ $t(`classification.withheld.${candidate.withheld}`) }}
						</p>

						<ul class="category-proposal_evidence">
							<li
								v-for="one of candidate.evidence"
								:key="`${one.signal}-${one.value}`"
								class="text-caption"
								:class="{ 'category-proposal_against': against(one) }"
							>
								{{ $t(`classification.signal.${one.signal}`, { value: one.value }) }}
							</li>
						</ul>
					</div>
				</div>
			</div>
		</template>
	</div>
</template>

<style lang="scss">
	.category-proposal {
		&_failed {
			display: flex;
			align-items: center;
			gap: 8px;
			color: rgb(var(--v-theme-warning));
		}

		&_item {
			border: 1px solid rgb(var(--v-border-color), 0.25);
			border-radius: 6px;
			padding: 6px 10px;
			margin-bottom: 8px;

			// A suggestion nothing can be done with is still shown — it is what tells
			// somebody which shelf to create — and it is dimmed so the list still reads as
			// "these two are offers and that one is a note".
			&--blocked {
				opacity: 0.8;
			}
		}

		&_head {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}

		&_accept {
			margin-left: auto;
		}

		&_evidence {
			margin: 4px 0 0;
			padding-left: 18px;
			color: rgb(var(--v-theme-on-surface-variant));
		}

		// Counter-evidence, whose sentence already begins with "Against:". Coloured as well
		// as worded, because a reason *not* to agree read as a reason to agree is the one
		// misreading that would make somebody file a documentary about anime as an anime.
		&_against {
			color: rgb(var(--v-theme-warning));
		}
	}
</style>
