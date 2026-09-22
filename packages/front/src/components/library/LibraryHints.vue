<script lang="ts" setup>
	import type { LibraryHint } from '@mcs/shared';
	import { LibraryHintKind, LibraryLayoutSignal } from '@mcs/shared';
	import { computed } from 'vue';

	/**
	 * One line each for the two ways this gateway can be set up that make the library
	 * read wrongly.
	 *
	 * Both exist only to be seen. The gateway is behaving correctly in both cases — a
	 * media server that reads a folder of shows as one show has been mirrored faithfully,
	 * and a row nothing here can reach really is missing — so nothing anywhere else says
	 * a word about either. The owner spent an evening finding out why two of his series
	 * were invisible, and a development gateway with no folders mapped reads thirty-one
	 * thousand rows of "missing" with nothing explaining it.
	 *
	 * The wording is a suspicion, never a verdict: real shows do name their seasons, so
	 * the line says what looks odd and what to check rather than what is wrong. The
	 * folder one can be put away for good; the mount one cannot, because it goes on its
	 * own the moment a single mapping exists and a dismissal would silence the one line
	 * that explains the whole screen.
	 */
	const props = defineProps<{
		hints: LibraryHint[];
		/** Whether this viewer may change a setting, which is what a dismissal is. */
		dismissable?: boolean;
	}>();

	defineEmits<{ dismiss: [key: string] }>();

	/**
	 * Only the kinds this version knows how to word.
	 *
	 * A gateway one version ahead answers a kind this interface has no sentence for,
	 * and a row rendered with no sentence is a blank warning nobody can act on — worse,
	 * reaching into fields it does not carry takes the whole library screen down with a
	 * render error. Unknown kinds are simply not drawn, so a newer gateway degrades to
	 * the hints this build understands.
	 */
	const KNOWN = new Set<string>([LibraryHintKind.NOTHING_MOUNTED, LibraryHintKind.MISREAD_FOLDER]);

	const ordered = computed(() => {
		const known = props.hints.filter(one => KNOWN.has(one.kind));

		return [
			// The gateway-wide one first, because it explains every row underneath it: told
			// that a show looks odd while nothing at all is mounted, somebody would go and
			// investigate the show.
			...known.filter(one => one.kind === LibraryHintKind.NOTHING_MOUNTED),
			...known.filter(one => one.kind !== LibraryHintKind.NOTHING_MOUNTED),
		];
	});

	/**
	 * Where a person goes to act on either line: the services screen.
	 *
	 * The same destination for both, and not by accident. Declaring a server's folders
	 * and correcting a library root that sits one level too high are the same screen and
	 * the same two fields — the difference is which of them to change, and that is what
	 * the sentence above the button is for.
	 */
	const SERVICES = { name: 'services' };

	/**
	 * Which sentence a suspicion gets, from the signal that produced it.
	 *
	 * Two sentences rather than one that covers both, because the two are checked
	 * differently by whoever reads them: "its seasons are named like shows" sends
	 * somebody to look at a folder, "it claims forty-one seasons" sends them to look at
	 * a count. One sentence saying both would be wrong by half whenever only one fired.
	 */
	function wording (hint: LibraryHint): string {
		return (hint.signals ?? []).includes(LibraryLayoutSignal.NAMED_SEASONS)
			? 'library.hint.misread_named'
			: 'library.hint.misread_many';
	}
</script>

<template>
	<div v-if="ordered.length > 0" class="library-hints" data-test="library-hints">
		<v-alert
			v-for="hint of ordered"
			:key="hint.key"
			class="library-hints_row"
			:data-kind="hint.kind"
			data-test="library-hint"
			density="compact"
			:icon="hint.kind === LibraryHintKind.NOTHING_MOUNTED
				? 'mdi-folder-off-outline'
				: 'mdi-folder-search-outline'"
			:type="hint.kind === LibraryHintKind.NOTHING_MOUNTED ? 'warning' : 'info'"
			variant="tonal"
		>
			<template v-if="hint.kind === LibraryHintKind.NOTHING_MOUNTED">
				<span data-test="library-hint-text">{{ $t('library.hint.nothing_mounted') }}</span>
			</template>

			<template v-else>
				<span data-test="library-hint-text">
					{{ $t(wording(hint), { title: hint.title, count: hint.seasonCount }) }}
				</span>

				<span
					v-if="(hint.examples ?? []).length > 0"
					class="d-block text-caption"
					data-test="library-hint-examples"
				>
					{{ $t('library.hint.misread_examples', { names: hint.examples.join(', ') }) }}
				</span>

				<span class="d-block text-caption">{{ $t('library.hint.misread_remedy') }}</span>
			</template>

			<template #append>
				<v-btn
					data-test="library-hint-fix"
					size="small"
					:to="SERVICES"
					variant="text"
				>
					{{ $t('library.hint.open_services') }}
				</v-btn>

				<v-btn
					v-if="dismissable && hint.kind !== LibraryHintKind.NOTHING_MOUNTED"
					data-test="library-hint-dismiss"
					size="small"
					variant="text"
					@click="$emit('dismiss', hint.key)"
				>
					{{ $t('library.hint.dismiss') }}
				</v-btn>
			</template>
		</v-alert>
	</div>
</template>

<style lang="scss">
	.library-hints {
		&_row + &_row {
			margin-top: 8px;
		}
	}
</style>
