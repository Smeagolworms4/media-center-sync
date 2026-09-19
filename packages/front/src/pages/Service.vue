<script lang="ts" setup>
	import type { MediaService } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import LibraryNameField from '@/components/library/LibraryNameField.vue';
	import LibraryPathField from '@/components/library/LibraryPathField.vue';
	import ServiceStatusChip from '@/components/service/ServiceStatusChip.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useLibrariesStore } from '@/stores/libraries';
	import { useServicesStore } from '@/stores/services';

	defineOptions({ name: 'ServicePage' });

	/**
	 * One service, and the directories its libraries point at.
	 *
	 * The writability of each local path is stated here rather than left to be
	 * discovered: a library the gateway cannot write into accepts transfers the
	 * media server will never see, and nothing anywhere else reports an error —
	 * the files really do arrive, in a directory nobody is watching.
	 */
	const props = defineProps<{ id: string }>();

	const servicesStore = useServicesStore();
	const librariesStore = useLibrariesStore();
	const { notify, tryCallback } = useNotifier();

	const service = ref<MediaService | null>(null);
	const loading = ref(true);
	const failed = ref(false);
	const busy = ref(false);

	async function load (): Promise<void> {
		loading.value = true;
		failed.value = false;
		try {
			const [loaded] = await Promise.all([
				servicesStore.get(props.id),
				librariesStore.load(),
				librariesStore.loadChecks().catch(() => undefined),
				// The merged categories are what an alias and a position actually
				// change, so this screen can say what each edit did rather than send
				// somebody to the library screen to find out.
				librariesStore.loadCategories().catch(() => undefined),
			]);
			service.value = loaded;
		} catch {
			failed.value = true;
		} finally {
			loading.value = false;
		}
	}

	onMounted(() => {
		void load();
	});

	const libraries = computed(() => librariesStore.ofService(props.id));

	const unwritable = computed(() => libraries.value.filter(
		one => !(librariesStore.checkById[one.id]?.writable ?? one.writable)));

	const probe = tryCallback(async () => {
		busy.value = true;
		try {
			const result = await servicesStore.probeService(props.id);
			service.value = servicesStore.byId[props.id] ?? service.value;
			void notify(
				result.reachable && result.authenticated ? 'service.probe.ok_short' : 'service.probe.failed',
				result.reachable && result.authenticated ? 'success' : 'error',
			);
		} finally {
			busy.value = false;
		}
	});

	const scan = tryCallback(async () => {
		busy.value = true;
		try {
			await servicesStore.scan(props.id);
			void notify('service.scan_started');
		} finally {
			busy.value = false;
		}
	});

	const refresh = tryCallback(async () => {
		busy.value = true;
		try {
			await servicesStore.refresh(props.id);
			void notify('service.refresh_started');
		} finally {
			busy.value = false;
		}
	});

	async function onLibrarySaved (): Promise<void> {
		void notify('library.saved');
	}
</script>

<template>
	<div class="page-container service">
		<ErrorState v-if="failed" @retry="load" />

		<template v-else>
			<PageHeader
				icon="mdi-server"
				:loading="loading"
				:subtitle="service?.baseUrl ?? null"
				:title="service?.name ?? $t('pages.service')"
			>
				<template #actions>
					<v-btn :loading="busy" variant="text" @click="probe">
						{{ $t('service.action.probe') }}
					</v-btn>

					<v-btn :loading="busy" variant="text" @click="refresh">
						{{ $t('service.action.refresh') }}
					</v-btn>

					<v-btn color="primary" :loading="busy" variant="tonal" @click="scan">
						{{ $t('service.action.scan') }}
					</v-btn>
				</template>
			</PageHeader>

			<v-card v-if="service">
				<v-card-text class="service_details">
					<ServiceStatusChip :status="service.status" />

					<v-chip label size="small" variant="tonal">
						{{ $t(`service.scope.${service.scope}`) }}
					</v-chip>

					<v-chip label size="small" variant="tonal">{{ service.type }}</v-chip>

					<v-chip v-if="service.version" label size="small" variant="tonal">
						{{ service.version }}
					</v-chip>

					<v-chip label size="small" variant="tonal">
						{{ $t('service.field.priority') }}: {{ service.priority }}
					</v-chip>

					<span class="text-caption text-medium-emphasis">
						{{ $t('service.last_scan') }} <RelativeDate :date="service.lastScanAt" />
						· {{ $t('service.last_probe') }} <RelativeDate :date="service.lastProbeAt" />
					</span>
				</v-card-text>
			</v-card>

			<v-alert
				v-if="unwritable.length > 0"
				class="mt-4"
				data-test="service-unwritable"
				type="warning"
				variant="tonal"
			>
				{{ $t('library.unwritable_warning', { count: unwritable.length }) }}
			</v-alert>

			<v-card class="mt-4">
				<v-card-title class="text-subtitle-1">{{ $t('library.title') }}</v-card-title>

				<v-card-subtitle class="text-caption text-wrap">{{ $t('library.naming_help') }}</v-card-subtitle>

				<v-card-text>
					<EmptyState
						v-if="!loading && libraries.length === 0"
						icon="mdi-folder-off-outline"
						:text="$t('library.empty_service_text')"
						:title="$t('library.empty_service_title')"
					/>

					<template v-else>
						<div
							v-for="(library, index) of libraries"
							:key="library.id"
							class="service_library"
							data-test="service-library"
						>
							<v-divider v-if="index > 0" class="mb-4" />

							<!--
								The path first, because it carries the library's own heading:
								an alias box above the name of the library it renames reads as
								a form for nothing in particular.
							-->
							<LibraryPathField
								:check="librariesStore.checkById[library.id] ?? null"
								:library="library"
								@saved="onLibrarySaved"
							/>

							<LibraryNameField
								:category="librariesStore.categoryOfLibrary[library.id] ?? null"
								:library="library"
								@saved="onLibrarySaved"
							/>
						</div>
					</template>
				</v-card-text>
			</v-card>
		</template>
	</div>
</template>

<style lang="scss">
	.service {
		&_library + &_library {
			margin-top: 8px;
		}

		&_details {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}
	}
</style>
