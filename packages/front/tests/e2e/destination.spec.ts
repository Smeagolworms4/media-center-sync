import { type APIRequestContext, expect, test } from '@playwright/test';
import { authorized, journeyTag, useOwnDestination } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';

/**
 * Where a pull lands when no category names a destination.
 *
 * The one destination most people ever set, and the step of the placement rule every
 * unconfigured category falls back to. Two things have to be true on screen for it to
 * be safe. The menu offers only libraries a pull can really land in — ours, writable —
 * and when there are none it says why rather than sitting empty, because a blank
 * select reads as broken. And every category nobody configured names what it falls
 * back to, so that choosing a library here visibly changes where their media goes.
 *
 * Fixtures: the first and last journeys need nothing but the gateway. The second needs
 * a library it may write into, which only exists if the journey makes one: it takes it
 * from `useOwnDestination` in `./fake-jellyfin.ts`, which raises a server of its own
 * and a directory the gateway can write to, and skips — saying so — when the gateway
 * cannot write where the journeys make directories (`E2E_LANDING_PATH`).
 *
 * Every setting touched is read first and put back in a `finally`: the destination is
 * global, and leaving it on a library that is about to be deleted sends the next pull
 * anybody makes to a path that no longer exists.
 */
interface Library {
	id: string;
	name: string;
	alias: string | null;
	serviceId: string;
	writable: boolean;
}

interface Service {
	id: string;
	mode: string;
}

interface Category {
	key: string;
	libraryIds: string[];
}

interface Placement {
	defaultTargetLibraryId: string | null;
	defaultTargetPath: string | null;
}

async function read<T> (request: APIRequestContext, path: string): Promise<T> {
	const response = await request.get(`${API_URL}${path}`, { headers: await authorized(request) });
	expect(response.ok(), `${path} failed: ${response.status()}`).toBeTruthy();
	return await response.json() as T;
}

async function placementOf (request: APIRequestContext): Promise<Placement> {
	const settings = await read<Placement>(request, '/settings');
	return {
		defaultTargetLibraryId: settings.defaultTargetLibraryId ?? null,
		defaultTargetPath: settings.defaultTargetPath ?? null,
	};
}

/**
 * Puts the destination back, and writes nothing when nothing moved.
 *
 * Settings are sparse — a key nobody changed has no row — so writing back a value that
 * was never altered would turn a default into an explicit choice nobody made, and hide
 * for ever which of the two it was.
 */
async function restore (request: APIRequestContext, placement: Placement): Promise<void> {
	const current = await placementOf(request);
	const same = (key: keyof Placement): boolean => current[key] === placement[key];
	if (same('defaultTargetLibraryId') && same('defaultTargetPath')) {
		return;
	}

	const response = await request.patch(`${API_URL}/settings`, {
		headers: await authorized(request),
		data: placement,
	});
	expect(response.ok(), `the destination was not put back: ${response.status()}`).toBeTruthy();
}

test.describe('default destination', () => {
	test('the menu offers exactly the libraries a pull can land in, or says why it offers none', async ({ page, request }) => {
		/*
		 * The expectation is the gateway's own answer, worked out the way the screen
		 * works it out: a library of a service whose files we reach, and which we can
		 * write into. That is an invariant of whatever this stack holds, so it is as true
		 * on a gateway with nothing registered as on one with a whole catalogue.
		 */
		const [libraries, services] = await Promise.all([
			read<Library[]>(request, '/libraries'),
			read<Service[]>(request, '/services'),
		]);
		const ours = new Set(services.filter(one => one.mode === 'local').map(one => one.id));
		const offerable = libraries.filter(one => ours.has(one.serviceId) && one.writable);

		const failures = watchApi(page);
		await signIn(page);
		await page.goto('/settings');

		const select = page.locator(test0('settings-default-target-library'));
		await expect(select).toBeVisible();
		// Enabled once the libraries are in, so what follows is read off a loaded menu
		// rather than off the one drawn while the page was still asking.
		await expect(page.locator(field0('settings-default-target-library'))).toBeEnabled();

		const none = page.locator(test0('settings-destination-none'));

		if (offerable.length === 0) {
			// A menu with nothing in it and no sentence under it reads as a bug; the
			// sentence says that no library can receive a file, which is the fact.
			await expect(none).toBeVisible();
			await expect(none).not.toHaveText('');
		} else {
			await expect(none).toHaveCount(0);

			await select.click();
			const options = page.getByRole('option');
			await expect(options).toHaveCount(offerable.length);
			for (const library of offerable) {
				await expect(options.filter({ hasText: library.alias ?? library.name }).first()).toBeVisible();
			}
			await page.keyboard.press('Escape');
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('choosing a library is what every unconfigured category then says it falls back to', async ({ page, request }) => {
		const before = await placementOf(request);
		const destination = await useOwnDestination(request, journeyTag());
		test.skip(
			destination === null,
			'the gateway cannot write where the journeys make directories: set E2E_LANDING_PATH to that '
			+ 'directory as the gateway sees it',
		);

		const failures = watchApi(page);

		try {
			// `useOwnDestination` points the default at its library for the pulls it was
			// written for. This journey is about choosing it, so it starts from the
			// state somebody arrives in: nothing chosen.
			await restore(request, { ...before, defaultTargetLibraryId: null });

			const categories = await read<Category[]>(request, '/libraries/categories');
			const category = categories.find(one => one.libraryIds.includes(destination!.libraryId));
			expect(category, 'the fixture library belongs to no category').toBeDefined();

			await signIn(page);
			await page.goto('/settings');
			// The choice below is made once the page has filled itself from what is
			// stored, or the fill would put the default back over it before the save.
			await page.waitForLoadState('networkidle');

			const row = page.locator(`${test0('category-mapping-row')}[data-category="${category!.key}"]`);
			await expect(row).toHaveAttribute('data-configured', 'false');

			/*
			 * Left empty, it names what it falls back to — never nothing.
			 *
			 * The folder when one is set, and otherwise the sentence saying there is
			 * none. Either is an answer; a blank select with nothing under it is the one
			 * thing that must not be on this screen.
			 */
			const fallback = row.locator(test0('category-target-fallback'));
			await expect(fallback).toBeVisible();
			await expect(fallback).not.toHaveText('');
			await expect(fallback).not.toContainText(destination!.libraryName);
			if (before.defaultTargetPath) {
				await expect(fallback).toContainText(before.defaultTargetPath);
			}

			// By the start of the option's name: the other fixture library's line names
			// the service it sits on, which carries the same words further along.
			await page.locator(test0('settings-default-target-library')).click();
			await page.getByRole('option', { name: new RegExp(`^${destination!.libraryName}`) })
				.filter({ visible: true })
				.click();

			const saved = page.waitForResponse(one => one.request().method() === 'PATCH' && one.url().endsWith('/settings'));
			await page.locator(test0('settings-save')).click();
			expect((await saved).ok(), 'the destination was refused').toBe(true);

			expect((await placementOf(request)).defaultTargetLibraryId).toBe(destination!.libraryId);
			// And the consequence is stated where somebody reads about their category:
			// its media now goes to the library just chosen.
			await expect(fallback).toContainText(destination!.libraryName);
		} finally {
			await destination?.release(request);
			await restore(request, before);
		}

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('a fallback folder that is not a path is refused on its own pane, whichever is open', async ({ page }) => {
		/*
		 * Nothing to put back, on purpose.
		 *
		 * This journey must not write, and what proves it is the absence of a request
		 * from this page — not a comparison of the setting before and after, which on a
		 * shared stack also measures every other journey running against it. Restoring
		 * "just in case" would be worse still: it would overwrite whatever somebody
		 * else had set in the meantime, for a change this journey never made.
		 */
		const failures = watchApi(page);
		const attempts: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PATCH' && one.url().endsWith('/settings')) {
				attempts.push(one.url());
			}
		});

		await signIn(page);
		await page.goto('/settings');
		// Typed into only once the stored values are in: the page fills every field
		// when its loads settle, and a value typed earlier is overwritten and then
		// saved — the whole screen written back instead of a refusal.
		await page.waitForLoadState('networkidle');

		// A relative path is a folder nobody can find: relative to what, on which
		// machine. The gateway would have to guess, and a guess is where files land
		// somewhere the media server never scans.
		const folder = page.locator(field0('settings-default-target'));
		await folder.fill('not/a/path');

		// Away from the pane, so the refusal has somewhere to hide.
		await page.locator(test0('settings-tab-peers')).click();
		await expect(folder).toBeHidden();

		// Still what was typed, right before the button that would otherwise save it.
		await expect(folder).toHaveValue('not/a/path');
		await page.locator(test0('settings-save')).click();

		await expect(page.locator(test0('settings-tab-error'))).toBeVisible();
		await expect(page.locator(field0('settings-default-target'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(attempts, `the settings were saved anyway: ${attempts.join(', ')}`).toHaveLength(0);
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
