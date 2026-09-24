<script lang="ts" setup>
	import type { ReleasePreference, ReleasePreferenceSettings, RootMapping, UpdateSettingsRequest } from '@mcs/shared';
	import { DEFAULT_NAMING_ORDER, DEFAULT_PEER_MAX_DEPTH, DEFAULT_RELEASE_PREFERENCES, DownloadClientType, IndexerType, MAX_PEER_MAX_DEPTH, PlacementStrategy, RequestSourceType, ShareVisibility } from '@mcs/shared';
	import { computed, onMounted, reactive, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import CronHint from '@/components/common/CronHint.vue';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import RootMappingList from '@/components/service/RootMappingList.vue';
	import CategoryMapping from '@/components/settings/CategoryMapping.vue';
	import DestinationLibraryField from '@/components/settings/DestinationLibraryField.vue';
	import NamingOrderField from '@/components/settings/NamingOrderField.vue';
	import NotificationChannels from '@/components/settings/NotificationChannels.vue';
	import ReleasePreferences from '@/components/settings/ReleasePreferences.vue';
	import RequestSource from '@/components/settings/RequestSource.vue';
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
	const { destinations } = useDestinationLibraries();

	/*
	 * The form is not on screen until the stored values are in, rather than on
	 * screen and overwritten when they arrive.
	 *
	 * It used to be both. Against a gateway slow after a restart, somebody typed a
	 * value, the load landed, `apply()` put the stored one back over it, and save
	 * then sent the whole screen as it was stored — a full PATCH that changed nothing
	 * visible and turned every default that had no row into an explicit row. No
	 * route removes a settings row, so a key nobody chose became a choice for good.
	 *
	 * Hiding was preferred over the two alternatives. Disabled controls would sit
	 * there showing this file's defaults as though they were the gateway's values,
	 * and the buttons inside the custom fields (the naming order, the folder picker)
	 * do not inherit a form's disabled state, so some of it would stay clickable.
	 * Tracking which fields were touched and sparing them from a late load keeps the
	 * screen editable, but every field then carries a second state that the next
	 * field added here must remember to join. A page with nothing to type into
	 * cannot lose what was typed.
	 */
	const loading = ref(true);
	const failed = ref(false);

	/**
	 * A preference the page owns outright, down to the last list of values.
	 *
	 * Copied for the reason the naming order and the category table are, and one level
	 * deeper because this value is nested: the editor replaces whatever it touches, and
	 * sharing the store's own object would make an unsaved reordering look stored
	 * everywhere else that reads the settings — including the media screen, which reads
	 * the household order to say which level decided an ordering.
	 */
	function copyPreferences (source: ReleasePreferenceSettings): ReleasePreferenceSettings {
		const one = (preference: ReleasePreference): ReleasePreference => ({
			ranks: preference.ranks.map(rank => ({ dimension: rank.dimension, values: [...rank.values] })),
		});

		return {
			global: one(source.global),
			byCategory: Object.fromEntries(
				Object.entries(source.byCategory).map(([key, preference]) => [key, one(preference)]),
			),
		};
	}

	const model = reactive({
		placement: PlacementStrategy.BESIDE_EXISTING,
		fixedPath: '',
		categoryTargets: {} as Record<string, string>,
		defaultTargetLibraryId: null as string | null,
		namingOrder: [...DEFAULT_NAMING_ORDER],
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
		keepDiscoveredPeers: false,
		relayForPeers: false,
		allowSwarm: true,
		defaultShareVisibility: ShareVisibility.FRIENDS_OF_FRIENDS,
		instanceName: '',
		publicUrl: '',
		defaultTargetPath: '',
		transferHistoryDays: 30,
		failedHistoryDays: 180,
		refreshIntervalMinutes: 15,
		fullScanCron: '',
		cacheTtlSeconds: 60,
		/*
		 * Flat rather than two nested objects, because the form helpers key on a field
		 * name and a refusal has to land under the box it names. They are folded back
		 * into the shape the API takes in `toRequest`.
		 *
		 * The two secrets are blank on every load and that is deliberate: the gateway
		 * never sends them back, so a blank box means "keep what is stored" and the
		 * switch beside it says whether there is anything to keep.
		 */
		indexerEnabled: false,
		indexerUrl: '',
		indexerApiKey: '',
		indexerHasKey: false,
		clientEnabled: false,
		clientUrl: '',
		clientUsername: '',
		clientPassword: '',
		clientHasPassword: false,
		/*
		 * The same statement a media service makes about its disks, and deliberately the
		 * same shape: one row per folder, the client's prefix and ours. Two flat fields
		 * were a second vocabulary for one idea, and could only describe a client writing
		 * to two disks by mapping `/` onto `/`.
		 */
		clientRootMappings: [] as RootMapping[],
		/*
		 * The request source, flat for the reason the two above are: a refusal has to land
		 * under the box it names, and the form helpers key on a field name.
		 *
		 * Its key is write-only like the other two — the gateway never sends one back — so
		 * the box is blank on every load and `requestHasKey` is what lets the pane say
		 * that one is nonetheless stored.
		 */
		requestEnabled: false,
		requestUrl: '',
		requestApiKey: '',
		requestHasKey: false,
		/*
		 * Nested, unlike everything above, because it is one value and not a form: an
		 * order over dimensions and an order inside each. Flattening it would mean a field
		 * per dimension, which is precisely the shape the setting exists to avoid — three
		 * named fields cannot say "source decides before codec".
		 */
		releasePreferences: copyPreferences(DEFAULT_RELEASE_PREFERENCES),
	});

	type SettingsModel = typeof model;

	/** The model as the API spells it: byte counts, numbers, and null for an emptied box. */
	function toRequest (values: SettingsModel): UpdateSettingsRequest {
		return {
			// Passed through rather than offered: the strategy select is gone, and a
			// gateway somebody once pinned to a fixed path keeps that until they
			// press the button that clears it. Rewriting it here on the first save
			// would change where their files land without anybody asking.
			placement: values.placement,
			fixedPath: values.fixedPath || null,
			categoryTargets: values.categoryTargets,
			defaultTargetLibraryId: values.defaultTargetLibraryId || null,
			namingOrder: values.namingOrder,
			pullMetadata: values.pullMetadata,
			writeNfo: values.writeNfo,
			preferSourceMetadata: values.preferSourceMetadata,
			maxParallelTransfers: Number(values.maxParallelTransfers),
			maxConnectionsPerSource: Number(values.maxConnectionsPerSource),
			chunkSize: parseByteSize(values.chunkSize) ?? 4 * 1024 * 1024,
			// An empty rate limit is not "no value": it is no cap, which the API
			// expresses as zero.
			downloadRateLimit: parseByteSize(values.downloadRateLimit) ?? 0,
			uploadRateLimit: parseByteSize(values.uploadRateLimit) ?? 0,
			matchThreshold: Number(values.matchThreshold),
			peerMaxDepth: Number(values.peerMaxDepth),
			keepDiscoveredPeers: values.keepDiscoveredPeers,
			relayForPeers: values.relayForPeers,
			allowSwarm: values.allowSwarm,
			defaultShareVisibility: values.defaultShareVisibility,
			// An emptied box is a setting being cleared, which the API spells null.
			// Empty means "no name of my own", and the hostname stands again.
			/*
			 * Sent only when an address was typed, and cleared to null when it was
			 * emptied. A half-filled object would be an indexer the gateway believes in
			 * and cannot reach, which fails at search time rather than at save time.
			 */
			indexer: values.indexerUrl.trim()
				? {
					type: IndexerType.PROWLARR,
					baseUrl: values.indexerUrl.trim(),
					// Blank keeps the stored one. The gateway does the keeping, because
					// this screen has never been told what it is.
					...(values.indexerApiKey ? { apiKey: values.indexerApiKey } : {}),
					enabled: values.indexerEnabled,
				}
				: null,
			downloadClient: values.clientUrl.trim()
				? {
					type: DownloadClientType.QBITTORRENT,
					baseUrl: values.clientUrl.trim(),
					username: values.clientUsername || null,
					...(values.clientPassword ? { password: values.clientPassword } : {}),
					rootMappings: values.clientRootMappings,
					enabled: values.clientEnabled,
				}
				: null,
			/*
			 * Sent only when an address was typed, and cleared to null when it was emptied,
			 * exactly like the two above. A half-filled object would be a source the
			 * gateway believes in and cannot read, which fails when somebody opens the
			 * requests screen rather than when they saved this one.
			 */
			requestSource: values.requestUrl.trim()
				? {
					type: RequestSourceType.SEERR,
					baseUrl: values.requestUrl.trim(),
					// Blank keeps the stored one, and the gateway does the keeping: this
					// screen has never been told what it is.
					...(values.requestApiKey ? { apiKey: values.requestApiKey } : {}),
					enabled: values.requestEnabled,
				}
				: null,
			/*
			 * Sent whole, both halves, because the row is replaced rather than merged — a
			 * cancelled override *is* a missing key, and there is no other way to say it.
			 * The API refuses half of this value for the same reason.
			 */
			releasePreferences: values.releasePreferences,
			instanceName: values.instanceName || null,
			publicUrl: values.publicUrl || null,
			defaultTargetPath: values.defaultTargetPath || null,
			transferHistoryDays: Number(values.transferHistoryDays),
			failedHistoryDays: Number(values.failedHistoryDays),
			refreshIntervalMinutes: Number(values.refreshIntervalMinutes),
			fullScanCron: values.fullScanCron || null,
			cacheTtlSeconds: Number(values.cacheTtlSeconds),
		};
	}

	/**
	 * A request, frozen as JSON per key.
	 *
	 * Serialised rather than kept as values because the table and the naming order
	 * are objects the model may share: a baseline holding the same array would
	 * change along with the edit and report nothing changed.
	 */
	function snapshot (values: SettingsModel): Record<string, string> {
		return Object.fromEntries(
			Object.entries(toRequest(values)).map(([key, value]) => [key, JSON.stringify(value)]),
		);
	}

	/** What the gateway holds, as this page last read or wrote it. */
	let baseline: Record<string, string> = {};

	/**
	 * Only the fields that differ from what is stored.
	 *
	 * The other half of the overwritten-edit defect. The API writes a row for every
	 * key a PATCH carries, whatever its value, and the settings table is sparse on
	 * purpose: a key with no row follows the default, so a gateway picks up a better
	 * default with the next image. Sending the whole screen pinned every default on
	 * the first save anybody made, for a single changed box — and no route removes a
	 * row, so that could not be undone from here.
	 */
	function changes (): UpdateSettingsRequest {
		const next = snapshot(model);

		return Object.fromEntries(
			Object.entries(toRequest(model)).filter(([key]) => next[key] !== baseline[key]),
		) as UpdateSettingsRequest;
	}

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
		// Copied for the reason the table above it is: the field replaces the array on
		// every move, and sharing the store's own would make an unsaved reordering look
		// stored everywhere else that reads the settings.
		model.namingOrder = [...settings.namingOrder];
		model.pullMetadata = settings.pullMetadata;
		model.writeNfo = settings.writeNfo;
		model.indexerEnabled = settings.indexer?.enabled ?? false;
		model.indexerUrl = settings.indexer?.baseUrl ?? '';
		// Never filled from the answer: the gateway does not send it, and a box that
		// looked filled would be a box somebody cleared by retyping the address.
		model.indexerApiKey = '';
		model.indexerHasKey = settings.indexer?.hasApiKey ?? false;
		model.clientEnabled = settings.downloadClient?.enabled ?? false;
		model.clientUrl = settings.downloadClient?.baseUrl ?? '';
		model.clientUsername = settings.downloadClient?.username ?? '';
		model.clientPassword = '';
		model.clientHasPassword = settings.downloadClient?.hasPassword ?? false;
		// Copied rather than referenced, for the reason the naming order above is: the
		// list is replaced on every edit, and sharing the store's own would make an
		// unsaved row look stored everywhere else that reads the settings.
		model.clientRootMappings = [...(settings.downloadClient?.rootMappings ?? [])];
		model.requestEnabled = settings.requestSource?.enabled ?? false;
		model.requestUrl = settings.requestSource?.baseUrl ?? '';
		// Never filled from the answer, for the reason the indexer's key is not: the
		// gateway does not send it, and a box that looked filled would be a key somebody
		// cleared by retyping the address.
		model.requestApiKey = '';
		model.requestHasKey = settings.requestSource?.hasApiKey ?? false;
		// A gateway that has never been asked about this answers the default, and the
		// default separates nothing — which is the honest starting point: seeders and size
		// still decide until somebody says otherwise.
		model.releasePreferences = copyPreferences(
			settings.releasePreferences ?? DEFAULT_RELEASE_PREFERENCES,
		);
		model.preferSourceMetadata = settings.preferSourceMetadata;
		model.maxParallelTransfers = settings.maxParallelTransfers;
		model.maxConnectionsPerSource = settings.maxConnectionsPerSource;
		model.chunkSize = toByteSizeInput(settings.chunkSize);
		model.downloadRateLimit = toByteSizeInput(settings.downloadRateLimit);
		model.uploadRateLimit = toByteSizeInput(settings.uploadRateLimit);
		model.matchThreshold = settings.matchThreshold;
		model.peerMaxDepth = settings.peerMaxDepth;
		model.keepDiscoveredPeers = settings.keepDiscoveredPeers;
		model.relayForPeers = settings.relayForPeers;
		model.allowSwarm = settings.allowSwarm;
		model.defaultShareVisibility = settings.defaultShareVisibility;
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
		model.failedHistoryDays = settings.failedHistoryDays;
		model.refreshIntervalMinutes = settings.refreshIntervalMinutes;
		model.fullScanCron = settings.fullScanCron ?? '';
		model.cacheTtlSeconds = settings.cacheTtlSeconds;
		// Taken from the model rather than from the store, so that a value the
		// round trip through a text box reshapes (a chunk size read back as `4M`)
		// compares equal to itself. The address is the one exception: the box may
		// hold the browser's origin as a suggestion, and saving is what accepts it,
		// so the baseline is what is actually stored.
		baseline = snapshot({ ...model, publicUrl: settings.publicUrl ?? '' });
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
				// The names plugged into each category, which is the other half of the
				// same answer: without them the mapping card can show what folded but
				// not what folded it, and so offers nothing to undo.
				librariesStore.loadKeywords().catch(() => undefined),
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
	 * What a category with no destination of its own actually does, named.
	 *
	 * An empty select with nothing under it reads as broken, so every category says
	 * where its media goes — and that is never "nowhere": it is the next step of the
	 * rule.
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
			failedHistoryDays: { rules: [validators.range({ min: 0, max: 3650 })] },
			refreshIntervalMinutes: { rules: [validators.range({ min: 1, max: 1440 })] },
			fullScanCron: { rules: [validators.cron()] },
			cacheTtlSeconds: { rules: [validators.range({ min: 0, max: 86_400 })] },
		},
		handle: async () => {
			const patch = changes();

			// Nothing is sent rather than an empty PATCH, and the person is told so:
			// a "saved" for a request that stored nothing would read as the gateway
			// having accepted something.
			if (Object.keys(patch).length === 0) {
				void notify('settings.nothing_changed');
				return;
			}

			await settingsStore.save(patch);
			baseline = snapshot(model);
			void notify('settings.saved');
		},
	});

	const shareVisibilityItems = computed(() => Object.values(ShareVisibility).map(value => ({
		value,
		title: t(`share.visibility_value.${value}`),
	})));

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
				'namingOrder',
				'writeNfo',
			],
		},
		{ key: 'gateway', fields: ['instanceName', 'publicUrl'] },
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
				'failedHistoryDays',
			],
		},
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
		{
			key: 'peers',
			fields: [
				'peerMaxDepth',
				'keepDiscoveredPeers',
				'relayForPeers',
				'allowSwarm',
				'defaultShareVisibility',
			],
		},
		{
			key: 'index',
			fields: ['refreshIntervalMinutes', 'cacheTtlSeconds', 'fullScanCron', 'matchThreshold'],
		},
		{ key: 'releases', fields: ['indexer', 'downloadClient', 'requestSource'] },
		/*
		 * A tab of its own, which is what was asked for and is also the only shape that
		 * works: the household order and the per-category overrides are three levels of
		 * one answer and belong on one pane together, and that pane is already the longest
		 * thing on this screen. Hanging it under "Search & downloads" would put an order
		 * over five dimensions below two addresses and a list of path mappings, where
		 * nobody scrolling for a key would ever read it.
		 */
		{ key: 'preferences', fields: ['releasePreferences'] },
	] as const;

	type TabKey = (typeof TABS)[number]['key'];

	const tab = ref<TabKey>(TABS[0].key);

	// `refusedFields` and not `fieldErrors`, because half the refusals on this screen
	// never reach the API: the depth, the parallel transfers and the chunk size all
	// carry a rule of their own, and a value those refuse stops the submit dead. Read
	// only the backend's answer and the commonest refusal of all marks nothing — save
	// pressed on the placement pane, the depth refused on the peers pane, and a screen
	// that says nothing anywhere visible.
	const tabsInError = computed(() => {
		const refused = form.refusedFields ?? new Set<string>();

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

		<div v-else-if="loading" class="text-center py-10" data-test="settings-loading">
			<v-progress-circular color="primary" indeterminate size="36" />
		</div>

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

								<!--
									Not a setting on this page, and listed anyway: leaving it
									out would describe an order the gateway does not follow, on
									the one screen people open to find out why a file went
									where it did.
								-->
								<li data-test="settings-placement-rule-plan">
									{{ $t('settings.destination.rule_plan') }}
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

						<!--
							The second half of the same rule, stated the same way: the folders
							are decided above, the name is decided here, and both are chains
							whose steps are readable before anything is touched.
						-->
						<NamingOrderField
							v-model="model.namingOrder"
							class="mt-6"
							:loading="loading"
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

				<!--
					The merge the table above is built on, shown here rather than behind a
					tab of its own. It held one list and a link, and a tab somebody opens
					to find a link is a tab that teaches them the screen is bigger than it
					is. Setting a correspondence and then hunting for what it did is how a
					setting gets changed twice and understood never.
				-->
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">{{ $t('settings.group.categories') }}</v-card-title>

					<v-card-text>
						<p class="text-body-2 text-medium-emphasis">
							{{ $t('settings.categories_mapping_help') }}
						</p>

						<CategoryMapping
							v-model="model.categoryTargets"
							:categories="librariesStore.orderedCategories"
							:destinations="destinations"
							:fallback="fallbackTarget"
							:keywords="librariesStore.keywords"
							:loading="loading"
						/>
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

							<v-col cols="12" sm="6">
								<!--
									Its own window, and much longer. A transfer that failed three
									weeks ago is the answer to "why is this series incomplete",
									and the same window as a success would destroy the answer
									before anybody thought to ask the question.
								-->
								<v-text-field
									v-model.number="model.failedHistoryDays"
									v-bind="form.field('failedHistoryDays')"
									:hint="$t('settings.failed_history_days_help')"
									:label="$t('settings.failed_history_days')"
									persistent-hint
									type="number"
								/>
							</v-col>
						</v-row>
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

						<!--
							Said here and nowhere else, because this is where somebody
							changes it. The number is a consent, not a search radius:
							being reachable at that distance *is* the agreement, so
							lowering it narrows who can open a link to this gateway rather
							than narrowing what it looks through. It is also the only reach
							control there is — there is no address in the middle to point
							at, and nothing else to fill in.
						-->
						<p class="text-caption text-medium-emphasis mt-2">
							{{ $t('settings.peer_max_depth_consent') }}
						</p>

						<p class="text-caption text-medium-emphasis mt-1">
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
							{{ $t('settings.default_share_note') }}
						</p>

						<!--
							Sits beside the reach, because the two are the same subject read
							twice: the reach decides how far somebody may be and still open a
							link here, and this decides whether the link survives the file it
							was opened for.
						-->
						<v-switch
							v-model="model.keepDiscoveredPeers"
							color="primary"
							data-test="settings-keep-discovered"
							density="compact"
							hide-details
							:label="$t('settings.keep_discovered_peers')"
						/>

						<p class="text-caption text-medium-emphasis mb-4">
							{{ $t('settings.keep_discovered_peers_help') }}
						</p>

						<!--
							Below the reach as well, and for the same reason: this is the
							other half of "who may use this gateway". The reach says who may
							reach us; this says whether we spend our own upload so that two
							friends who cannot reach each other can.
						-->
						<v-switch
							v-model="model.relayForPeers"
							color="primary"
							data-test="settings-relay-for-peers"
							density="compact"
							hide-details
							:label="$t('settings.relay_for_peers')"
						/>

						<p class="text-caption text-medium-emphasis mb-4">
							{{ $t('settings.relay_for_peers_help') }}
						</p>

						<v-switch
							v-model="model.allowSwarm"
							color="primary"
							density="compact"
							hide-details
							:label="$t('settings.swarm')"
						/>

						<p class="text-caption text-medium-emphasis">{{ $t('settings.swarm_help') }}</p>
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

			<div v-show="tab === 'releases'">
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">{{ $t('settings.group.releases') }}</v-card-title>

					<v-card-text>
						<p class="text-caption text-medium-emphasis mb-4">
							{{ $t('settings.releases.intro') }}
						</p>

						<v-switch
							v-model="model.indexerEnabled"
							color="primary"
							data-test="settings-indexer-enabled"
							density="compact"
							hide-details
							:label="$t('settings.releases.indexer_enabled')"
						/>

						<v-text-field
							v-model="model.indexerUrl"
							data-test="settings-indexer-url"
							density="compact"
							:label="$t('settings.releases.indexer_url')"
							placeholder="http://prowlarr:9696"
							v-bind="form.field('indexer')"
						/>

						<!--
							Blank means "keep the stored one". The gateway never sends a key
							back, so a box that looked filled would be a key somebody cleared
							by retyping the address above it.
						-->
						<v-text-field
							v-model="model.indexerApiKey"
							autocomplete="off"
							data-test="settings-indexer-key"
							density="compact"
							:hint="model.indexerHasKey ? $t('settings.releases.key_set') : undefined"
							:label="$t('settings.releases.indexer_key')"
							persistent-hint
							type="password"
						/>

						<v-divider class="my-6" />

						<v-switch
							v-model="model.clientEnabled"
							color="primary"
							data-test="settings-client-enabled"
							density="compact"
							hide-details
							:label="$t('settings.releases.client_enabled')"
						/>

						<v-text-field
							v-model="model.clientUrl"
							data-test="settings-client-url"
							density="compact"
							:label="$t('settings.releases.client_url')"
							placeholder="http://qbittorrent:8080"
							v-bind="form.field('downloadClient')"
						/>

						<v-text-field
							v-model="model.clientUsername"
							autocomplete="off"
							data-test="settings-client-username"
							density="compact"
							:hint="$t('settings.releases.client_username_hint')"
							:label="$t('settings.releases.client_username')"
							persistent-hint
						/>

						<v-text-field
							v-model="model.clientPassword"
							autocomplete="off"
							class="mt-4"
							data-test="settings-client-password"
							density="compact"
							:hint="model.clientHasPassword ? $t('settings.releases.key_set') : undefined"
							:label="$t('settings.releases.client_password')"
							persistent-hint
							type="password"
						/>

						<!--
							The same correspondence a media server declares, through the same
							component: a client in its own container writes to `/downloads`
							and the gateway reaches that directory somewhere else entirely.
							Get it wrong and every step succeeds while the file is never
							filed, which is why it is asked for here rather than guessed.
						-->
						<p class="text-caption text-medium-emphasis mt-6 mb-2">
							{{ $t('settings.releases.paths_help') }}
						</p>

						<RootMappingList
							v-model="model.clientRootMappings"
							data-test="settings-client-mappings"
							:form="form"
						/>
					</v-card-text>
				</v-card>

				<!--
					Its own card on the same pane, rather than a fourth block inside the one
					above. It sits here because it is configured exactly like the other two —
					an address, a key, a switch — and separated because it is the one that
					moves nothing: it reads what the household asked for and hands over no
					bytes, which the card has to make plain or somebody will expect a request
					to start a download.
				-->
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">{{ $t('settings.request.title') }}</v-card-title>

					<v-card-text>
						<RequestSource
							v-model:api-key="model.requestApiKey"
							v-model:base-url="model.requestUrl"
							v-model:enabled="model.requestEnabled"
							:field="form.field('requestSource')"
							:has-api-key="model.requestHasKey"
							:loading="loading"
						/>
					</v-card-text>
				</v-card>
			</div>

			<div v-show="tab === 'preferences'">
				<v-card class="settings_card">
					<v-card-title class="text-subtitle-1">{{ $t('settings.group.preferences') }}</v-card-title>

					<v-card-text>
						<!--
							The categories are every category the gateway knows, ours and a
							peer's alike: this orders a search and never decides where a file
							lands, so a shelf we cannot write into is still one somebody can
							have an opinion about.
						-->
						<ReleasePreferences
							v-model="model.releasePreferences"
							:categories="librariesStore.orderedCategories"
							:loading="loading"
						/>
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

		// Stuck to the bottom of the viewport rather than sitting at the end of the
		// page. These panes are long — the placement one runs to a dozen controls and
		// the categories list grows with every library anybody registers — so the save
		// button spent most of its life below the fold. Somebody who changes a select
		// halfway down, sees no way to confirm it and navigates away loses the change
		// silently, which is the worst outcome a settings screen has available.
		//
		// The background is not decoration: without it the content scrolls visibly
		// underneath the button and the bar reads as part of the page rather than as
		// a fixed control.
		&_actions {
			display: flex;
			position: sticky;
			bottom: 0;
			z-index: 2;
			justify-content: flex-end;
			margin-inline: -16px;
			padding: 12px 16px;
			border-top: 1px solid rgba(var(--v-border-color), 0.2);
			background: rgb(var(--v-theme-surface));
		}
	}
</style>
