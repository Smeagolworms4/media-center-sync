<script lang="ts" setup>
	import { DEFAULT_PEER_MAX_DEPTH, MAX_PEER_MAX_DEPTH, NamingScheme, PlacementStrategy, ShareVisibility } from '@mcs/shared';
	import { computed, onMounted, reactive, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import CronHint from '@/components/common/CronHint.vue';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import CategoryList from '@/components/library/CategoryList.vue';
	import CategoryTargetsTable from '@/components/settings/CategoryTargetsTable.vue';
	import DestinationLibraryField from '@/components/settings/DestinationLibraryField.vue';
	import NotificationChannels from '@/components/settings/NotificationChannels.vue';
	import ShareRateSummary from '@/components/share/ShareRateSummary.vue';
	import { useByteSize } from '@/composables/useByteSize';
	import { useDestinationLibraries } from '@/composables/useDestinationLibraries';
	import { useForm } from '@/composables/useForm';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useServicesStore } from '@/stores/services';
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
	const servicesStore = useServicesStore();
	const sharesStore = useSharesStore();
	const validators = useValidators();
	const { notify } = useNotifier();
	const { parseByteSize, toByteSizeInput } = useByteSize();
	const { destinations, rejected } = useDestinationLibraries();

	const loading = ref(true);
	const failed = ref(false);

	const model = reactive({
		placement: PlacementStrategy.BESIDE_EXISTING,
		fixedPath: '',
		categoryTargets: {} as Record<string, string>,
		defaultTargetLibraryId: null as string | null,
		naming: NamingScheme.STANDARD,
		pullMetadata: true,
		writeNfo: false,
		preferSourceMetadata: false,
		maxParallelTransfers: 2,
		maxConnectionsPerSource: 4,
		chunkSize: '4M',
		downloadRateLimit: '',
		uploadRateLimit: '',
		matchThreshold: 0.8,
		peerMaxDepth: DEFAULT_PEER_MAX_DEPTH,
		allowSwarm: true,
		defaultShareVisibility: ShareVisibility.FRIENDS_OF_FRIENDS,
		rendezvousUrl: '',
		instanceName: '',
		publicUrl: '',
		defaultTargetPath: '',
		transferHistoryDays: 30,
		refreshIntervalMinutes: 15,
		fullScanCron: '',
		cacheTtlSeconds: 60,
	});

	/** Empty when there is no browser, which is how the unit tests mount this page. */
	const browserOrigin = typeof window === 'undefined' ? '' : window.location.origin;

	function apply (): void {
		const settings = settingsStore.settings;
		if (!settings) {
			return;
		}
		model.placement = settings.placement;
		model.fixedPath = settings.fixedPath ?? '';
		// Copied rather than referenced: the table replaces the object on every choice,
		// and sharing the store's own would make an unsaved edit look stored everywhere
		// else that reads the settings.
		model.categoryTargets = { ...settings.categoryTargets };
		model.defaultTargetLibraryId = settings.defaultTargetLibraryId ?? null;
		model.naming = settings.naming;
		model.pullMetadata = settings.pullMetadata;
		model.writeNfo = settings.writeNfo;
		model.preferSourceMetadata = settings.preferSourceMetadata;
		model.maxParallelTransfers = settings.maxParallelTransfers;
		model.maxConnectionsPerSource = settings.maxConnectionsPerSource;
		model.chunkSize = toByteSizeInput(settings.chunkSize);
		model.downloadRateLimit = toByteSizeInput(settings.downloadRateLimit);
		model.uploadRateLimit = toByteSizeInput(settings.uploadRateLimit);
		model.matchThreshold = settings.matchThreshold;
		model.peerMaxDepth = settings.peerMaxDepth;
		model.allowSwarm = settings.allowSwarm;
		model.defaultShareVisibility = settings.defaultShareVisibility;
		model.rendezvousUrl = settings.rendezvousUrl ?? '';
		// Offered, never assumed. The browser reached this gateway somehow and that
		// address is almost always the right answer — but a gateway administered over
		// http://192.168.0.12:4200 and reached by friends over a domain name would
		// otherwise announce a private address to everybody, so a caption says where
		// the suggestion came from and saving is what accepts it. A value that is
		// already set is never overwritten: it was chosen deliberately, and this screen
		// is opened from every machine on the network.
		model.instanceName = settings.instanceName ?? '';
		model.publicUrl = settings.publicUrl ?? browserOrigin;
		model.defaultTargetPath = settings.defaultTargetPath ?? '';
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
				// The destination menus are built from these two: a library is only
				// offerable when it is writable and sits on a service of ours, and
				// neither fact is on the category.
				librariesStore.load().catch(() => undefined),
				servicesStore.load().catch(() => undefined),
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

	/**
	 * A gateway still pinned to the old fixed-path strategy.
	 *
	 * The strategy select this section replaced could put every pull into one
	 * directory whatever it was, and a gateway set that way ignores every destination
	 * below. Saying nothing would leave the rule on screen describing something the
	 * gateway is not doing, which is the exact lie this rebuild exists to end — so it
	 * is stated, with the one action that ends it.
	 */
	const fixedPathActive = computed(() => model.placement === PlacementStrategy.FIXED_PATH);

	function useTheRule (): void {
		model.placement = PlacementStrategy.BESIDE_EXISTING;
		model.fixedPath = '';
	}

	/**
	 * What a category with no entry of its own actually does, named.
	 *
	 * A blank cell in a table of destinations reads as broken, so every row says where
	 * its media goes — and that is never "nowhere": it is the next step of the rule.
	 */
	const fallbackTarget = computed(() => {
		const library = destinations.value.find(one => one.id === model.defaultTargetLibraryId);

		if (library) {
			return library.name;
		}

		return model.defaultTargetPath || t('settings.destination.fallback_unset');
	});

	/**
	 * Whether the deployment pinned the reach in its environment.
	 *
	 * The control is disabled and says so rather than being hidden: somebody looking
	 * for this setting has to find out that it exists and that it is decided
	 * elsewhere, otherwise they conclude the gateway has no such limit. The API
	 * refuses a write to it either way — this only stops the screen offering one.
	 */
	const peerDepthPinned = computed(() => settingsStore.pinned.includes('peerMaxDepth'));

	/**
	 * True only while the box still holds the suggestion and nothing has been stored.
	 * It stops explaining itself the moment somebody types their own address, which is
	 * when the explanation would start being wrong.
	 */
	const publicUrlSuggested = computed(
		() => !settingsStore.settings?.publicUrl && model.publicUrl === browserOrigin && browserOrigin !== '',
	);

	const form = useForm({
		fallbackError: 'error.settings.invalid',
		fields: {
			peerMaxDepth: {
				rules: [validators.required(), validators.range({ min: 1, max: MAX_PEER_MAX_DEPTH })],
			},
			maxParallelTransfers: { rules: [validators.required(), validators.range({ min: 1, max: 32 })] },
			maxConnectionsPerSource: { rules: [validators.required(), validators.range({ min: 1, max: 16 })] },
			chunkSize: { rules: [validators.required(), validators.byteSize({ min: 65_536 })] },
			downloadRateLimit: { rules: [validators.byteSize()] },
			uploadRateLimit: { rules: [validators.byteSize()] },
			matchThreshold: { rules: [validators.range({ min: 0, max: 1 })] },
			rendezvousUrl: { rules: [validators.url()] },
			// The same wording the API answers with, so accepting the value on this side
			// and having it refused on the other cannot say two different things.
			publicUrl: {
				rules: computed(() => [validators.urlWithPort({
					requirePort: false,
					message: t('error.settings.public_url_invalid'),
				})]),
			},
			peerAddress: {
				rules: computed(() => [validators.regExp({
					regExp: /^[^\s/]+:\d{1,5}$/,
					message: t('error.settings.peer_address_invalid'),
				})]),
			},
			defaultTargetPath: { rules: [validators.absolutePath()] },
			transferHistoryDays: { rules: [validators.range({ min: 0, max: 3650 })] },
			refreshIntervalMinutes: { rules: [validators.range({ min: 1, max: 1440 })] },
			fullScanCron: { rules: [validators.cron()] },
			cacheTtlSeconds: { rules: [validators.range({ min: 0, max: 86_400 })] },
		},
		handle: async () => {
			await settingsStore.save({
				// Passed through rather than offered: the strategy select is gone, and a
				// gateway somebody once pinned to a fixed path keeps that until they
				// press the button that clears it. Rewriting it here on the first save
				// would change where their files land without anybody asking.
				placement: model.placement,
				fixedPath: model.fixedPath || null,
				categoryTargets: model.categoryTargets,
				defaultTargetLibraryId: model.defaultTargetLibraryId || null,
				naming: model.naming,
				pullMetadata: model.pullMetadata,
				writeNfo: model.writeNfo,
				preferSourceMetadata: model.preferSourceMetadata,
				maxParallelTransfers: Number(model.maxParallelTransfers),
				maxConnectionsPerSource: Number(model.maxConnectionsPerSource),
				chunkSize: parseByteSize(model.chunkSize) ?? 4 * 1024 * 1024,
				// An empty rate limit is not "no value": it is no cap, which the API
				// expresses as zero.
				downloadRateLimit: parseByteSize(model.downloadRateLimit) ?? 0,
				uploadRateLimit: parseByteSize(model.uploadRateLimit) ?? 0,
				matchThreshold: Number(model.matchThreshold),
				peerMaxDepth: Number(model.peerMaxDepth),
				allowSwarm: model.allowSwarm,
				defaultShareVisibility: model.defaultShareVisibility,
				rendezvousUrl: model.rendezvousUrl || null,
				// An emptied box is a setting being cleared, which the API spells null.
				// Empty means "no name of my own", and the hostname stands again.
				instanceName: model.instanceName || null,
				publicUrl: model.publicUrl || null,
				defaultTargetPath: model.defaultTargetPath || null,
				transferHistoryDays: Number(model.transferHistoryDays),
				refreshIntervalMinutes: Number(model.refreshIntervalMinutes),
				fullScanCron: model.fullScanCron || null,
				cacheTtlSeconds: Number(model.cacheTtlSeconds),
			});
			void notify('settings.saved');
		},
	});

	const shareVisibilityItems = computed(() => Object.values(ShareVisibility).map(value => ({
		value,
		title: t(`share.visibility_value.${value}`),
	})));

	const namingItems = computed(() => Object.values(NamingScheme).map(value => ({
		value,
		title: t(`settings.naming_value.${value}`),
	})));
	/**
	 * Each choice is explained under its field rather than inside the menu: the
	 * explanation is what somebody needs while deciding, and it stays readable once
	 * the menu is closed again.
	 */
	const namingHelp = computed(() => t(`settings.naming_help.${model.naming}`));
	/** Whether the folder picker is open for the fallback folder. */
	const browsingDefaultTarget = ref(false);

	/**
	 * The page in tabs, and which fields each one holds.
	 *
	 * The map is not decoration. One form saves every setting at once, so a field the
	 * API refuses can sit on a tab nobody is looking at: the screen would report that
	 * the settings were refused, show no error anywhere visible, and leave somebody
	 * pressing save again. The tab carrying a refused field is marked, and the first
	 * one is opened.
	 */
	const TABS = [
		{
			key: 'placement',
			fields: [
				'placement',
				'fixedPath',
				'categoryTargets',
				'defaultTargetLibraryId',
				'defaultTargetPath',
				'naming',
				'writeNfo',
			],
		},
		{ key: 'gateway', fields: ['instanceName', 'publicUrl', 'rendezvousUrl'] },
		{
			key: 'transfers',
			fields: [
				'maxParallelTransfers',
				'maxConnectionsPerSource',
				'chunkSize',
				'downloadRateLimit',
				'uploadRateLimit',
				'diskReserveBytes',
				'transferHistoryDays',
			],
		},
		{ key: 'categories', fields: [] },
		/*
		 * No fields, for the same reason the categories tab has none.
		 *
		 * A channel is a row with its own routes and its own form, not a setting on
		 * this page's body — so nothing here can be refused, and there is nothing for
		 * a red dot to point at. The tab still has to be declared: `tabsInError`
		 * reads this list, and a pane missing from it is one a refusal could never
		 * open.
		 */
		{ key: 'notifications', fields: [] },
		{ key: 'peers', fields: ['peerMaxDepth', 'allowSwarm', 'defaultShareVisibility'] },
		{
			key: 'index',
			fields: ['refreshIntervalMinutes', 'cacheTtlSeconds', 'fullScanCron', 'matchThreshold'],
		},
	] as const;

	type TabKey = (typeof TABS)[number]['key'];

	const tab = ref<TabKey>(TABS[0].key);

	const tabsInError = computed(() => {
		const refused = new Set(Object.keys(form.fieldErrors ?? {}));

		return new Set(
			TABS.filter(one => one.fields.some(field => refused.has(field))).map(one => one.key),
		);
	});

	// Opened on the first tab that carries a refusal, because the person pressed save
	// and is owed the reason rather than a red dot to go hunting for.
	watch(tabsInError, refused => {
		const first = TABS.find(one => refused.has(one.key));

		if (first && !refused.has(tab.value)) {
			tab.value = first.key;
		}
	});

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
			<!--
				The switch is explicit and the panes are `v-show`, rather than a `v-window`
				driven by the same model as the tabs. Both would work; this has no
				transition, so a pane is either there or not — which is what a journey can
				assert without waiting on an animation, and what made this hard to verify
				by eye the first time round.
			-->
			<v-tabs v-model="tab" class="settings_tabs" data-test="settings-tabs">
				<v-tab
					v-for="one of TABS"
					:key="one.key"
					:data-test="`settings-tab-${one.key}`"
					:value="one.key"
					@click="tab = one.key"
				>
					{{ $t(`settings.group.${one.key}`) }}

					<v-icon
						v-if="tabsInError.has(one.key)"
						class="ml-1"
						color="error"
						data-test="settings-tab-error"
						icon="mdi-alert-circle"
						size="x-small"
					/>
				</v-tab>
			</v-tabs>

			<!--
				Every pane stays mounted. An unmounted field is one the form neither
				validates nor submits, so switching tabs would silently drop whatever had
				been typed on the panes not visited — and `field()` would never be called
				for them, which is what makes a refusal mappable to an input at all.
			-->
			<div v-show="tab === 'placement'">
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">{{ $t('settings.group.placement') }}</v-card-title>

					<v-card-text>
						<!--
							The whole rule, in the order the gateway applies it, before any
							control. A file that lands somewhere the media server never scans
							is a transfer that succeeded and produced nothing, and nobody
							should have to read documentation to find out where theirs went.
						-->
						<div class="settings_rule" data-test="settings-placement-rule">
							<p class="text-body-2 font-weight-medium mb-1">
								{{ $t('settings.destination.rule_title') }}
							</p>

							<ol class="settings_rule-steps text-body-2">
								<li data-test="settings-placement-rule-existing">
									{{ $t('settings.destination.rule_existing') }}
								</li>

								<li>{{ $t('settings.destination.rule_category') }}</li>
								<li>{{ $t('settings.destination.rule_global') }}</li>
								<li>{{ $t('settings.destination.rule_fallback') }}</li>
							</ol>

							<!--
								Said out loud because it is the step people come here angry
								about: their new episode went beside its siblings instead of
								where the table says, and there is no switch for it.
							-->
							<p class="text-caption text-medium-emphasis mt-2 mb-0">
								{{ $t('settings.destination.rule_fixed') }}
							</p>
						</div>

						<v-alert
							v-if="fixedPathActive"
							class="mb-4"
							data-test="settings-fixed-path-active"
							density="compact"
							type="warning"
							variant="tonal"
						>
							{{ $t('settings.destination.fixed_path_active', { path: model.fixedPath }) }}

							<template #append>
								<v-btn
									data-test="settings-fixed-path-clear"
									size="small"
									variant="text"
									@click="useTheRule"
								>
									{{ $t('settings.destination.fixed_path_clear') }}
								</v-btn>
							</template>
						</v-alert>

						<DestinationLibraryField
							v-model="model.defaultTargetLibraryId"
							class="mb-6"
							:destinations="destinations"
							:field="form.field('defaultTargetLibraryId')"
							:loading="loading"
						/>

						<p class="text-body-2 font-weight-medium mb-1">
							{{ $t('settings.destination.table_title') }}
						</p>

						<p class="text-caption text-medium-emphasis">
							{{ $t('settings.destination.table_help') }}
						</p>

						<CategoryTargetsTable
							v-model="model.categoryTargets"
							:categories="librariesStore.orderedCategories"
							:destinations="destinations"
							:fallback="fallbackTarget"
							:loading="loading"
							:rejected="rejected"
						/>

						<v-text-field
							v-model="model.defaultTargetPath"
							v-bind="form.field('defaultTargetPath')"
							class="mt-6"
							data-test="settings-default-target"
							:hint="$t('settings.default_target_help')"
							:label="$t('settings.default_target')"
							persistent-hint
							placeholder="/media/incoming"
						>
							<template #append-inner>
								<v-icon
									class="cursor-pointer"
									data-test="settings-default-target-browse"
									icon="mdi-folder-search-outline"
									:title="$t('browse.open')"
									@click="browsingDefaultTarget = true"
								/>
							</template>
						</v-text-field>

						<!--
							The field stays the authority and the picker only assists it: a
							path on a disk that is not mounted yet cannot be browsed to and
							is a perfectly legitimate thing to type.
						-->
						<DirectoryPicker
							v-model="browsingDefaultTarget"
							:path="model.defaultTargetPath"
							@choose="model.defaultTargetPath = $event"
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
							v-model="model.writeNfo"
							color="primary"
							data-test="settings-write-nfo"
							density="compact"
							hide-details
							:label="$t('settings.write_nfo')"
						/>

						<p class="text-caption text-medium-emphasis">{{ $t('settings.write_nfo_help') }}</p>

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

			</div>

			<div v-show="tab === 'gateway'">
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">{{ $t('settings.group.gateway') }}</v-card-title>

					<v-card-text>
						<v-text-field
							v-model="model.instanceName"
							v-bind="form.field('instanceName')"
							data-test="settings-instance-name"
							:hint="$t('settings.instance_name_help')"
							:label="$t('settings.instance_name')"
							persistent-hint
							:placeholder="$t('settings.instance_name_placeholder')"
						/>

						<v-text-field
							v-model="model.publicUrl"
							class="mt-4"
							v-bind="form.field('publicUrl')"
							data-test="settings-public-url"
							:hint="$t('settings.public_url_help')"
							:label="$t('settings.public_url')"
							persistent-hint
							placeholder="https://mcs.example.org"
						/>

						<!--
						Where the value in the box came from, said out loud. Without it the
						suggestion reads as something the gateway already knew about itself,
						and nobody checks a fact they were never told was a guess.
					-->
						<p
							v-if="publicUrlSuggested"
							class="text-caption text-medium-emphasis mt-1 mb-0"
							data-test="settings-public-url-suggested"
						>
							{{ $t('settings.public_url_suggested', { origin: browserOrigin }) }}
						</p>

					</v-card-text>
				</v-card>

			</div>

			<div v-show="tab === 'transfers'">
				<v-card class="settings_card">
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

			</div>

			<div v-show="tab === 'categories'">
				<v-card class="settings_card">
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

			</div>

			<div v-show="tab === 'notifications'">
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">
						{{ $t('settings.group.notifications') }}
					</v-card-title>

					<v-card-text>
						<!--
							Its own component, and its own API: nothing in this block is part
							of the settings form above, so saving the page neither writes nor
							discards anything here.
						-->
						<NotificationChannels />
					</v-card-text>
				</v-card>
			</div>

			<div v-show="tab === 'peers'">
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">{{ $t('settings.group.peers') }}</v-card-title>

					<v-card-text>
						<v-text-field
							v-model.number="model.peerMaxDepth"
							v-bind="form.field('peerMaxDepth')"
							data-test="settings-peer-depth"
							:disabled="peerDepthPinned"
							:hint="peerDepthPinned
								? $t('settings.peer_max_depth_pinned')
								: $t('settings.peer_max_depth_help')"
							:label="$t('settings.peer_max_depth')"
							:max="MAX_PEER_MAX_DEPTH"
							min="1"
							persistent-hint
							type="number"
						/>

						<p class="text-caption text-medium-emphasis mt-2">
							{{ $t('settings.peer_max_depth_per_peer') }}
						</p>

						<!--
								The default the shares screen keeps naming. Without a control
								for it, that screen said "the gateway default" with nowhere to
								see or change what it was.

								It reaches only libraries on our own services. One on a
								friend's server stays private whatever this says, because
								sharing it on would spend our bandwidth on an access granted
								to us rather than to the people we would hand it to — that is
								a per-library consent, and a default is not consent.
							-->
						<v-select
							v-model="model.defaultShareVisibility"
							v-bind="form.field('defaultShareVisibility')"
							data-test="settings-default-share"
							:hint="$t('settings.default_share_help')"
							:items="shareVisibilityItems"
							:label="$t('settings.default_share')"
							persistent-hint
						/>

						<p class="text-caption text-medium-emphasis mt-2 mb-4">
							{{ $t('settings.default_share_scope') }}
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

			</div>

			<div v-show="tab === 'index'">
				<v-card class="settings_card">
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

			</div>

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
		// The rule is a statement rather than a control, and the whole section only
		// works if that is legible before anybody touches a select.
		&_rule {
			border: 1px solid rgba(var(--v-border-color), 0.2);
			border-left: 3px solid rgb(var(--v-theme-primary));
			border-radius: 6px;
			padding: 12px 16px;
			margin-bottom: 16px;
		}

		&_rule-steps {
			margin: 0;
			padding-left: 20px;
		}

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
