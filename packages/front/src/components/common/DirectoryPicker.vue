<script lang="ts" setup>
	import type { DirectoryListing, ServerDirectory, ServerStructure } from '@mcs/shared';
	import { pathComponents, ServerStructureSupport } from '@mcs/shared';
	import { computed, ref, watch } from 'vue';
	import Window from '@/components/Window.vue';
	import { useApiError } from '@/hooks/useApiError';
	import { useFilesystemStore } from '@/stores/filesystem';
	import { useServicesStore } from '@/stores/services';

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
		/**
		 * The service whose own folders to offer, when there is one to ask.
		 *
		 * Given, the dialog shows two sides: what the media server says its folders
		 * are, and what this gateway sees on its disk. That pair is the mapping being
		 * configured — the server says `/data/media/shows`, the gateway sees
		 * `/mnt/nas/shows` — and the server's half is the authoritative one, which is
		 * why it is shown first and named as the server's.
		 */
		serviceId?: string | null;
		/** Restrict the server's folders to one library's, by the id the service gave. */
		libraryExternalId?: string | null;
		/**
		 * Offer the server's folders and nothing else.
		 *
		 * For the server's side of a root mapping, where this gateway's disk is the
		 * wrong answer by definition: listing it under the server's folders would
		 * invite somebody to fill the server's field with one of our paths, which is
		 * the exact mix-up the two sides of a mapping exist to keep apart.
		 */
		serverOnly?: boolean;
		/**
		 * The library roots a probe reported, for a service not registered yet.
		 *
		 * Such a service has no identifier to ask about its folders, but the probe
		 * already said where its libraries are, and those roots are the server's own
		 * words. Shown as the server's half without a way deeper, because walking needs
		 * a registration to ask through.
		 */
		reportedRoots?: readonly string[];
	}>(), {
		path: null,
		serviceId: null,
		libraryExternalId: null,
		serverOnly: false,
		reportedRoots: () => [],
	});

	const emit = defineEmits<{ choose: [path: string] }>();

	const filesystem = useFilesystemStore();
	const services = useServicesStore();
	const { parseApiError } = useApiError();

	/**
	 * What the server answered, and where inside it we are looking.
	 *
	 * Null while nothing has been asked — no service to ask, or the request failed —
	 * and the section simply does not appear. A failure here is deliberately not shown
	 * as an error: the browse below still works, and an alert about the server would
	 * suggest the dialog is broken when it is merely quieter than usual.
	 */
	const server = ref<ServerStructure | null>(null);
	const serverLoading = ref(false);

	/**
	 * Whether a step into one of the server's folders came back refused.
	 *
	 * Plex is the case this exists for: its browse route answers happily and ignores
	 * the folder asked for, so the handler reports that it cannot walk. Kept as a flag
	 * beside the roots rather than replacing them, because the roots are still the
	 * authoritative half of the mapping and a section that emptied itself the moment
	 * somebody clicked a chevron reads as a broken dialog rather than a limited server.
	 */
	const serverDeadEnd = ref(false);

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

	/** Only the directories: a file is never a destination, and the proof asks apart. */
	const serverEntries = computed<ServerDirectory[]>(
		() => (server.value?.entries ?? []).filter(entry => entry.directory));

	/**
	 * Whether there is a server side to show at all.
	 *
	 * A service that could not be reached takes the whole section away rather than
	 * leaving an empty list under a heading claiming the server reported something:
	 * "no folder in here" about a server that never answered is a lie in the place
	 * where this dialog is meant to be the trustworthy half.
	 */
	const showServer = computed(() => {
		const askable = props.serviceId !== null || props.reportedRoots.length > 0;
		return askable && (server.value !== null || serverLoading.value);
	});

	/** Walking deeper asks the service, which needs one that is registered. */
	const canWalk = computed(() => props.serviceId !== null);

	/**
	 * Whether the server was asked and said it has no way to answer.
	 *
	 * Said out loud rather than shown as an empty list. A peer always answers this,
	 * and so does a media server whose build has no browse route — and somebody who
	 * saw nothing would go looking for the folders the server "should" have reported.
	 */
	const serverSilent = computed(
		() => server.value?.support === ServerStructureSupport.UNSUPPORTED);

	/**
	 * Ask the server where its own folders are.
	 *
	 * Failures leave the section hidden instead of taking the dialog down with them:
	 * the browse underneath is the fallback this assist has always had, and a server
	 * that is asleep must not stop somebody typing the path they already know.
	 */
	async function loadServer (path?: string | null): Promise<void> {
		if (props.serviceId === null) {
			server.value = props.reportedRoots.length === 0
				? null
				: {
					support: ServerStructureSupport.REPORTED,
					path: null,
					parent: null,
					entries: [...new Set(props.reportedRoots)].map(root => ({
						path: root,
						name: pathComponents(root).at(-1) ?? root,
						root: true,
						libraryExternalId: null,
						libraryName: null,
						directory: true,
					})),
				};
			return;
		}

		serverLoading.value = true;

		try {
			const answer = await services.structure(props.serviceId, {
				libraryExternalId: props.libraryExternalId,
				path,
			});

			// A step the server would not take leaves what it did report on screen and
			// says so. Overwriting the roots with "cannot say" would take away the one
			// thing it answered correctly, at the moment somebody asked for more.
			if (answer.support === ServerStructureSupport.UNSUPPORTED && path && server.value) {
				serverDeadEnd.value = true;

				return;
			}

			serverDeadEnd.value = false;
			server.value = answer;
		} catch {
			server.value = null;
		} finally {
			serverLoading.value = false;
		}
	}

	// Immediate so that a picker mounted already open still loads: the flag is false
	// everywhere in the application, but a component that only works because of how it
	// happens to be used is one nothing can test.
	watch(open, isOpen => {
		if (isOpen) {
			listing.value = null;
			server.value = null;
			serverDeadEnd.value = false;
			// The server's side of a mapping never lists this disk, so it is not asked.
			if (!props.serverOnly) {
				void load(props.path, true);
			}
			void loadServer(null);
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

	/**
	 * Take the server's own path as the value.
	 *
	 * Right whenever the gateway and the media server see the same filesystem, which
	 * is the single-machine install and every bind mount that kept the same path. When
	 * they do not — the service in its own container — the browse below is what finds
	 * the other side, and that is exactly the choice this dialog is asking somebody to
	 * make rather than making for them.
	 */
	function onChooseServer (path: string): void {
		emit('choose', path);
		open.value = false;
	}
</script>

<template>
	<Window
		v-model="open"
		max-width="720"
		:title="$t('browse.title')"
		window-class="directory-picker"
	>
		<!--
			The server's side first, because it is the one with authority: these paths
			come from the machine that actually reads the files, while everything below
			is this gateway guessing. Somebody who sees them side by side can read the
			mapping they are configuring; somebody who only sees a folder tree is being
			asked to remember it.
		-->
		<section v-if="showServer" class="directory-picker_server" data-test="browse-server">
			<div class="directory-picker_server-head">
				<v-icon class="mr-2" icon="mdi-server" size="small" />

				<p class="text-subtitle-2 mb-0">{{ $t('browse.server_title') }}</p>

				<v-spacer />

				<v-btn
					v-if="server?.parent"
					data-test="browse-server-up"
					icon="mdi-arrow-up"
					size="x-small"
					:title="$t('browse.up')"
					variant="text"
					@click="loadServer(server?.parent)"
				/>
			</div>

			<!--
				The sentence tying the two halves together, marked because it is the one
				thing that makes the pair readable: two folder lists with no statement of
				how they relate is a dialog showing the same thing twice.
			-->
			<p class="text-caption text-medium-emphasis mb-1" data-test="browse-server-hint">
				{{ $t('browse.server_hint') }}
			</p>

			<p
				v-if="serverSilent"
				class="text-caption text-medium-emphasis mb-0"
				data-test="browse-server-unsupported"
			>
				{{ $t('browse.server_unsupported') }}
			</p>

			<v-list v-else density="compact" max-height="180">
				<v-list-item
					v-for="entry of serverEntries"
					:key="entry.path"
					data-test="browse-server-entry"
					prepend-icon="mdi-folder-network-outline"
					:subtitle="entry.libraryName ?? entry.path"
					:title="entry.path"
					@click="onChooseServer(entry.path)"
				>
					<template v-if="canWalk" #append>
						<v-btn
							data-test="browse-server-enter"
							icon="mdi-chevron-right"
							size="x-small"
							:title="$t('browse.server_enter')"
							variant="text"
							@click.stop="loadServer(entry.path)"
						/>
					</template>
				</v-list-item>

				<v-list-item
					v-if="!serverLoading && serverEntries.length === 0"
					data-test="browse-server-empty"
					:title="$t('browse.empty')"
				/>
			</v-list>

			<!--
				Deliberately outside the branch above rather than another step in it: the
				folders the server did report stay on screen, and this only adds the
				sentence explaining why clicking into one of them changed nothing.
			-->
			<p
				v-if="serverDeadEnd && !serverSilent"
				class="text-caption text-medium-emphasis mb-0"
				data-test="browse-server-no-deeper"
			>
				{{ $t('browse.server_no_deeper') }}
			</p>
		</section>

		<!--
			Said rather than left blank: on the server's side there is no disk below to
			fall back on, so an empty dialog would read as broken rather than as a server
			that could not be asked — and the field it came from still takes a typed path.
		-->
		<p
			v-if="serverOnly && !showServer"
			class="text-caption text-medium-emphasis mb-0"
			data-test="browse-server-unavailable"
		>
			{{ $t('browse.server_unavailable') }}
		</p>

		<template v-if="!serverOnly">
			<p
				v-if="showServer"
				class="text-subtitle-2 mb-1 mt-3"
				data-test="browse-gateway-title"
			>
				{{ $t('browse.gateway_title') }}
			</p>

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
		</template>

		<template #actions>
			<v-switch
				v-if="!serverOnly"
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
				v-if="!serverOnly"
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
		&_server {
			padding: 8px;
			margin-bottom: 8px;
			border: 1px solid rgba(var(--v-border-color), 0.2);
			border-radius: 4px;
		}

		&_server-head {
			display: flex;
			align-items: center;
		}

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
