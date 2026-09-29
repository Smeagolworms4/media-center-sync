<script lang="ts" setup>
	import { SpaceVerdict } from '@mcs/shared';
	import { computed } from 'vue';
	import ByteSize from '@/components/common/ByteSize.vue';
	import Window from '@/components/Window.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useSyncStore } from '@/stores/sync';

	/**
	 * The question the gateway asked and nobody could answer.
	 *
	 * A run whose destination is tight on space is refused until somebody says to go
	 * ahead — and the refusal carries everything needed to decide: every destination, what
	 * is free on it, what the run would write, what would be left. The interface dropped
	 * all of it and showed one sentence saying "confirm to run it anyway", with nothing
	 * anywhere to confirm with. The only way through was to call the API by hand.
	 *
	 * Mounted once in the shell, because every screen that starts a run can hit it: the
	 * library, one media, a plan.
	 */
	const syncStore = useSyncStore();
	const { notify, tryCallback } = useNotifier();

	const open = computed({
		get: () => syncStore.pendingSpace !== null,
		set: (value: boolean) => {
			if (!value) {
				syncStore.dismissSpace();
			}
		},
	});

	const targets = computed(() => syncStore.pendingSpace?.targets ?? []);

	/**
	 * A destination that belongs to none of this gateway's libraries.
	 *
	 * The placement answers one when it has fallen back to a folder rather than a shelf —
	 * a default target path, a folder somebody named — and it matters more than the space
	 * does: nothing scans it, so the files land where no media server will ever see them.
	 * It carries no identifier, which is how it is told apart, and its name is a path
	 * because there is no name to give.
	 */
	const strays = computed(() => targets.value.filter(one => one.libraryId === ''));

	const confirm = tryCallback(async () => {
		const job = await syncStore.confirmSpace();

		if (job !== null) {
			void notify('library.sync_started');
		}
	});
</script>

<template>
	<Window v-model="open" :max-width="640" :title="$t('sync.space.title')">
		<p class="text-body-2 mb-3" data-test="space-intro">
			{{ $t('sync.space.intro') }}
		</p>

		<v-table class="space-dialog_table" density="compact">
			<thead>
				<tr>
					<th>{{ $t('sync.space.target') }}</th>
					<th class="text-right">{{ $t('sync.space.free') }}</th>
					<th class="text-right">{{ $t('sync.space.needed') }}</th>
					<th class="text-right">{{ $t('sync.space.left') }}</th>
				</tr>
			</thead>

			<tbody>
				<tr v-for="one of targets" :key="one.libraryId || one.libraryName" data-test="space-target">
					<td>
						<span :class="one.verdict === SpaceVerdict.INSUFFICIENT ? 'text-error' : undefined">
							{{ one.libraryName }}
						</span>

						<!--
							Said beside the name, because it is the more serious of the two
							things this dialog is about: a folder no library holds is one no
							media server scans, and the files would be invisible however much
							room there is.
						-->
						<span
							v-if="one.libraryId === ''"
							class="text-caption text-warning d-block"
							data-test="space-stray"
						>
							{{ $t('sync.space.not_a_library') }}
						</span>
					</td>

					<td class="text-right">
						<ByteSize v-if="one.freeBytes !== null" :bytes="one.freeBytes" />
						<span v-else>—</span>
					</td>

					<td class="text-right"><ByteSize :bytes="one.requiredBytes" /></td>

					<td class="text-right">
						<ByteSize v-if="one.remainingBytes !== null" :bytes="one.remainingBytes" />
						<span v-else>—</span>
					</td>
				</tr>
			</tbody>
		</v-table>

		<p
			v-if="strays.length > 0"
			class="text-caption text-warning mb-0 mt-2"
			data-test="space-stray-hint"
		>
			{{ $t('sync.space.not_a_library_hint') }}
		</p>

		<template #actions>
			<v-spacer />

			<v-btn data-test="space-cancel" variant="text" @click="open = false">
				{{ $t('actions.cancel') }}
			</v-btn>

			<v-btn
				color="primary"
				data-test="space-confirm"
				variant="flat"
				@click="confirm"
			>
				{{ $t('sync.space.confirm') }}
			</v-btn>
		</template>
	</Window>
</template>

<style lang="scss">
	.space-dialog {
		&_table {
			overflow-wrap: anywhere;
		}
	}
</style>
