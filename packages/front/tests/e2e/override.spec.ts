import { type APIRequestContext, expect, test } from '@playwright/test';
import { API_URL, apiToken, field0, signIn, test0, watchApi } from './helpers';

/**
 * Correcting what a media server got wrong.
 *
 * The screen is one dialog, and everything that matters about it is invisible: what
 * it *sends*. The API draws a distinction a form does not — a field left alone is
 * absent from the body and the service keeps deciding it, a field erased on purpose
 * is `null` and the value is gone — and an interface that collapsed the two would
 * silently delete a title the day somebody corrected a year.
 *
 * So these journeys read the request the browser actually made. Asserting on the
 * screen afterwards would pass just as well against a body carrying every field it
 * ever rendered, which is exactly the bug worth catching.
 *
 * Serial: the second journey restores what the first one corrected, and both work on
 * a real media of the running gateway rather than on a fixture nobody else can see.
 */
interface Correctable {
	itemId: string;
	title: string;
	year: number;
	overview: string;
}

/** A media of this gateway that has something to correct, and no correction yet. */
async function pickCorrectable (request: APIRequestContext): Promise<Correctable> {
	const token = await apiToken(request);
	const headers = { Authorization: `Bearer ${token}` };

	const listed = await request.get(`${API_URL}/media/groups?rootsOnly=true&limit=50`, { headers });
	expect(listed.ok(), `groups failed: ${listed.status()}`).toBeTruthy();
	const groups = (await listed.json() as { items: { id: string }[] }).items;

	for (const group of groups) {
		const read = await request.get(`${API_URL}/media/${group.id}`, { headers });
		if (!read.ok()) {
			continue;
		}
		const item = await read.json() as {
			id: string;
			title: string;
			year: number | null;
			overview: string | null;
			overrides: unknown;
		};
		if (item.year !== null && (item.overview ?? '') !== '' && item.overrides === null) {
			return {
				itemId: item.id,
				title: item.title,
				year: item.year,
				overview: item.overview ?? '',
			};
		}
	}

	throw new Error('no uncorrected media with a year and an overview: nothing to correct here');
}

async function clearOverride (request: APIRequestContext, itemId: string): Promise<void> {
	const token = await apiToken(request);
	await request.delete(`${API_URL}/media/${itemId}/override`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

test.describe.serial('correcting a media', () => {
	let target: Correctable;
	const CORRECTED_TITLE = 'Journey correction';

	test.beforeAll(async ({ request }) => {
		target = await pickCorrectable(request);
	});

	// The gateway is shared with every other journey, and a title nobody put back
	// would follow this one around for the rest of the run.
	test.afterAll(async ({ request }) => {
		await clearOverride(request, target.itemId);
	});

	test('sends the corrected fields, the erased ones as null, and nothing else', async ({ page }) => {
		const failures = watchApi(page);
		const bodies: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PUT' && one.url().includes('/override')) {
				bodies.push(one.postData() ?? '');
			}
		});

		await signIn(page);
		await page.goto(`/library/${target.itemId}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();

		// It opens on the values in force, which is what makes it a correction rather
		// than a form somebody has to fill in again from nothing.
		await expect(page.locator(field0('override-title'))).toHaveValue(target.title);

		await page.locator(field0('override-title')).fill(CORRECTED_TITLE);

		/*
		 * Emptying a box is not erasing a field.
		 *
		 * It means "I am not correcting this", and the overview has to stay the
		 * service's — the alternative deletes a description because somebody selected
		 * the text and pressed backspace.
		 */
		await page.locator(field0('override-overview')).fill('');

		// The eraser, which is the only way to say "this value is wrong and there is
		// no right one" — the year a scraper took from a re-release.
		await page.locator(test0('override-year-clear')).click();
		await expect(page.locator(test0('override-year-cleared'))).toBeVisible();
		// Emptied there and then, rather than one click later: the box and the note
		// under it are one decision, and a box still showing a value it is about to
		// send as `null` is the worst of both.
		await expect(page.locator(field0('override-year'))).toHaveValue('');

		await page.locator(test0('override-save')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();

		expect(bodies, 'the dialog sent no correction at all').toHaveLength(1);
		const body = JSON.parse(bodies[0]) as Record<string, unknown>;
		expect(body.title).toBe(CORRECTED_TITLE);
		expect('year' in body, 'the erased year was not sent').toBe(true);
		expect(body.year).toBeNull();
		expect('overview' in body, 'an emptied box was sent as a correction').toBe(false);
		expect('seriesTitle' in body, 'a field nobody touched was sent').toBe(false);
		expect('libraryId' in body, 'the media was reclassified by nobody').toBe(false);

		// And the page is the corrected media afterwards, not the one it was: the
		// correction is written into the fields everything reads.
		await expect(page.locator(test0('page-title'))).toHaveText(CORRECTED_TITLE);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('says what the service had said, and puts all of it back', async ({ page, request }) => {
		const failures = watchApi(page);

		await signIn(page);
		await page.goto(`/library/${target.itemId}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();

		// A correction that cannot be compared to the service's answer is a value
		// nobody can judge: the line under the field is what says what was replaced.
		await expect(page.locator(test0('override-title-was'))).toContainText(target.title);
		await expect(page.locator(test0('override-year-cleared'))).toContainText(String(target.year));

		// The erased field can be un-erased — it is a decision, and a decision that
		// cannot be undone in the interface is a trap.
		await page.locator(test0('override-year-clear')).click();
		await expect(page.locator(test0('override-year-cleared'))).toHaveCount(0);
		await expect(page.locator(field0('override-year'))).toHaveValue(String(target.year));

		await page.locator(test0('override-restore')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();
		await expect(page.locator(test0('page-title'))).toHaveText(target.title);

		// Not merely on screen: the row itself is back to the service's answer, which
		// is what the next rescan and every correlation will read.
		const token = await apiToken(request);
		const read = await request.get(`${API_URL}/media/${target.itemId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const item = await read.json() as { title: string; year: number | null; overrides: unknown };
		expect(item.overrides).toBeNull();
		expect(item.title).toBe(target.title);
		expect(item.year).toBe(target.year);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
