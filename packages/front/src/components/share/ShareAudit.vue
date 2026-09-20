<script lang="ts" setup>
	import type { Peer, ShareAudit } from '@mcs/shared';
	import { ref, watch } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import { useSharesStore } from '@/stores/shares';

	/**
	 * "What would this peer see of me?"
	 *
	 * The question people actually ask before saving, and the only one a list of
	 * visibility rules does not answer: the rules interact — a friend of a friend,
	 * an explicit denial, a catalogue-only library — and the answer is easier to
	 * read than to derive.
	 */
	const props = withDefaults(defineProps<{
		peers?: Peer[];
		peerId?: string | null;
	}>(), {
		peers: () => [],
		peerId: null,
	});

	const sharesStore = useSharesStore();

	const selected = ref<string | null>(props.peerId);
	const audit = ref<ShareAudit | null>(null);
	const loading = ref(false);
	const failed = ref(false);

	async function load (): Promise<void> {
		audit.value = null;
		if (!selected.value) {
			return;
		}
		loading.value = true;
		failed.value = false;
		try {
			audit.value = await sharesStore.audit(selected.value);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	watch(selected, () => {
		void load();
	}, { immediate: true });
</script>

<template>
	<div class="share-audit" data-test="share-audit">
		<v-select
			v-model="selected"
			clearable
			data-test="audit-peer"
			density="compact"
			hide-details
			item-title="name"
			item-value="id"
			:items="peers"
			:label="$t('share.audit.peer')"
		/>

		<div v-if="loading" class="text-center py-4">
			<v-progress-circular color="primary" indeterminate size="28" />
		</div>

		<ErrorState v-else-if="failed" @retry="load" />

		<template v-else-if="audit">
			<p class="text-body-2 mt-3">
				{{ $t('share.audit.intro', { peer: audit.peerName, trust: $t(`peer.trust.${audit.trust}`) }) }}
			</p>

			<EmptyState
				v-if="audit.libraries.length === 0"
				icon="mdi-eye-off-outline"
				:text="$t('share.audit.nothing_text')"
				:title="$t('share.audit.nothing_title')"
			/>

			<v-list v-else density="compact">
				<v-list-item
					v-for="library of audit.libraries"
					:key="library.libraryId"
					data-test="audit-library"
				>
					<v-list-item-title>
						{{ library.name }}

						<!--
							This list is not merged by name, unlike every other library
							screen: it answers what one peer would be served, which is
							decided per library. Two rows called `Movies` are ordinary
							here, and without the server beside them they read as a bug.
						-->
						<v-chip
							v-if="library.serviceName"
							class="ml-2"
							data-test="audit-service"
							label
							size="x-small"
							variant="tonal"
						>
							{{ library.serviceName }}
						</v-chip>
					</v-list-item-title>

					<template #append>
						<span class="text-caption text-medium-emphasis">
							{{ $t('library.item_count', { count: library.itemCount }, library.itemCount) }}
						</span>
					</template>
				</v-list-item>
			</v-list>
		</template>

		<p v-else class="text-caption text-medium-emphasis mt-3 mb-0">
			{{ $t('share.audit.hint') }}
		</p>
	</div>
</template>
