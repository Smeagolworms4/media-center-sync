<script lang="ts" setup>
	import { ShareVisibility } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import ShareAudit from '@/components/share/ShareAudit.vue';
	import SharePolicyForm from '@/components/share/SharePolicyForm.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useLibrariesStore } from '@/stores/libraries';
	import { usePeersStore } from '@/stores/peers';
	import { useServicesStore } from '@/stores/services';
	import { useSharesStore } from '@/stores/shares';

	defineOptions({ name: 'SettingsSharesPage' });

	/**
	 * Sharing, decided per library.
	 *
	 * Per library and not per service, because somebody may want their series
	 * visible and their home videos not while both live on the same Jellyfin. A
	 * library with no policy is private: nothing is ever shared by having been
	 * forgotten.
	 */
	const sharesStore = useSharesStore();
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();
	const peersStore = usePeersStore();
	const { notify } = useNotifier();

	const loading = ref(true);
	const failed = ref(false);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			await Promise.all([
				sharesStore.load(),
				librariesStore.load(),
				servicesStore.loaded ? Promise.resolve() : servicesStore.load().catch(() => undefined),
				peersStore.loaded ? Promise.resolve() : peersStore.load().catch(() => undefined),
			]);
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		void load();
	});

	const libraries = computed(() => librariesStore.libraries);

	function serviceName (serviceId: string): string {
		return servicesStore.byId[serviceId]?.name ?? serviceId;
	}

	function visibilityOf (libraryId: string): ShareVisibility {
		return sharesStore.byLibraryId[libraryId]?.visibility ?? ShareVisibility.PRIVATE;
	}

	async function onSaved (): Promise<void> {
		void notify('share.saved');
	}

	async function onRemoved (): Promise<void> {
		void notify('share.made_private');
	}
</script>

<template>
	<div class="page-container settings-shares">
		<PageHeader
			icon="mdi-share-variant-outline"
			:loading="loading"
			:subtitle="$t('share.subtitle')"
			:title="$t('pages.settings_shares')"
		/>

		<ErrorState v-if="failed" @retry="load" />

		<v-row v-else density="compact">
			<v-col cols="12" md="7">
				<v-card>
					<v-card-title class="text-subtitle-1">{{ $t('share.libraries') }}</v-card-title>

					<EmptyState
						v-if="!loading && libraries.length === 0"
						icon="mdi-folder-off-outline"
						:text="$t('share.no_libraries_text')"
						:title="$t('share.no_libraries_title')"
					/>

					<v-expansion-panels v-else class="settings-shares_panels" variant="accordion">
						<v-expansion-panel
							v-for="library of libraries"
							:key="library.id"
							:data-library="library.id"
							data-test="share-library"
						>
							<v-expansion-panel-title data-test="share-library-open">
								<span class="settings-shares_title">
									{{ library.name }}
									<span class="text-caption text-medium-emphasis ml-2">
										{{ serviceName(library.serviceId) }}
									</span>
								</span>

								<v-spacer />

								<v-chip
									class="mr-3"
									:color="visibilityOf(library.id) === ShareVisibility.PRIVATE
										? 'state-unknown'
										: 'state-in-sync'"
									data-test="share-visibility-chip"
									:data-visibility="visibilityOf(library.id)"
									label
									size="small"
									variant="tonal"
								>
									{{ $t(`share.visibility_value.${visibilityOf(library.id)}`) }}
								</v-chip>
							</v-expansion-panel-title>

							<v-expansion-panel-text>
								<SharePolicyForm
									:library="library"
									:peers="peersStore.peers"
									:policy="sharesStore.byLibraryId[library.id] ?? null"
									@removed="onRemoved"
									@saved="onSaved"
								/>
							</v-expansion-panel-text>
						</v-expansion-panel>
					</v-expansion-panels>
				</v-card>
			</v-col>

			<v-col cols="12" md="5">
				<v-card>
					<v-card-title class="text-subtitle-1">{{ $t('share.audit.title') }}</v-card-title>

					<v-card-text>
						<ShareAudit :peers="peersStore.peers" />
					</v-card-text>
				</v-card>
			</v-col>
		</v-row>
	</div>
</template>

<style lang="scss">
	.settings-shares {
		&_title {
			min-width: 0;
		}
	}
</style>
