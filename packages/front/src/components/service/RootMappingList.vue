<script lang="ts" setup>
	import type { IForm } from '@/composables/useForm';
	import type { RootMapping } from '@mcs/shared';
	import { computed, ref, toRaw } from 'vue';
	import DirectoryPicker from '@/components/common/DirectoryPicker.vue';
	import { useRootMappingSuggestions } from '@/composables/useRootMappings';

	/**
	 * Where a service's files are, for us: one row per disk the server reads.
	 *
	 * A list because the ordinary server has more than one disk — films mounted here
	 * at `/mnt/nas1/movies`, shows at `/mnt/nas2/shows` — and one pair could only
	 * describe that by mapping `/` onto `/`, which is wrong for both. Each row is one
	 * statement in two halves: the prefix as the server reports it, and the same
	 * directory as this gateway reaches it.
	 *
	 * Displays and edits the rows; the rules and the submit belong to the form that
	 * owns it. Each input is bound through `form.field('rootMappings.<row>.<side>')`,
	 * which is the name the API puts on a refusal, so a row the gateway refuses is
	 * marked on the input that is wrong instead of above a form that shows nothing.
	 */
	const mappings = defineModel<RootMapping[]>({ required: true });

	const props = withDefaults(defineProps<{
		form: IForm;
		/** The registered service, whose own folders the server side can walk. */
		serviceId?: string | null;
		/** Every library path the last probe reported, in the server's own words. */
		reported?: readonly string[];
	}>(), {
		serviceId: null,
		reported: () => [],
	});

	const suggestions = useRootMappingSuggestions(() => props.reported, mappings);

	/**
	 * Library roots the probe reported, offered in the server-side picker.
	 *
	 * Only for a service not registered yet: a registered one is asked directly, which
	 * also lets somebody walk below a root. Deduplicated because a server may report
	 * the same folder for two libraries.
	 */
	const reportedRoots = computed(() => props.serviceId === null
		? [...new Set(props.reported.filter(path => path.startsWith('/')))]
		: []);

	/** Whether the server's side has anything to show at all. */
	const serverBrowsable = computed(() => props.serviceId !== null || reportedRoots.value.length > 0);

	/**
	 * A stable key per row, so removing the first of two rows removes its inputs and
	 * not the last ones on screen. An index key would keep the first row's inputs —
	 * their validation state included — and hand them the second row's values.
	 */
	const keys = new WeakMap<RootMapping, number>();
	let nextKey = 0;

	function keyOf (mapping: RootMapping): number {
		const raw = toRaw(mapping);
		let key = keys.get(raw);

		if (key === undefined) {
			key = nextKey++;
			keys.set(raw, key);
		}

		return key;
	}

	function add (remoteRoot = ''): void {
		mappings.value = [...mappings.value, { remoteRoot, localRoot: '' }];
	}

	function remove (index: number): void {
		mappings.value = mappings.value.filter((_, one) => one !== index);
	}

	/** Which row's picker is open, and on which side. */
	const browsing = ref<{ index: number; side: keyof RootMapping } | null>(null);

	const browsingLocal = computed({
		get: () => browsing.value?.side === 'localRoot',
		set: open => {
			if (!open) {
				browsing.value = null;
			}
		},
	});

	const browsingRemote = computed({
		get: () => browsing.value?.side === 'remoteRoot',
		set: open => {
			if (!open) {
				browsing.value = null;
			}
		},
	});

	function onChoose (path: string): void {
		const target = browsing.value;

		if (target !== null && mappings.value[target.index]) {
			mappings.value[target.index][target.side] = path;
		}
	}

	function fieldName (index: number, side: keyof RootMapping): string {
		return `rootMappings.${index}.${side}`;
	}
</script>

<template>
	<div class="root-mappings" data-test="service-mappings">
		<p class="text-subtitle-2 mb-0">{{ $t('service.field.roots') }}</p>

		<p class="text-caption text-medium-emphasis mb-2">
			{{ $t('service.field.roots_hint') }}
		</p>

		<!--
			Said rather than left as an empty space: no row is a real answer — this gateway
			reaches none of the server's files and reads them over HTTP — and somebody who
			expected the server to be a destination needs to read why it is not.
		-->
		<p
			v-if="mappings.length === 0"
			class="text-caption text-medium-emphasis mb-2"
			data-test="service-mappings-empty"
		>
			{{ $t('service.field.roots_none') }}
		</p>

		<v-row
			v-for="(mapping, index) of mappings"
			:key="keyOf(mapping)"
			class="root-mappings_row"
			:data-index="index"
			data-test="service-mapping"
			density="compact"
		>
			<v-col cols="12" sm="6">
				<v-text-field
					v-model="mapping.remoteRoot"
					v-bind="form.field(fieldName(index, 'remoteRoot'))"
					data-test="service-mapping-remote"
					:hint="$t('service.field.remote_root_hint')"
					:label="$t('service.field.remote_root')"
					persistent-hint
				>
					<template v-if="serverBrowsable" #append-inner>
						<v-icon
							class="cursor-pointer"
							data-test="service-mapping-remote-browse"
							icon="mdi-server"
							:title="$t('service.field.remote_root_browse')"
							@click="browsing = { index, side: 'remoteRoot' }"
						/>
					</template>
				</v-text-field>
			</v-col>

			<v-col cols="12" sm="6">
				<v-text-field
					v-model="mapping.localRoot"
					v-bind="form.field(fieldName(index, 'localRoot'))"
					data-test="service-mapping-local"
					:hint="$t('service.field.local_root_hint')"
					:label="$t('service.field.local_root')"
					persistent-hint
				>
					<template #append-inner>
						<v-icon
							class="cursor-pointer"
							data-test="service-mapping-local-browse"
							icon="mdi-folder-search-outline"
							:title="$t('browse.open')"
							@click="browsing = { index, side: 'localRoot' }"
						/>
					</template>

					<template #append>
						<v-btn
							data-test="service-mapping-remove"
							density="comfortable"
							icon="mdi-close"
							size="small"
							:title="$t('service.field.roots_remove')"
							variant="text"
							@click="remove(index)"
						/>
					</template>
				</v-text-field>
			</v-col>
		</v-row>

		<div class="root-mappings_actions">
			<!--
				What the server itself answered, offered rather than typed. This is the half
				of each mapping nobody should have to remember, and getting it wrong is
				invisible until a transfer lands somewhere the server never scans.
			-->
			<v-btn
				v-for="root of suggestions"
				:key="root"
				data-test="service-mapping-suggestion"
				density="compact"
				prepend-icon="mdi-server"
				size="small"
				variant="text"
				@click="add(root)"
			>
				{{ $t('service.field.remote_root_reported', { path: root }) }}
			</v-btn>

			<v-btn
				data-test="service-mapping-add"
				density="compact"
				prepend-icon="mdi-plus"
				size="small"
				variant="tonal"
				@click="add()"
			>
				{{ $t('service.field.roots_add') }}
			</v-btn>
		</div>

		<!--
			The gateway's side: this disk, with the server's folders above it when there
			is a server to ask, so the dialog shows both halves of the mapping at once.
		-->
		<DirectoryPicker
			v-model="browsingLocal"
			:path="browsing ? mappings[browsing.index]?.localRoot : null"
			:reported-roots="reportedRoots"
			:service-id="serviceId"
			@choose="onChoose"
		/>

		<!-- The server's side: its folders only, never this disk's. -->
		<DirectoryPicker
			v-model="browsingRemote"
			:reported-roots="reportedRoots"
			server-only
			:service-id="serviceId"
			@choose="onChoose"
		/>
	</div>
</template>

<style lang="scss">
	.root-mappings {
		&_actions {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
		}
	}
</style>
