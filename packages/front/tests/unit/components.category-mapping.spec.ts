import type { CategoryKeyword, MediaCategory } from '@mcs/shared';
import type { VueWrapper } from '@vue/test-utils';
import { LibraryKind } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import CategoryMapping from '@/components/settings/CategoryMapping.vue';
import { mountWithApp, stubFetchRoutes } from './helpers';

/**
 * The screen the old Categories card should have been.
 *
 * The card it replaces stated a fact and offered a rename: eleven rows, all at
 * position 100, nine of them a friend's shelf stranded on its own. Folding them
 * meant typing the same alias once per library, again for every peer that ever
 * appears. Everything asserted here is about saying it once — and about being able
 * to say it without a mouse, because a settings screen that only answers to a
 * pointer is one some people cannot operate at all.
 */
async function settle (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

/** A `v-menu` that renders its content inline, so the keyboard path is assertable. */
const menuStub = {
	VMenu: {
		template: '<div class="menu-stub"><slot name="activator" :props="{}" /><slot /></div>',
	},
};

function category (overrides: Partial<MediaCategory> = {}): MediaCategory {
	return {
		key: 'shows',
		name: 'Shows',
		kind: LibraryKind.SHOWS,
		position: 100,
		libraryIds: ['l1'],
		serviceIds: ['s1'],
		itemCount: 24,
		local: true,
		...overrides,
	};
}

function keyword (overrides: Partial<CategoryKeyword> = {}): CategoryKeyword {
	return {
		id: 'k1',
		categoryKey: 'shows',
		categoryName: 'Shows',
		keyword: 'Séries TV',
		normalized: 'series-tv',
		libraryIds: ['l9'],
		...overrides,
	};
}

const DESTINATIONS = [
	// Two roots on the first, because a library is not one folder and the folder field
	// exists for exactly that.
	{
		id: 'l1',
		name: 'Shows',
		serviceName: 'Jellyfin (mine)',
		path: '/media/shows',
		roots: ['/media/shows', '/media/shows2'],
	},
	{
		id: 'l2',
		name: 'Movies',
		serviceName: 'Plex (mine)',
		path: '/media/movies',
		roots: ['/media/movies'],
	},
];

/** The owner's gateway, shortened: two of his, two of somebody else's. */
const gateway = {
	categories: [
		category(),
		category({ key: 'movies', name: 'Movies', kind: LibraryKind.MOVIES, libraryIds: ['l2'] }),
		category({
			key: 'series-tv',
			name: 'Series TV',
			kind: LibraryKind.OTHER,
			libraryIds: ['l9', 'l10'],
			serviceIds: ['s2'],
			local: false,
		}),
		category({
			key: 'emissions-tv',
			name: 'Émissions TV',
			kind: LibraryKind.OTHER,
			libraryIds: ['l11'],
			serviceIds: ['s2'],
			local: false,
		}),
	],
	keywords: [] as CategoryKeyword[],
};

function mapping (props: Record<string, unknown> = {}) {
	const routes = stubFetchRoutes({
		// Keyed per destination, because the answer carries the identifier the undo is
		// built from: a stub that returned the same row whatever was posted would let
		// an undo aimed at the wrong keyword pass.
		'/api/libraries/categories/shows/keywords': { body: keyword({ id: 'k1', keyword: 'Series TV' }) },
		'/api/libraries/categories/movies/keywords': {
			body: keyword({ id: 'k2', categoryKey: 'movies', keyword: 'Series TV' }),
		},
		'/api/libraries/keywords': { body: [keyword()] },
		'/api/libraries/categories': { body: gateway.categories },
	});
	const { wrapper } = mountWithApp(CategoryMapping, {
		props: {
			...gateway,
			destinations: DESTINATIONS,
			fallback: 'Movies',
			modelValue: {},
			...props,
		},
		global: { stubs: { ...menuStub } },
	});

	return { wrapper, routes };
}

/** The add field of one category. A combobox: it suggests, and it still takes new. */
function addField (wrapper: VueWrapper, key: string) {
	const found = wrapper
		.findAllComponents({ name: 'VCombobox' })
		.find(one => one.attributes('data-test') === `category-keyword-input-${key}`);

	if (found === undefined) {
		throw new Error(`no add field for ${key}`);
	}

	return found;
}

/**
 * The destination control of one category, by the key it carries.
 *
 * Found among the components rather than by querying inside the element: the
 * `data-test` lands on the select's own root, so a descendant search inside it finds
 * nothing and every assertion built on it passes vacuously.
 */
function destinationSelect (wrapper: VueWrapper, key: string) {
	const found = wrapper
		.findAllComponents({ name: 'VSelect' })
		.find(one => one.attributes('data-test') === `category-target-${key}`);

	if (found === undefined) {
		throw new Error(`no destination control for ${key}`);
	}

	return found;
}

describe('components/settings/CategoryMapping', () => {
	it('puts what nobody has filed yet on one strip of chips, above our categories', () => {
		// It rendered as nine full-width blocks, each with a name, a library count on a
		// line of its own and a select of its own — a wall that pushed the two
		// categories this screen is about off the bottom of the viewport. The unfiled
		// names are what is left to do, not the subject.
		const { wrapper } = mapping();

		const pool = wrapper.findAll('[data-test="category-pool-entry"]');
		expect(pool.map(one => one.attributes('data-category'))).toEqual(['series-tv', 'emissions-tv']);

		// A chip each, and no control of its own taking up a row.
		for (const entry of pool) {
			expect(entry.find('.v-chip').exists()).toBe(true);
			expect(entry.findComponent({ name: 'VSelect' }).exists()).toBe(false);
		}

		// Only the categories this household actually holds can receive a mapping: a
		// friend's is reachable while the link is, and hanging the whole list off it
		// would take it away with the friend.
		const rows = wrapper.findAll('[data-test="category-mapping-row"]');
		expect(rows.map(one => one.attributes('data-category'))).toEqual(['shows', 'movies']);
	});

	it('keeps the library count on the chip rather than on a line of its own', () => {
		const { wrapper } = mapping({
			categories: [
				...gateway.categories,
				category({ key: 'tv', name: 'TV', libraryIds: ['l20', 'l21'], local: false }),
			],
		});
		const chip = wrapper.find('[data-category="tv"] .v-chip');

		// A superscript is worth a glance; a row is not. The sentence is on the title,
		// for whoever wants it.
		expect(chip.text()).toContain('TV');
		expect(chip.find('sup').text()).toBe('2');
		expect(chip.attributes('title')).toContain('2 libraries');
	});

	it('says so when the pool is empty rather than leaving a blank strip', () => {
		// The screen is at its best exactly when this list has nothing in it, and an
		// empty strip reads as a list that failed to load.
		const { wrapper } = mapping({ categories: [category(), category({ key: 'movies', name: 'Movies' })] });

		expect(wrapper.find('[data-test="category-pool-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="category-pool-empty"]').text())
			.toContain('every shelf is filed');
	});

	it('maps a shelf dropped onto a category', async () => {
		const { wrapper, routes } = mapping();

		const entry = wrapper.find('[data-test="category-pool-entry"][data-category="series-tv"]');
		await entry.trigger('dragstart');
		await wrapper.find('[data-test="category-mapping-row"][data-category="shows"]').trigger('drop');
		await settle();

		const post = routes.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'POST');
		expect(post?.[0]).toContain('/api/libraries/categories/shows/keywords');
		expect(JSON.parse(post?.[1].body as string)).toEqual({ keyword: 'Series TV' });
	});

	it('does the same thing from the keyboard, through a menu on the chip itself', async () => {
		// Not a convenience. Somebody who cannot drag still decides where their media
		// appears, and this screen is the only place that answer is given. On the chip
		// and not beside it: a select per entry is what made the strip a wall.
		const { wrapper, routes } = mapping();
		const entry = wrapper.find('[data-test="category-pool-entry"][data-category="series-tv"]');

		expect(entry.find('[data-test="category-pool-map-series-tv-shows"]').exists()).toBe(true);

		await entry.find('[data-test="category-pool-map-series-tv-movies"]').trigger('click');
		await settle();

		const post = routes.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'POST');
		expect(post?.[0]).toContain('/api/libraries/categories/movies/keywords');
		expect(JSON.parse(post?.[1].body as string)).toEqual({ keyword: 'Series TV' });
	});

	it('suggests the names sitting unfiled, and takes one nobody has ever seen', async () => {
		// A gateway that has not turned up yet is the whole point of the feature, so a
		// field that only took names already on screen would start working the day it
		// stopped being needed.
		const { wrapper, routes } = mapping();
		const field = addField(wrapper, 'shows');

		expect(field.props('items')).toEqual(['Series TV', 'Émissions TV']);

		field.vm.$emit('update:modelValue', 'Spectacles');
		await settle();

		const post = routes.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'POST');
		expect(post?.[0]).toContain('/api/libraries/categories/shows/keywords');
		expect(JSON.parse(post?.[1].body as string)).toEqual({ keyword: 'Spectacles' });
	});

	it('files nothing on an emptied field, which is not a name', async () => {
		const { wrapper, routes } = mapping();

		addField(wrapper, 'shows').vm.$emit('update:modelValue', ' '.repeat(3));
		await settle();

		expect(routes.mock.calls.some(call => String(call[1]?.method).toUpperCase() === 'POST'))
			.toBe(false);
	});

	it('shows the names plugged into a category, and how much each is catching', () => {
		const { wrapper } = mapping({ keywords: [keyword()] });

		const chip = wrapper.find('[data-category="shows"] [data-test="category-keyword"]');

		expect(chip.attributes('data-keyword')).toBe('series-tv');
		expect(chip.text()).toContain('Séries TV');
		expect(chip.find('.v-chip').attributes('title')).toContain('1 library');
	});

	it('moves a keyword between categories without a pointer', async () => {
		const { wrapper, routes } = mapping({ keywords: [keyword()] });

		await wrapper.find('[data-test="category-keyword-move-movies"]').trigger('click');
		await settle();

		const patch = routes.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PATCH');
		expect(patch?.[0]).toContain('/api/libraries/keywords/k1');
		expect(JSON.parse(patch?.[1].body as string)).toEqual({ categoryKey: 'movies' });
	});

	it('moves a keyword dragged onto another category', async () => {
		const { wrapper, routes } = mapping({ keywords: [keyword()] });

		await wrapper.find('[data-category="shows"] [data-test="category-keyword"]')
			.trigger('dragstart');
		await wrapper.find('[data-test="category-mapping-row"][data-category="movies"]').trigger('drop');
		await settle();

		const patch = routes.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'PATCH');
		expect(JSON.parse(patch?.[1].body as string)).toEqual({ categoryKey: 'movies' });
	});

	it('moves a filed chip in one gesture, never as a removal and an addition', async () => {
		// Two requests would empty the category for a moment and, if the second failed,
		// leave the name filed nowhere — a shelf that belongs to nothing because
		// somebody dragged it two centimetres.
		const { wrapper, routes } = mapping({ keywords: [keyword()] });

		await wrapper.find('[data-category="shows"] [data-test="category-keyword"]')
			.trigger('dragstart');
		await wrapper.find('[data-test="category-mapping-row"][data-category="movies"]').trigger('drop');
		await settle();

		const methods = routes.mock.calls
			.map(call => String(call[1]?.method ?? 'GET').toUpperCase())
			.filter(one => one !== 'GET');

		expect(methods).toEqual(['PATCH']);
	});

	it('puts a chip back on the strip when it is taken out of a category', async () => {
		// Taking a name out is almost always the first half of filing it somewhere
		// else. A chip that simply vanished would mean hunting for the spelling again,
		// and the strip is where it can be re-filed immediately.
		// Folded, so the gateway no longer answers it as a category of its own — which
		// is exactly why it is absent from the strip while it is filed.
		const { wrapper, routes } = mapping({
			categories: gateway.categories.filter(one => one.key !== 'series-tv'),
			keywords: [keyword()],
		});

		expect(wrapper.find('[data-test="category-pool-entry"][data-category="series-tv"]').exists())
			.toBe(false);

		await wrapper.find('[data-category="shows"] [data-test="category-keyword"] .v-chip__close')
			.trigger('click');
		await settle();

		const deleted = routes.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'DELETE');

		expect(deleted?.[0]).toContain('/api/libraries/keywords/k1');
		// It comes back because the gateway is asked again after the removal, not
		// because this screen guessed: the libraries it was folding read as their own
		// names once more, so they answer as a category of their own. Recomputing the
		// strip here instead is how two clients start disagreeing about what is filed.
		const calls = routes.mock.calls.map(call => String(call[0]));
		const removal = routes.mock.calls
			.findIndex(call => String(call[1]?.method).toUpperCase() === 'DELETE');

		expect(calls.slice(removal + 1)).toEqual(
			expect.arrayContaining([
				expect.stringContaining('/api/libraries/categories'),
				expect.stringContaining('/api/libraries/keywords'),
			]),
		);

		// What the gateway answers once the keyword is gone: the shelf reads as its own
		// name again, so it is a category again, and an unfiled one.
		await wrapper.setProps({ categories: gateway.categories, keywords: [] });
		await settle();

		expect(wrapper.find('[data-test="category-pool-entry"][data-category="series-tv"]').exists())
			.toBe(true);
	});

	it('brings nothing back for a name no library anywhere answers to', async () => {
		// A keyword written for a gateway that has not turned up has no shelf behind
		// it, and a chip standing for nothing is a chip that cannot be dropped on
		// anything. The strip is what is left to file, not a list of past decisions.
		const { wrapper, routes } = mapping({
			keywords: [keyword({ id: 'k2', keyword: 'Spectacles', normalized: 'spectacles', libraryIds: [] })],
		});

		await wrapper.find('[data-category="shows"] [data-test="category-keyword"] .v-chip__close')
			.trigger('click');
		await settle();

		expect(routes.mock.calls.some(call => String(call[1]?.method).toUpperCase() === 'DELETE'))
			.toBe(true);

		await wrapper.setProps({ keywords: [] });
		await settle();

		expect(
			wrapper.findAll('[data-test="category-pool-entry"]').map(one => one.attributes('data-category')),
		).toEqual(['series-tv', 'emissions-tv']);
	});

	it('offers to undo what it just did, and undoing a mapping unplugs it', async () => {
		// The undo is exact because nothing was written on any library: deleting the
		// row puts the shelf back under its own name in the very next request. Which
		// is why it is offered afterwards instead of warned about beforehand.
		const { wrapper, routes } = mapping();

		await wrapper.find('[data-test="category-pool-map-series-tv-shows"]').trigger('click');
		await settle();

		const banner = wrapper.find('[data-test="category-mapping-undo"]');
		expect(banner.exists()).toBe(true);
		expect(banner.text()).toContain('Series TV');

		await wrapper.find('[data-test="category-mapping-undo-action"]').trigger('click');
		await settle();

		const deleted = routes.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'DELETE');
		expect(deleted?.[0]).toContain('/api/libraries/keywords/k1');
		expect(wrapper.find('[data-test="category-mapping-undo"]').exists()).toBe(false);
	});

	it('says why a refusal happened rather than swallowing it', async () => {
		stubFetchRoutes({
			'/api/libraries/categories/shows/keywords': {
				status: 409,
				body: { message: 'error.library.keyword_taken' },
			},
			'/api/libraries/keywords': { body: [] },
			'/api/libraries/categories': { body: gateway.categories },
		});
		const { wrapper } = mountWithApp(CategoryMapping, {
			props: { ...gateway, destinations: DESTINATIONS, fallback: 'Movies', modelValue: {} },
			global: { stubs: { ...menuStub } },
		});

		addField(wrapper, 'shows').vm.$emit('update:modelValue', 'TV');
		await settle();

		expect(wrapper.find('[data-test="category-mapping-error"]').text())
			.toContain('Another category already files that name');
	});

	/*
	 * Everything the per-category destination table used to claim, asserted here.
	 *
	 * The table is gone: a local category owns its destination the way it owns its
	 * keywords, in one place. It said the same thing twice on one pane, and it printed
	 * the merge explanation under every select — three identical paragraphs in one
	 * viewport on a gateway with three categories, which is how a sentence worth
	 * reading becomes a wall nobody reads.
	 */
	describe('where each of our categories sends its files', () => {
		it('gives every one of our categories a destination, configured or not', () => {
			const { wrapper } = mapping();

			expect(wrapper.find('[data-category="shows"] [data-test="category-target-shows"]').exists())
				.toBe(true);
			expect(wrapper.find('[data-category="movies"] [data-test="category-target-movies"]').exists())
				.toBe(true);
		});

		it('names the folder a configured category sends its media to', () => {
			// Pointed deliberately at the folder of the other category, so what is on
			// screen can only have come from the answer and not from the row's heading.
			const { wrapper } = mapping({ modelValue: { shows: '/media/movies' } });
			const row = wrapper.find('[data-category="shows"]');

			expect(row.attributes('data-configured')).toBe('true');
			// The path and not a library name: a library is not a place — `Series TV` is
			// five folders on five disks — so a name leaves the question unanswered.
			expect(row.find('.v-select__selection').text()).toBe('/media/movies');
			// And it stops offering the fallback, because it no longer falls back.
			expect(row.find('[data-test="category-target-fallback"]').exists()).toBe(false);
		});

		it('reads a category nobody answered for as falling back, never as nothing', () => {
			// An empty select with nothing under it reads as broken. There is an answer —
			// the next step of the rule — and it is named.
			const { wrapper } = mapping();
			const row = wrapper.find('[data-category="shows"]');

			expect(row.attributes('data-configured')).toBe('false');
			expect(row.find('[data-test="category-target-fallback"]').text()).toContain('Movies');
		});

		it('offers one line per root folder of this category, and nothing else', () => {
			/*
			 * A library is not a place. `Shows` is two directories on two disks here, and
			 * offering the library named the shelf while leaving the actual question
			 * unasked — the gateway then answered it by taking whichever root came first,
			 * which is exactly what nobody could see and nobody could change.
			 *
			 * The menu used to be every writable library on the gateway besides, in
			 * arrival order, for every row — so the line for `Shows` offered `Movies`. A
			 * menu that ignores the line it sits on is meaningless.
			 */
			const { wrapper } = mapping();
			const items = destinationSelect(wrapper, 'shows').props('items') as
				{ value: string; title: string; subtitle: string }[];

			expect(items.map(one => one.value)).toEqual(['/media/shows', '/media/shows2']);
			// The path is the title. A select renders only the title once something is
			// chosen, and two roots of one library carry the same name.
			expect(items.map(one => one.title)).toEqual(['/media/shows', '/media/shows2']);
			expect(items[0].subtitle).toContain('Jellyfin (mine)');
		});

		it('keeps an answer already given, even one pointing outside this category', () => {
			// Narrowing the list without this would hide a setting that is still in
			// force: the select would render blank and the screen would say "nothing
			// chosen" about a category that does have a destination.
			const { wrapper } = mapping({ modelValue: { shows: '/media/movies' } });
			const items = destinationSelect(wrapper, 'shows').props('items') as
				{ value: string }[];

			// The order is the menu's own — the category's folders, then whatever else was
			// already chosen — so it is asserted rather than sorted away.
			expect(items.map(one => one.value))
				.toEqual(['/media/shows', '/media/shows2', '/media/movies']);
		});

		/**
		 * A library on somebody else's machine is not an offer, whatever the styling.
		 *
		 * It used to sit in the menu, disabled, with the reason — on the reasoning that a
		 * missing name sends somebody hunting for a fault. The owner read it as an offer
		 * and said so plainly: a file cannot be fetched into a library this gateway
		 * cannot write to, so the line answers a question this control does not ask. Why
		 * a library is unreachable belongs on the libraries screen, where it can be fixed.
		 */
		it('never lists a library this gateway cannot write into', () => {
			const { wrapper } = mapping({
				categories: [
					category({ libraryIds: ['l1', 'l3'] }),
					category({ key: 'movies', name: 'Movies', kind: LibraryKind.MOVIES, libraryIds: ['l2'] }),
				],
				rejected: [{ id: 'l3', name: 'Séries', serviceName: 'Lab (a friend)', reason: 'not_ours' }],
			});
			const items = destinationSelect(wrapper, 'shows').props('items') as
				{ value: string; title: string }[];

			expect(items.some(one => one.title === 'Séries')).toBe(false);
			expect(items.map(one => one.value)).toEqual(['/media/shows', '/media/shows2']);
		});

		it('stores the folder that was chosen, exactly as chosen', async () => {
			/*
			 * What the placement reads is a directory. Storing a library instead would put
			 * the file in whichever of its roots came first — which is precisely what
			 * nobody could see and nobody could change.
			 */
			const { wrapper } = mapping({ modelValue: { shows: '/media/shows' } });

			destinationSelect(wrapper, 'movies').vm.$emit('update:modelValue', '/media/movies');
			await nextTick();

			// Replaced rather than mutated, and the categories already answered are kept.
			expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0])
				.toEqual({ shows: '/media/shows', movies: '/media/movies' });
		});

		it('takes the second root of a shelf, which is the point of listing them', async () => {
			const { wrapper } = mapping({ modelValue: { shows: '/media/shows' } });

			destinationSelect(wrapper, 'shows').vm.$emit('update:modelValue', '/media/shows2');
			await nextTick();

			expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0])
				.toEqual({ shows: '/media/shows2' });
		});

		it('has no second field under the select', async () => {
			// The shelf, then a folder inside it, was two controls for one answer — and
			// the folder box opened prefilled with a path nobody had typed, which reads
			// as a decision somebody made.
			const { wrapper } = mapping({ modelValue: { shows: '/media/shows' } });

			await nextTick();

			expect(wrapper.findAllComponents({ name: 'VTextField' })
				.some(one => one.attributes('data-test') === 'category-folder-shows')).toBe(false);
		});

		it('drops the key when a category is cleared, rather than storing an empty answer', async () => {
			const { wrapper } = mapping({ modelValue: { shows: '/media/shows', movies: '/media/movies' } });

			destinationSelect(wrapper, 'shows').vm.$emit('update:modelValue', null);
			await nextTick();

			expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ movies: '/media/movies' });
		});

		it('says what choosing a destination will do — once, for the whole screen', () => {
			// "Goes to" reads as "is filed under": somebody pointed a category at a
			// library expecting one category in the library view and got two, with
			// nothing anywhere confirming or contradicting that reading. Said before the
			// choice and not in a tooltip, which is read after it or never — and said
			// once, because three copies of it in one viewport is a wall.
			const { wrapper } = mapping();
			const notes = wrapper.findAll('[data-test="category-target-merges"]');

			expect(notes).toHaveLength(1);
			expect(notes[0].text()).toContain('one category');
		});

		it('keeps saying it once categories are answered, since the consequence stands', () => {
			const { wrapper } = mapping({ modelValue: { shows: 'l1', movies: 'l2' } });

			expect(wrapper.findAll('[data-test="category-target-merges"]')).toHaveLength(1);
		});

		it('says nothing about destinations when this gateway has no category of its own', () => {
			const { wrapper } = mapping({ categories: [gateway.categories[2]] });

			expect(wrapper.find('[data-test="category-target-merges"]').exists()).toBe(false);
			expect(wrapper.find('[data-test="category-mapping-empty"]').exists()).toBe(true);
		});
	});

	it('keeps the old order and the rename reachable, one fold away', () => {
		// Still the repair for a mapping that filed something wrongly — an alias always
		// wins over a keyword — and so it cannot simply be deleted from the screen.
		const { wrapper } = mapping();

		expect(wrapper.find('[data-test="category-mapping-order"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="settings-categories-services"]').exists()).toBe(true);
	});

	it('says when this gateway has no category of its own to file anything into', () => {
		const { wrapper } = mapping({ categories: [gateway.categories[2]] });

		expect(wrapper.find('[data-test="category-mapping-empty"]').text())
			.toContain('No category of your own yet');
	});
});
