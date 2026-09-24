<script lang="ts" setup>
	import type { DestinationLibrary, RejectedLibrary } from '@/composables/useDestinationLibraries';
	import type { CategoryKeyword, MediaCategory } from '@mcs/shared';
	import { computed, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import CategoryList from '@/components/library/CategoryList.vue';
	import { useApiError } from '@/hooks/useApiError';
	import { useLibrariesStore } from '@/stores/libraries';

	/**
	 * Which remote shelves belong to which of our categories.
	 *
	 * What this replaces said a fact and offered a rename: eleven rows, all at
	 * position 100, nine of them a friend's shelf stranded on its own — `Animes -
	 * Films`, `Émissions TV`, `Series TV`, `Spectacles`. Folding them meant opening
	 * the libraries screen and typing the same alias once per library, again for every
	 * peer that ever appears. This screen is the other sentence: our categories, each
	 * carrying the names that file into it, so the next gateway to turn up sorts
	 * itself out.
	 *
	 * The pool is at the top because it is the work: what is in it is what nobody has
	 * said anything about yet, and it empties as things are mapped. An empty pool says
	 * so rather than leaving a blank strip, which reads as a screen that failed to
	 * load.
	 *
	 * The unfiled names are chips on one strip, never blocks. Rendered as nine
	 * full-width rows — a name, a library count on its own line and a select each —
	 * they pushed the two categories this screen is about off the bottom of the
	 * viewport, which is the opposite of what it is for. The categories are the
	 * subject; the strip is what is left to do.
	 *
	 * **Every drag has a control that does the same thing.** The chip is its own menu's
	 * activator, so the keyboard road and the drag start from the same object: a
	 * settings screen that only answers to a mouse is one some people cannot operate
	 * at all, and this one decides where their media appears.
	 *
	 * Nothing here is destructive. Plugging a name in writes no alias on any library —
	 * the fold is recomputed by the gateway on every read — so the undo is the removal
	 * of one row and it is exact. That is why the banner offers it rather than warning
	 * beforehand.
	 *
	 * **A local category owns its destination here too**, beside its keywords. There
	 * used to be a table of "Category → Goes to" lower down the same pane, which made
	 * one category two subjects in two places — and repeated the same three-line merge
	 * explanation under every select, three times in one viewport on a gateway with
	 * three categories. The consequence is worth stating; stating it per row turned it
	 * into a wall nobody reads, so it is said once, above the list.
	 *
	 * Nothing about the placement rule moves with the control. The destination is still
	 * step 2 — a series we already hold keeps its own folder, and a category with no
	 * destination still falls through to the global default, which is why an empty
	 * select names what it falls back to instead of sitting blank.
	 *
	 * The destination is saved with the rest of the settings, unlike the keywords beside
	 * it, which apply on the spot. They are two mechanisms and always were: a keyword
	 * says what a category *is* and takes effect on the next read, a destination says
	 * where its next file goes and is one field of one form.
	 */
	const targets = defineModel<Record<string, string>>({ required: true });

	const props = withDefaults(defineProps<{
		categories: MediaCategory[];
		keywords: CategoryKeyword[];
		/** Libraries a pull can really land in: ours, writable, with a local path. */
		destinations?: DestinationLibrary[];
		/**
		 * Libraries that cannot receive anything, with the reason.
		 *
		 * Offered in the menu as unselectable entries rather than dropped from it. A
		 * name that simply goes missing sends somebody hunting for a fault in the wrong
		 * place — the library is there, it just cannot be written into — and the menu is
		 * the one moment they are looking for it. Printing the same list under every row
		 * instead is what made the old table unreadable.
		 */
		rejected?: RejectedLibrary[];
		/** What a category with no destination of its own does, named. Never blank. */
		fallback?: string;
		loading?: boolean;
	}>(), {
		destinations: () => [],
		rejected: () => [],
		fallback: '',
		loading: false,
	});

	interface DragSource {
		/** A category from the pool becomes a new keyword; a keyword moves. */
		kind: 'keyword' | 'pool';
		id: string;
		label: string;
	}

	interface Undo {
		label: string;
		run: () => Promise<void>;
	}

	const librariesStore = useLibrariesStore();
	const { parseApiError } = useApiError();
	const { t } = useI18n();

	const dragging = ref<DragSource | null>(null);
	const over = ref<string | null>(null);
	const drafts = ref<Record<string, string>>({});
	const busy = ref(false);
	const error = ref<string | null>(null);
	const undo = ref<Undo | null>(null);

	/**
	 * Only our own categories can receive a mapping.
	 *
	 * `local` means at least one of the merged libraries sits on a service whose files
	 * this gateway holds — the shelf that is still here next month. A friend's category
	 * is reachable while the link is, and hanging the household's whole mapping off it
	 * would take the list away with the friend.
	 */
	const mine = computed(() => props.categories.filter(one => one.local));

	/**
	 * What nobody has said anything about yet.
	 *
	 * A category disappears from here the moment it is mapped, because a folded shelf
	 * no longer reads as a category of its own — which is what makes the pool emptying
	 * the measure of the work left.
	 */
	const pool = computed(() => props.categories.filter(one => !one.local));

	/**
	 * What the add field offers: the names sitting unfiled in the strip above.
	 *
	 * Suggestions and not a closed list. A name nobody has ever seen has to be
	 * accepted — a gateway that has not turned up yet is the whole point of the
	 * feature, and a field that refused `Spectacles` until somebody's Jellyfin
	 * announced it would be a field that only works after it is too late to matter.
	 */
	const suggestions = computed(() => pool.value.map(one => one.name));

	/**
	 * Everything the menu shows: what can receive a file, then what cannot and why.
	 *
	 * The refused entries are disabled rather than absent. Choosing one would queue
	 * transfers onto a disk this gateway cannot write to and nothing anywhere would
	 * report it, so they must not be selectable — but a library missing from the one
	 * list somebody consults reads as a fault in the gateway rather than as a fact
	 * about the server it sits on.
	 */
	function entryFor (one: DestinationLibrary) {
		return {
			value: one.id,
			title: one.name,
			// The path with the name, because two libraries of one service can carry the
			// same name and the folder is what somebody recognises from their own disk.
			subtitle: one.path ? `${one.serviceName} · ${one.path}` : one.serviceName,
		};
	}

	/**
	 * Which library a category's answer names, whether it was stored as one or as a path.
	 *
	 * The stored answer is a folder — that is what the placement reads — but the control
	 * asks for the shelf first, because that is the order people work in and the shelf is
	 * what a media server scans. This maps one back to the other.
	 */
	function libraryOf (key: string): string | null {
		const answer = targets.value[key] ?? null;

		if (answer === null) {
			return null;
		}

		const owner = props.destinations
			.find(one => one.id === answer || one.roots.includes(answer));

		return owner?.id ?? answer;
	}

	/** Which category's folder browser is open, since every row has one. */
	const browsing = ref<string | null>(null);

	/**
	 * Choosing a shelf stores its default folder, not the shelf.
	 *
	 * What the placement reads is a directory, and storing the library alone would put
	 * the file in whichever of its roots came first — which is exactly what nobody could
	 * see and nobody could change. Writing the default here means the field below opens
	 * already filled with the answer in force.
	 */
	function chooseLibrary (key: string, libraryId: string | null): void {
		const library = props.destinations.find(one => one.id === libraryId) ?? null;

		choose(key, library?.path ?? libraryId);
	}

	/** Refusing an emptied box would be refusing "put it back to the shelf's own root". */
	function chooseFolder (key: string, folder: string | null): void {
		const trimmed = folder?.trim() || null;

		browsing.value = null;
		choose(key, trimmed ?? props.destinations.find(one => one.id === libraryOf(key))?.path ?? null);
	}

	/** The folder a category's answer names, or the chosen library's default. */
	function folderOf (key: string): string | null {
		const answer = targets.value[key] ?? null;
		const library = props.destinations.find(one => one.id === libraryOf(key)) ?? null;

		if (answer !== null && library?.roots.includes(answer)) {
			return answer;
		}

		return answer !== null && answer.startsWith('/') ? answer : (library?.path ?? null);
	}

	/**
	 * The folders this category can be sent to, and only those.
	 *
	 * The list used to be every writable library on the gateway, in whatever order they
	 * arrived, for every row — so the line for `Animes - Films` offered `Musique` and
	 * `Series TV`. A menu that ignores the line it sits on reads as meaningless because
	 * it is, and nobody wants a category filed into a different category: a shelf named
	 * `Animes` exists precisely so that what belongs there goes there.
	 *
	 * So the choice is narrowed to the libraries this category is made of, which is
	 * where the question actually is — a category built from two libraries on two disks
	 * has to say which of the two receives what arrives, and nothing else on this screen
	 * asks that.
	 *
	 * A library of this category the gateway cannot write into stays in the menu,
	 * disabled, with the reason. Choosing one would queue transfers onto a disk nothing
	 * can write to and nothing anywhere would report it — but dropping the name sends
	 * somebody hunting for a fault in the gateway rather than finding a fact about their
	 * server.
	 */
	function destinationItemsFor (category: MediaCategory): unknown[] {
		/*
		 * Whatever this category already points at stays in the menu, even when it is a
		 * library of some other shelf.
		 *
		 * Narrowing the list without this would hide an answer somebody had already
		 * given: the select would render blank over a setting that is still in force, so
		 * the screen would say "nothing chosen" about a category that does have a
		 * destination — and the only way to find out would be to read the database.
		 * Offering it is also what lets them change their mind rather than only clear it.
		 */
		const chosen = targets.value[category.key] ?? null;
		const own = new Set(category.libraryIds);
		// Matched on either, because an answer may name a library or one of its folders
		// — and a stored answer has to stay visible whichever of the two it is.
		const keeps = (id: string, path?: string | null): boolean =>
			own.has(id) || id === chosen || (path !== null && path !== undefined && path === chosen);

		return [
			...props.destinations.filter(one => keeps(one.id, one.path)).map(one => entryFor(one)),
			...props.rejected.filter(one => keeps(one.id)).map(one => ({
				value: one.id,
				title: one.name,
				subtitle: `${one.serviceName} · ${t(`settings.destination.rejected.${one.reason}`)}`,
				props: { disabled: true },
			})),
		];
	}

	/**
	 * Replaced rather than mutated in place.
	 *
	 * The parent holds this object inside a reactive model and builds the patch from
	 * it; assigning a key on the same reference updates nothing a watcher can see, and
	 * the choice would be lost between clicking and saving.
	 *
	 * Clearing removes the key instead of writing an empty string: the contract is a
	 * map of categories that have an answer, and a key pointing at nothing is a library
	 * identifier the gateway would try to resolve.
	 */
	function choose (key: string, libraryId: string | null): void {
		const next = { ...targets.value };

		if (libraryId) {
			next[key] = libraryId;
		} else {
			delete next[key];
		}

		targets.value = next;
	}

	function keywordsOf (category: MediaCategory): CategoryKeyword[] {
		return props.keywords.filter(one => one.categoryKey === category.key);
	}

	/** Where a keyword could go instead — never the category it is already in. */
	function elsewhere (keyword: CategoryKeyword): MediaCategory[] {
		return mine.value.filter(one => one.key !== keyword.categoryKey);
	}

	function startDrag (event: DragEvent, source: DragSource): void {
		dragging.value = source;
		// Guarded rather than assumed: a real browser refuses a drop whose drag carried
		// no data, and jsdom hands the handler an event with no `dataTransfer` at all.
		event.dataTransfer?.setData('text/plain', source.label);

		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	function dragOver (event: DragEvent, key: string): void {
		// Without this the browser treats the row as a place nothing can be dropped, and
		// the drop handler is never called at all.
		event.preventDefault();
		over.value = key;
	}

	async function drop (event: DragEvent, categoryKey: string): Promise<void> {
		event.preventDefault();

		const source = dragging.value;

		dragging.value = null;
		over.value = null;

		if (source === null) {
			return;
		}

		await (source.kind === 'pool' ? map(categoryKey, source.label) : move(source.id, categoryKey));
	}

	/**
	 * One place where a refusal becomes a sentence.
	 *
	 * The API answers keys and this screen has several controls that can be refused
	 * for the same three reasons; parsing the answer once means a keyword another
	 * category already holds reads the same whether it was dropped, chosen or typed.
	 */
	async function run (action: () => Promise<Undo | null>): Promise<void> {
		busy.value = true;
		error.value = null;

		try {
			undo.value = await action();
		} catch (error_) {
			const parsed = await parseApiError(error_, {
				fallback: 'error.general',
				mappedFields: new Set(),
			});

			error.value = parsed.mainError ?? null;
		} finally {
			busy.value = false;
		}
	}

	/**
	 * A name committed in the add field, picked from the list or typed outright.
	 *
	 * `update:modelValue` on a combobox is the commit — enter, blur, or choosing an
	 * item — and not the keystroke, which is `update:search`. That distinction is the
	 * whole reason this can file immediately: listening to the wrong one would create
	 * a keyword called `S`, then `Sé`, then `Sér`.
	 *
	 * Anything committed is accepted, including a name no library anywhere answers to
	 * yet. Refusing those would be refusing the feature: the gateway that brings
	 * `Spectacles` has not turned up, and a field that only takes names already on
	 * screen is one that starts working the day it stops being needed.
	 */
	function add (categoryKey: string, value: string | null): void {
		const name = (value ?? '').trim();

		drafts.value = { ...drafts.value, [categoryKey]: name };

		if (name !== '') {
			void map(categoryKey, name);
		}
	}

	/** Plug a name into a category. The undo is deleting the row it just wrote. */
	async function map (categoryKey: string, keyword: string): Promise<void> {
		const name = keyword.trim();

		if (name === '') {
			return;
		}

		await run(async () => {
			const created = await librariesStore.addKeyword(categoryKey, name);

			drafts.value = { ...drafts.value, [categoryKey]: '' };

			return {
				label: created.keyword,
				run: () => librariesStore.removeKeyword(created.id),
			};
		});
	}

	/** Move a keyword. The undo puts it back where it was, by the same route. */
	async function move (id: string, categoryKey: string): Promise<void> {
		const previous = props.keywords.find(one => one.id === id);

		if (previous === undefined || previous.categoryKey === categoryKey) {
			return;
		}

		await run(async () => {
			const moved = await librariesStore.moveKeyword(id, categoryKey);

			return {
				label: moved.keyword,
				run: () => librariesStore.moveKeyword(id, previous.categoryKey).then(() => undefined),
			};
		});
	}

	/**
	 * Unplug a keyword, which puts its name back on the strip at the top.
	 *
	 * Not a disappearance. The libraries it was folding go back to reading as their own
	 * names, so they read as a category of their own again and the gateway answers it
	 * among the unfiled ones on the very next read — where it can be filed somewhere
	 * else straight away, which is the reason somebody took it out.
	 *
	 * A name that matched no library is the one case where nothing comes back, and
	 * nothing should: there is no shelf anywhere answering to it, and a chip standing
	 * for nothing is a chip that cannot be dropped on anything.
	 *
	 * The undo plugs the same name back into the same category.
	 */
	async function unplug (keyword: CategoryKeyword): Promise<void> {
		await run(async () => {
			await librariesStore.removeKeyword(keyword.id);

			return {
				label: keyword.keyword,
				run: () => librariesStore
					.addKeyword(keyword.categoryKey, keyword.keyword)
					.then(() => undefined),
			};
		});
	}

	async function undoLast (): Promise<void> {
		const pending = undo.value;

		undo.value = null;

		if (pending !== null) {
			// Answers no undo of its own: an undo of an undo is a second guess at what
			// somebody meant, and the controls to say it again are all still on screen.
			await run(async () => {
				await pending.run();

				return null;
			});
		}
	}
</script>

<template>
	<div class="category-mapping" data-test="category-mapping">
		<v-progress-linear v-if="loading" color="primary" indeterminate />

		<template v-else>
			<v-alert
				v-if="error"
				class="mb-3"
				data-test="category-mapping-error"
				density="compact"
				type="error"
				variant="tonal"
			>
				{{ error }}
			</v-alert>

			<v-alert
				v-if="undo"
				class="mb-3"
				data-test="category-mapping-undo"
				density="compact"
				type="success"
				variant="tonal"
			>
				{{ $t('category.mapping.applied', { keyword: undo.label }) }}

				<template #append>
					<v-btn
						data-test="category-mapping-undo-action"
						:disabled="busy"
						size="small"
						variant="text"
						@click="undoLast"
					>
						{{ $t('category.mapping.undo') }}
					</v-btn>
				</template>
			</v-alert>

			<!--
				One strip of chips, and it has to stay one strip.

				It rendered as nine full-width blocks, each with a name, a library count
				on its own line and a select of its own — a wall that pushed the two
				categories this screen is actually about off the bottom of the viewport.
				The unfiled names are not the subject; they are what is left to do, and
				nine of them belong on one or two lines above the work.

				It is at the top because things come back here: taking a name out of a
				category returns it to this strip, where it can be filed again straight
				away, and a strip further down would put that return out of sight.
			-->
			<section class="category-mapping_pool" data-test="category-pool">
				<span class="text-caption text-medium-emphasis mr-2">
					{{ $t('category.mapping.pool_title') }}
				</span>

				<!--
					Said rather than left blank. A strip with nothing in it reads as a
					list that failed to load, and this one is empty precisely when the
					screen has done its job.
				-->
				<span
					v-if="pool.length === 0"
					class="text-body-2 text-medium-emphasis"
					data-test="category-pool-empty"
				>
					{{ $t('category.mapping.pool_empty') }}
				</span>

				<span
					v-for="entry of pool"
					v-else
					:key="entry.key"
					class="category-mapping_chip"
					:data-category="entry.key"
					data-test="category-pool-entry"
					draggable="true"
					@dragstart="startDrag($event, { kind: 'pool', id: entry.key, label: entry.name })"
				>
					<!--
						The chip is the menu's activator, so the keyboard road and the drag
						start from the same thing. A select beside every chip was what made
						the strip a wall; a settings screen that only answers to a pointer
						is one some people cannot operate at all, and this one decides
						where their media appears.
					-->
					<v-menu>
						<template #activator="{ props: activator }">
							<v-chip
								v-bind="activator"
								:data-test="`category-pool-chip-${entry.key}`"
								label
								link
								size="small"
								:title="$t('category.libraries', { count: entry.libraryIds.length }, entry.libraryIds.length)"
								variant="tonal"
							>
								{{ entry.name }}

								<!--
									A superscript and not a line of its own: the count is
									worth a glance, never a row. The full sentence is on the
									chip's title, for whoever wants it.
								-->
								<sup v-if="entry.libraryIds.length > 1" class="ml-1">
									{{ entry.libraryIds.length }}
								</sup>
							</v-chip>
						</template>

						<v-list density="compact">
							<v-list-subheader>{{ $t('category.mapping.map_to') }}</v-list-subheader>

							<v-list-item
								v-for="target of mine"
								:key="target.key"
								:data-test="`category-pool-map-${entry.key}-${target.key}`"
								@click="map(target.key, entry.name)"
							>
								<v-list-item-title>{{ target.name }}</v-list-item-title>
							</v-list-item>
						</v-list>
					</v-menu>
				</span>
			</section>

			<p
				v-if="mine.length === 0"
				class="text-body-2 text-medium-emphasis"
				data-test="category-mapping-empty"
			>
				{{ $t('category.mapping.no_local') }}
			</p>

			<template v-else>
				<!--
					Once, for the screen. It used to be printed under every select in a
					table of destinations — three identical paragraphs in one viewport on
					a gateway with three categories, which is how a sentence worth reading
					becomes a wall nobody reads. Still said before any choice is made and
					not in a tooltip: somebody pointed a category at a library expecting
					one category in the library view, got two, and nothing on the screen
					had ever confirmed or contradicted that reading.

					Unconditional, including for categories whose folders this gateway
					does not reach. The alias is local and renames nothing on anybody's
					server, so a friend's shelf joins the category exactly as ours does —
					where a new file lands is the destination's answer, decided by the
					mount and separately.
				-->
				<p
					class="text-caption text-medium-emphasis mb-2"
					data-test="category-target-merges"
				>
					{{ $t('settings.destination.merges') }}
				</p>

				<section
					v-for="category of mine"
					:key="category.key"
					class="category-mapping_row"
					:class="{ 'category-mapping_row--over': over === category.key }"
					:data-category="category.key"
					:data-configured="String(Boolean(targets[category.key]))"
					data-test="category-mapping-row"
					@dragleave="over = null"
					@dragover="dragOver($event, category.key)"
					@drop="drop($event, category.key)"
				>
					<div class="category-mapping_head">
						<strong>{{ category.name }}</strong>

						<v-chip label size="x-small" variant="tonal">
							{{ $t(`library.kind.${category.kind}`) }}
						</v-chip>

						<span class="text-caption text-medium-emphasis">
							{{ $t('category.libraries', { count: category.libraryIds.length }, category.libraryIds.length) }}
						</span>
					</div>

					<div class="category-mapping_destination">
						<v-select
							clearable
							:data-test="`category-target-${category.key}`"
							density="compact"
							:disabled="busy"
							hide-details
							item-props
							item-title="title"
							item-value="value"
							:items="destinationItemsFor(category)"
							:label="$t('settings.destination.target_header')"
							:model-value="libraryOf(category.key)"
							@update:model-value="chooseLibrary(category.key, $event)"
						/>

						<!--
							The shelf first, the folder after: that is the order people work
							in, and a shelf can be five directories on five disks. Only once
							one is chosen, because a folder with no shelf to sit in is a box
							nobody can fill.
						-->
						<div v-if="libraryOf(category.key)" class="category-mapping_folder">
							<v-text-field
								:data-test="`category-folder-${category.key}`"
								density="compact"
								:disabled="busy"
								hide-details
								:label="$t('settings.destination.folder')"
								:model-value="folderOf(category.key)"
								@update:model-value="chooseFolder(category.key, $event)"
							>
								<template #append-inner>
									<v-btn
										:data-test="`category-folder-browse-${category.key}`"
										icon="mdi-folder-open-outline"
										size="small"
										:title="$t('browse.open')"
										variant="text"
										@click="browsing = category.key"
									/>
								</template>
							</v-text-field>

							<DirectoryPicker
								:model-value="browsing === category.key"
								:path="folderOf(category.key)"
								@choose="chooseFolder(category.key, $event)"
								@update:model-value="browsing = $event ? category.key : null"
							/>
						</div>

						<!--
							An empty select with nothing under it reads as broken. It is not
							empty of an answer: the answer is the next step of the rule, and
							it is named.
						-->
						<p
							v-if="!targets[category.key]"
							class="text-caption text-medium-emphasis mt-1 mb-0"
							data-test="category-target-fallback"
						>
							{{ $t('settings.destination.falls_back', { target: fallback }) }}
						</p>
					</div>

					<div class="category-mapping_keywords">
						<span
							v-if="keywordsOf(category).length === 0"
							class="text-caption text-medium-emphasis"
							data-test="category-keywords-empty"
						>
							{{ $t('category.mapping.no_keyword') }}
						</span>

						<span
							v-for="keyword of keywordsOf(category)"
							:key="keyword.id"
							class="category-mapping_chip"
							:data-keyword="keyword.normalized"
							data-test="category-keyword"
							draggable="true"
							@dragstart="startDrag($event, {
								kind: 'keyword',
								id: keyword.id,
								label: keyword.keyword,
							})"
						>
							<v-menu>
								<template #activator="{ props: activator }">
									<v-chip
										v-bind="activator"
										closable
										:data-test="`category-keyword-${keyword.normalized}`"
										label
										link
										size="small"
										:title="$t('category.libraries', { count: keyword.libraryIds.length }, keyword.libraryIds.length)"
										variant="tonal"
										@click:close="unplug(keyword)"
									>
										{{ keyword.keyword }}

										<sup v-if="keyword.libraryIds.length > 1" class="ml-1">
											{{ keyword.libraryIds.length }}
										</sup>
									</v-chip>
								</template>

								<!--
									Moving is one gesture, not a removal followed by an
									addition: dropping the chip on another category, or
									choosing that category here. Taking it out and putting
									it back would empty the category for a moment and, if
									the second half failed, leave the name filed nowhere.
								-->
								<v-list density="compact">
									<v-list-subheader>{{ $t('category.mapping.move_to') }}</v-list-subheader>

									<v-list-item
										v-for="other of elsewhere(keyword)"
										:key="other.key"
										:data-test="`category-keyword-move-${other.key}`"
										@click="move(keyword.id, other.key)"
									>
										<v-list-item-title>{{ other.name }}</v-list-item-title>
									</v-list-item>

									<v-list-item
										:data-test="`category-keyword-remove-${keyword.normalized}`"
										@click="unplug(keyword)"
									>
										<v-list-item-title>{{ $t('category.mapping.unfile') }}</v-list-item-title>
									</v-list-item>
								</v-list>
							</v-menu>
						</span>

						<!--
							A combobox and not a plain box: it suggests the names that are
							sitting unfiled in the strip above, which is what somebody is
							usually reaching for — and it still takes a name nobody has
							ever seen, because a gateway that has not turned up yet is the
							whole point of the feature.
						-->
						<v-combobox
							class="category-mapping_input"
							:data-test="`category-keyword-input-${category.key}`"
							density="compact"
							:disabled="busy"
							hide-details
							:items="suggestions"
							:label="$t('category.mapping.add_keyword')"
							:model-value="drafts[category.key] ?? ''"
							@update:model-value="add(category.key, $event)"
						/>
					</div>
				</section>
			</template>

			<!--
				The old list, kept and moved out of the way. It is still the answer to
				"in what order do these appear", and renaming or reordering a library is
				still how somebody repairs a mapping that filed something wrongly — an
				alias always wins over a keyword. It is simply no longer the main event.
			-->
			<v-expansion-panels class="mt-3" variant="accordion">
				<!--
					`eager`: the panel body is built with the page rather than on the first
					click, so the link out to the libraries screen is in the document for a
					screen reader walking the card and for a browser search on the page.
				-->
				<v-expansion-panel data-test="category-mapping-order" eager>
					<v-expansion-panel-title data-test="category-mapping-order-toggle">
						{{ $t('category.mapping.order_title') }}
					</v-expansion-panel-title>

					<v-expansion-panel-text>
						<p class="text-caption text-medium-emphasis">{{ $t('settings.categories_help') }}</p>

						<CategoryList :categories="categories" />

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
					</v-expansion-panel-text>
				</v-expansion-panel>
			</v-expansion-panels>
		</template>
	</div>
</template>

<style lang="scss">
	.category-mapping {
		// The strip, and the reason it is a strip. Laid out as wrapping inline chips
		// rather than as a column: as blocks it was nine full-width rows that pushed
		// the two categories this screen is about off the bottom of the viewport, which
		// is the opposite of what it is for. Nine chips take one line, or two.
		&_pool {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px;
			margin-bottom: 16px;
		}

		&_head {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		&_entry {
			display: inline-flex;
		}

		&_keywords {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
			margin: 8px 0;
		}

		&_destination {
			margin: 8px 0;
			max-width: 420px;
		}

		&_input {
			max-width: 320px;
		}

		// Grab rather than pointer: the chip is draggable and says so before it is
		// touched, which is the only hint a drag target ever gets.
		&_chip {
			cursor: grab;
			display: inline-flex;
		}

		&_row {
			// A dashed border rather than none: a drop target nothing marks as one is a
			// drop target people do not try, and they go looking for a button instead.
			border: 1px dashed rgb(var(--v-border-color), 0.35);
			border-radius: 6px;
			padding: 8px 12px;
			margin-bottom: 8px;

			&--over {
				border-style: solid;
				border-color: rgb(var(--v-theme-primary));
			}
		}
	}
</style>
