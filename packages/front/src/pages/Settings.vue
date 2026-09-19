<script lang="ts" setup>
	import { NamingScheme, PlacementStrategy } from '@mcs/shared';
	import { computed, onMounted, reactive, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import CronHint from '@/components/common/CronHint.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import CategoryList from '@/components/library/CategoryList.vue';
	import ShareRateSummary from '@/components/share/ShareRateSummary.vue';
	import { useByteSize } from '@/composables/useByteSize';
	import { useForm } from '@/composables/useForm';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useSettingsStore } from '@/stores/settings';
	import { useSharesStore } from '@/stores/shares';

	defineOptions({ name: 'SettingsPage' });

	/**
	 * The gateway's settings.
	 *
	 * Each field carries one line saying what it actually changes. A setting whose
	 * effect somebody has to guess is a setting they will either leave alone
	 * forever or turn the wrong way once and never revisit.
	 */
	const { t } = useI18n();
	const settingsStore = useSettingsStore();
	const librariesStore = useLibrariesStore();
	const sharesStore = useSharesStore();
	const validators = useValidators();
	const { notify } = useNotifier();
	const { parseByteSize, toByteSizeInput } = useByteSize();

	const loading = ref(true);
	const failed = ref(false);

	const model = reactive({
		placement: PlacementStrategy.BESIDE_EXISTING,
		fixedPath: '',
		naming: NamingScheme.STANDARD,
		pullMetadata: true,
		preferSourceMetadata: false,
		maxParallelTransfers: 2,
		maxConnectionsPerSource: 4,
		chunkSize: '4M',
		downloadRateLimit: '',
		uploadRateLimit: '',
		matchThreshold: 0.8,
		allowFriendsOfFriends: true,
		allowSwarm: true,
		rendezvousUrl: '',
		transferHistoryDays: 30,
		refreshIntervalMinutes: 15,
		fullScanCron: '',
		cacheTtlSeconds: 60,
	});

	function apply (): void {
		const settings = settingsStore.settings;
		if (!settings) {
			return;
		}
		model.placement = settings.placement;
		model.fixedPath = settings.fixedPath ?? '';
		model.naming = settings.naming;
		model.pullMetadata = settings.pullMetadata;
		model.preferSourceMetadata = settings.preferSourceMetadata;
		model.maxParallelTransfers = settings.maxParallelTransfers;
		model.maxConnectionsPerSource = settings.maxConnectionsPerSource;
		model.chunkSize = toByteSizeInput(settings.chunkSize);
		model.downloadRateLimit = toByteSizeInput(settings.downloadRateLimit);
		model.uploadRateLimit = toByteSizeInput(settings.uploadRateLimit);
		model.matchThreshold = settings.matchThreshold;
		model.allowFriendsOfFriends = settings.allowFriendsOfFriends;
		model.allowSwarm = settings.allowSwarm;
		model.rendezvousUrl = settings.rendezvousUrl ?? '';
		model.transferHistoryDays = settings.transferHistoryDays;
		model.refreshIntervalMinutes = settings.refreshIntervalMinutes;
		model.fullScanCron = settings.fullScanCron ?? '';
		model.cacheTtlSeconds = settings.cacheTtlSeconds;
	}

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			await Promise.all([
				settingsStore.load(),
				// Both are conveniences on this page, and both belong to a right this
				// page does not require: a failure leaves their block empty rather
				// than refusing the settings somebody came here to change.
				librariesStore.loadCategories().catch(() => undefined),
				sharesStore.load().catch(() => undefined),
			]);
			apply();
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		void load();
	});

	const fixedPathNeeded = computed(() => model.placement === PlacementStrategy.FIXED_PATH);

	const form = useForm({
		fallbackError: 'error.settings.invalid',
		fields: {
			fixedPath: {
				rules: computed(() => (fixedPathNeeded.value
					? [validators.required(), validators.absolutePath()]
					: [validators.absolutePath()])),
			},
			maxParallelTransfers: { rules: [validators.required(), validators.range({ min: 1, max: 32 })] },
			maxConnectionsPerSource: { rules: [validators.required(), validators.range({ min: 1, max: 16 })] },
			chunkSize: { rules: [validators.required(), validators.byteSize({ min: 65_536 })] },
			downloadRateLimit: { rules: [validators.byteSize()] },
			uploadRateLimit: { rules: [validators.byteSize()] },
			matchThreshold: { rules: [validators.range({ min: 0, max: 1 })] },
			rendezvousUrl: { rules: [validators.url()] },
			transferHistoryDays: { rules: [validators.range({ min: 0, max: 3650 })] },
			refreshIntervalMinutes: { rules: [validators.range({ min: 1, max: 1440 })] },
			fullScanCron: { rules: [validators.cron()] },
			cacheTtlSeconds: { rules: [validators.range({ min: 0, max: 86_400 })] },
		},
		handle: async () => {
			await settingsStore.save({
				placement: model.placement,
				fixedPath: model.fixedPath || null,
				naming: model.naming,
				pullMetadata: model.pullMetadata,
				preferSourceMetadata: model.preferSourceMetadata,
				maxParallelTransfers: Number(model.maxParallelTransfers),
				maxConnectionsPerSource: Number(model.maxConnectionsPerSource),
				chunkSize: parseByteSize(model.chunkSize) ?? 4 * 1024 * 1024,
				// An empty rate limit is not "no value": it is no cap, which the API
				// expresses as zero.
				downloadRateLimit: parseByteSize(model.downloadRateLimit) ?? 0,
				uploadRateLimit: parseByteSize(model.uploadRateLimit) ?? 0,
				matchThreshold: Number(model.matchThreshold),
				allowFriendsOfFriends: model.allowFriendsOfFriends,
				allowSwarm: model.allowSwarm,
				rendezvousUrl: model.rendezvousUrl || null,
				transferHistoryDays: Number(model.transferHistoryDays),
				refreshIntervalMinutes: Number(model.refreshIntervalMinutes),
				fullScanCron: model.fullScanCron || null,
				cacheTtlSeconds: Number(model.cacheTtlSeconds),
			});
			void notify('settings.saved');
		},
	});

	/**
	 * Each choice is explained under its field rather than inside the menu: the
	 * explanation is what somebody needs while deciding, and it stays readable once
	 * the menu is closed again.
	 */
	const placementItems = computed(() => Object.values(PlacementStrategy).map(value => ({
		value,
		title: t(`settings.placement_value.${value}`),
	})));
	const placementHelp = computed(() => t(`settings.placement_help.${model.placement}`));

	const namingItems = computed(() => Object.values(NamingScheme).map(value => ({
		value,
		title: t(`settings.naming_value.${value}`),
	})));
	const namingHelp = computed(() => t(`settings.naming_help.${model.naming}`));
</script>

<template>
	<div class="page-container settings">
		<PageHeader
			icon="mdi-cog-outline"
			:loading="loading"
			:subtitle="$t('settings.subtitle')"
			:title="$t('pages.settings')"
		/>

		<ErrorState v-if="failed" @retry="load" />

		<v-form v-else v-form="form" data-test="settings-form">
			<v-card class="settings_card">
				<v-card-title class="text-subtitle-1">{{ $t('settings.group.placement') }}</v-card-title>

				<v-card-text>
					<v-select
						v-model="model.placement"
						data-test="settings-placement"
						:hint="placementHelp"
						item-title="title"
						item-value="value"
						:items="placementItems"
						:label="$t('settings.placement')"
						persistent-hint
					/>

					<v-text-field
						v-if="fixedPathNeeded"
						v-model="model.fixedPath"
						v-bind="form.field('fixedPath')"
						data-test="settings-fixed-path"
						:hint="$t('settings.fixed_path_help')"
						:label="$t('settings.fixed_path')"
						persistent-hint
					/>

					<v-select
						v-model="model.naming"
						class="mt-4"
						data-test="settings-naming"
						:hint="namingHelp"
						item-title="title"
						item-value="value"
						:items="namingItems"
						:label="$t('settings.naming')"
						persistent-hint
					/>

					<v-switch
						v-model="model.pullMetadata"
						color="primary"
						density="compact"
						hide-details
						:label="$t('settings.pull_metadata')"
					/>

					<p class="text-caption text-medium-emphasis">{{ $t('settings.pull_metadata_help') }}</p>

					<v-switch
						v-model="model.preferSourceMetadata"
						color="primary"
						density="compact"
						hide-details
						:label="$t('settings.prefer_source_metadata')"
					/>

					<p class="text-caption text-medium-emphasis mb-0">
						{{ $t('settings.prefer_source_metadata_help') }}
					</p>
				</v-card-text>
			</v-card>

			<v-card class="settings_card mt-4">
				<v-card-title class="text-subtitle-1">{{ $t('settings.group.transfers') }}</v-card-title>

				<v-card-text>
					<v-row density="compact">
						<v-col cols="12" sm="6">
							<v-text-field
								v-model.number="model.maxParallelTransfers"
								v-bind="form.field('maxParallelTransfers')"
								data-test="settings-parallel"
								:hint="$t('settings.max_parallel_help')"
								:label="$t('settings.max_parallel')"
								persistent-hint
								type="number"
							/>
						</v-col>

						<v-col cols="12" sm="6">
							<v-text-field
								v-model.number="model.maxConnectionsPerSource"
								v-bind="form.field('maxConnectionsPerSource')"
								:hint="$t('settings.max_connections_help')"
								:label="$t('settings.max_connections')"
								persistent-hint
								type="number"
							/>
						</v-col>

						<v-col cols="12" sm="4">
							<v-text-field
								v-model="model.chunkSize"
								v-bind="form.field('chunkSize')"
								:hint="$t('settings.chunk_size_help')"
								:label="$t('settings.chunk_size')"
								persistent-hint
							/>
						</v-col>

						<v-col cols="12" sm="4">
							<v-text-field
								v-model="model.downloadRateLimit"
								v-bind="form.field('downloadRateLimit')"
								data-test="settings-download-rate"
								:hint="$t('settings.rate_limit_help')"
								:label="$t('settings.download_rate_limit')"
								persistent-hint
							/>
						</v-col>

						<v-col cols="12" sm="4">
							<v-text-field
								v-model="model.uploadRateLimit"
								v-bind="form.field('uploadRateLimit')"
								data-test="settings-upload-rate"
								:hint="$t('settings.upload_rate_limit_help')"
								:label="$t('settings.upload_rate_limit')"
								persistent-hint
							/>
						</v-col>

						<v-col cols="12">
							<!--
								What is in force, not what is in the box above: the caps that
								throttle this gateway are set on two screens, and the one
								somebody is not looking at is the one that surprises them.
							-->
							<ShareRateSummary
								class="settings_rates"
								:policies="sharesStore.policies"
								:upload-rate-limit="settingsStore.settings?.uploadRateLimit ?? 0"
							/>
						</v-col>

						<v-col cols="12" sm="6">
							<v-text-field
								v-model.number="model.transferHistoryDays"
								v-bind="form.field('transferHistoryDays')"
								:hint="$t('settings.history_days_help')"
								:label="$t('settings.history_days')"
								persistent-hint
								type="number"
							/>
						</v-col>
					</v-row>
				</v-card-text>
			</v-card>

			<v-card class="settings_card mt-4">
				<v-card-title class="text-subtitle-1">{{ $t('settings.group.categories') }}</v-card-title>

				<v-card-text>
					<p class="text-body-2 text-medium-emphasis">{{ $t('settings.categories_help') }}</p>

					<CategoryList
						:categories="librariesStore.orderedCategories"
						:loading="loading"
					/>

					<v-btn
						class="mt-2"
						data-test="settings-categories-services"
						prepend-icon="mdi-server-network"
						size="small"
						:to="{ name: 'services' }"
						variant="text"
					>
						{{ $t('settings.categories_edit') }}
					</v-btn>
				</v-card-text>
			</v-card>

			<v-card class="settings_card mt-4">
				<v-card-title class="text-subtitle-1">{{ $t('settings.group.peers') }}</v-card-title>

				<v-card-text>
					<v-switch
						v-model="model.allowFriendsOfFriends"
						color="primary"
						density="compact"
						hide-details
						:label="$t('settings.friends_of_friends')"
					/>

					<p class="text-caption text-medium-emphasis">
						{{ $t('settings.friends_of_friends_help') }}
					</p>

					<v-switch
						v-model="model.allowSwarm"
						color="primary"
						density="compact"
						hide-details
						:label="$t('settings.swarm')"
					/>

					<p class="text-caption text-medium-emphasis">{{ $t('settings.swarm_help') }}</p>

					<v-text-field
						v-model="model.rendezvousUrl"
						v-bind="form.field('rendezvousUrl')"
						:hint="$t('settings.rendezvous_help')"
						:label="$t('settings.rendezvous')"
						persistent-hint
					/>
				</v-card-text>
			</v-card>

			<v-card class="settings_card mt-4">
				<v-card-title class="text-subtitle-1">{{ $t('settings.group.index') }}</v-card-title>

				<v-card-text>
					<p class="text-body-2 mb-1">
						{{ $t('settings.match_threshold') }}: {{ model.matchThreshold }}
					</p>

					<v-slider
						v-model="model.matchThreshold"
						data-test="settings-threshold"
						hide-details
						:max="1"
						:min="0"
						:step="0.05"
					/>

					<p class="text-caption text-medium-emphasis">{{ $t('settings.match_threshold_help') }}</p>

					<v-row density="compact">
						<v-col cols="12" sm="6">
							<v-text-field
								v-model.number="model.refreshIntervalMinutes"
								v-bind="form.field('refreshIntervalMinutes')"
								:hint="$t('settings.refresh_interval_help')"
								:label="$t('settings.refresh_interval')"
								persistent-hint
								type="number"
							/>
						</v-col>

						<v-col cols="12" sm="6">
							<v-text-field
								v-model.number="model.cacheTtlSeconds"
								v-bind="form.field('cacheTtlSeconds')"
								:hint="$t('settings.cache_ttl_help')"
								:label="$t('settings.cache_ttl')"
								persistent-hint
								type="number"
							/>
						</v-col>
					</v-row>

					<v-text-field
						v-model="model.fullScanCron"
						v-bind="form.field('fullScanCron')"
						class="mt-2"
						data-test="settings-full-scan"
						:hint="$t('settings.full_scan_help')"
						:label="$t('settings.full_scan')"
						persistent-hint
						placeholder="0 4 * * *"
					/>

					<CronHint class="mt-2" :expression="model.fullScanCron" />
				</v-card-text>
			</v-card>

			<FormMainError :form="form" />

			<div class="settings_actions mt-4">
				<v-btn
					color="primary"
					data-test="settings-save"
					:loading="form.loading"
					size="large"
					type="submit"
				>
					{{ $t('actions.save') }}
				</v-btn>
			</div>
		</v-form>
	</div>
</template>

<style lang="scss">
	.settings {
		// The caps in force are a statement rather than a field, and it has to be
		// told apart from the inputs above it at a glance.
		&_rates {
			border: 1px solid rgba(var(--v-border-color), 0.2);
			border-radius: 6px;
			padding: 12px 16px;
		}

		&_actions {
			display: flex;
			justify-content: flex-end;
		}
	}
</style>
