<script lang="ts" setup>
	import type { DirectoryListing } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import Window from '@/components/Window.vue';
	import { useApiError } from '@/hooks/useApiError';
	import { useFilesystemStore } from '@/stores/filesystem';

	/**
	 * Pointing at a directory instead of spelling one.
	 *
	 * Typing a local path by hand is where this product's worst failure starts: a path
	 * that does not designate the directory the media server reads accepts transfers
	 * the server never sees, and nothing anywhere reports an error. This dialog exists
	 * to remove the typing — it never replaces the field it assists, because a path on
	 * a mount that is not attached yet cannot be browsed to and is a legitimate thing
	 * to enter.
	 *
	 * Single-purpose: it browses, and it hands back the path that was chosen. Which
	 * field that path lands in is the caller's business.
	 */
	const open = defineModel<boolean>({ default: false });

	const props = withDefaults(defineProps<{
		/** Where to open. A path the gateway will not show falls back to a root. */
		path?: string | null;
	}>(), {
		path: null,
	});

	const emit = defineEmits<{ choose: [path: string] }>();

	const filesystem = useFilesystemStore();
	const { parseApiError } = useApiError();

	const listing = ref<DirectoryListing | null>(null);
	const error = ref<string | null>(null);
	const loading = ref(false);
	const includeHidden = ref(false);

	/**
	 * Which request the answer on screen belongs to.
	 *
	 * Two clicks in a row are two calls, and the second one is not guaranteed to come
	 * back last. Without this the dialog can settle on the directory somebody left
	 * rather than the one they opened.
	 */
	let ticket = 0;

	/** Only a directory this gateway can write into is a usable target. */
	const writable = computed(() => listing.value?.writable === true);

	/**
	 * The path, cut at the root it sits under, each step clickable.
	 *
	 * Steps above the root are left out rather than shown and refused: the browse
	 * route answers 403 for them, and a breadcrumb that offers a step somebody is
	 * told off for reads as a bug rather than as the boundary it is.
	 */
	const crumbs = computed(() => {
		const current = listing.value;

		if (current === null) {
			return [];
		}

		const root = current.roots.reduce<string | null>((best, one) => {
			const inside = current.path === one || current.path.startsWith(one.endsWith('/') ? one : `${one}/`);
			// The deepest matching root wins: with a transfer root nested under the
			// media root, the shallower one would hide half the breadcrumb.
			return inside && (best === null || one.length > best.length) ? one : best;
		}, null);

		if (root === null) {
			return [{ label: current.path, path: current.path }];
		}

		const steps = [{ label: root, path: root }];
		let walk = root.replace(/\/$/, '');

		for (const part of current.path.slice(root.length).split('/').filter(Boolean)) {
			walk = `${walk}/${part}`;
			steps.push({ label: part, path: walk });
		}

		return steps;
	});

	/**
	 * Load one directory.
	 *
	 * `orRoot` is what makes opening the dialog safe on a field holding anything at
	 * all: a path outside the roots, on an unmounted disk, or simply mistyped is
	 * refused by the API, and starting on that refusal would be a browser that
	 * refuses to browse. A navigation somebody actually clicked reports its failure.
	 */
	async function load (path?: string | null, orRoot = false): Promise<void> {
		const mine = ++ticket;

		loading.value = true;
		error.value = null;

		try {
			const answer = await filesystem.browse(path, includeHidden.value);

			if (mine === ticket) {
				listing.value = answer;
			}
		} catch (error_) {
			if (mine !== ticket) {
				return;
			}
			if (orRoot) {
				await load(null);
				return;
			}
			const parsed = await parseApiError(error_, {
				fallback: 'error.general',
				mappedFields: new Set<string>(),
			});
			error.value = parsed.mainError;
		} finally {
			if (mine === ticket) {
				loading.value = false;
			}
		}
	}

	// Immediate so that a picker mounted already open still loads: the flag is false
	// everywhere in the application, but a component that only works because of how it
	// happens to be used is one nothing can test.
	watch(open, isOpen => {
		if (isOpen) {
			listing.value = null;
			void load(props.path, true);
		}
	}, { immediate: true });

	watch(includeHidden, () => {
		void load(listing.value?.path ?? props.path);
	});

	function onChoose (): void {
		if (listing.value !== null) {
			emit('choose', listing.value.path);
			open.value = false;
		}
	}
</script>

<template>
	<Window
		v-model="open"
		max-width="720"
		:title="$t('browse.title')"
		window-class="directory-picker"
	>
		<div class="directory-picker_bar">
			<v-btn
				data-test="browse-up"
				:disabled="!listing?.parent"
				icon="mdi-arrow-up"
				size="small"
				:title="$t('browse.up')"
				variant="text"
				@click="load(listing?.parent)"
			/>

			<div class="directory-picker_crumbs" data-test="browse-crumbs">
				<template v-for="(crumb, index) of crumbs" :key="crumb.path">
					<span v-if="index > 0" class="directory-picker_separator">/</span>

					<v-btn
						class="directory-picker_crumb"
						density="compact"
						size="small"
						variant="text"
						@click="load(crumb.path)"
					>
						{{ crumb.label }}
					</v-btn>
				</template>
			</div>
		</div>

		<v-alert
			v-if="error"
			data-test="browse-error"
			density="compact"
			type="warning"
			variant="tonal"
		>
			{{ error }}
		</v-alert>

		<v-list v-else data-test="browse-list" density="compact" max-height="360">
			<v-list-item
				v-for="entry of listing?.entries ?? []"
				:key="entry.path"
				data-test="browse-entry"
				:disabled="!entry.readable"
				:prepend-icon="entry.writable ? 'mdi-folder-outline' : 'mdi-folder-lock-outline'"
				:subtitle="entry.writable ? undefined : $t('browse.not_writable')"
				:title="entry.name"
				@click="load(entry.path)"
			/>

			<v-list-item
				v-if="!loading && (listing?.entries.length ?? 0) === 0"
				data-test="browse-empty"
				:title="$t('browse.empty')"
			/>
		</v-list>

		<p
			v-if="listing?.truncated"
			class="text-caption text-medium-emphasis mt-2"
			data-test="browse-truncated"
		>
			{{ $t('browse.truncated', { count: listing.limit }) }}
		</p>

		<p
			v-if="listing && !writable"
			class="text-caption text-warning mt-2"
			data-test="browse-unwritable"
		>
			{{ $t('browse.current_not_writable') }}
		</p>

		<template #actions>
			<v-switch
				v-model="includeHidden"
				class="ml-2"
				color="primary"
				density="compact"
				hide-details
				:label="$t('browse.show_hidden')"
			/>

			<v-spacer />

			<v-btn data-test="browse-cancel" variant="text" @click="open = false">
				{{ $t('actions.cancel') }}
			</v-btn>

			<v-btn
				color="primary"
				data-test="browse-choose"
				:disabled="!listing || !writable"
				:loading="loading"
				variant="flat"
				@click="onChoose"
			>
				{{ $t('browse.choose') }}
			</v-btn>
		</template>
	</Window>
</template>

<style lang="scss">
	.directory-picker {
		&_bar {
			display: flex;
			align-items: center;
			gap: 4px;
			margin-bottom: 8px;
		}

		&_crumbs {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			min-width: 0;
		}

		&_crumb {
			text-transform: none;
		}

		&_separator {
			opacity: 0.5;
		}
	}
</style>
