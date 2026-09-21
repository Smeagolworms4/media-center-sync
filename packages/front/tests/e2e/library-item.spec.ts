import { type APIRequestContext, expect, test } from '@playwright/test';
import { authorized, createMediaFixture, type MediaFixture } from './fake-jellyfin';
import { API_URL, field0, signIn, test0, watchApi } from './helpers';

/**
 * One media's page, and everything on it that can say no.
 *
 * `override.spec.ts` pins down what the correction dialog *sends*. This file is about
 * the page around it, on a media the journey created (`fake-jellyfin.ts`), and above
 * all about refusals: a value the form cannot accept, and a media that has gone while
 * somebody was correcting it. Both must be refused where the person is looking — a
 * refusal that appears nowhere is the defect class this product has shipped four
 * times, and every one of them passed its unit tests.
 *
 * Serial, and in this order, because the last journey removes the fixture's server
 * from under the page, which is the only honest way to produce the second refusal.
 */
interface Item {
	title: string;
	year: number | null;
	overrides: unknown;
}

async function readItem (request: APIRequestContext, itemId: string): Promise<Item> {
	const response = await request.get(`${API_URL}/media/${itemId}`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `read failed: ${response.status()}`).toBeTruthy();
	return await response.json() as Item;
}

test.describe.serial('a media\'s page', () => {
	let fixture: MediaFixture;
	const CORRECTED = 'Journey corrected film';

	test.beforeAll(async ({ request }) => {
		fixture = await createMediaFixture(request);
	});

	test.afterAll(async ({ request }) => {
		// Already gone when the last journey ran, which is what it was about; the
		// delete then answers 404 and that is fine.
		await fixture.remove(request);
	});

	/** Where it sits, what it is, and the two questions nobody should get an error for. */
	test('shows the media, where it sits, and what matched it', async ({ page }) => {
		const failures = watchApi(page);
		await signIn(page);
		await page.goto(`/library/${fixture.film.id}`);

		await expect(page.locator(test0('page-title'))).toHaveText(fixture.film.title);
		await expect(page.locator(`.library-item_chips ${test0('sync-state')}`))
			.toHaveAttribute('data-state', 'missing');

		// The trail starts at the category the fixture's library made, and leads back.
		const trail = page.locator(test0('media-breadcrumb'));
		await expect(trail).toContainText(`Journey Films ${fixture.tag}`);

		// Only one server holds it, so nothing was correlated — and "nothing" is an
		// answer the dialog gives, not an error it shows.
		await page.locator(test0('item-matches')).click();
		const matches = page.locator(test0('matches-dialog'));
		await expect(matches.locator(test0('empty-state'))).toBeVisible();

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * Companions nobody has read yet are a different problem from missing ones.
	 *
	 * The remedy is a scan of the server, and the button has to actually ask for one
	 * and say so — a click that leaves nothing on screen reads as a broken button.
	 */
	test('offers to read the companions it has never seen, and asks the server', async ({ page }) => {
		const scans: string[] = [];
		page.on('request', one => {
			if (one.method() === 'POST' && one.url().includes(`/services/${fixture.serviceId}/scan`)) {
				scans.push(one.url());
			}
		});

		await signIn(page);
		await page.goto(`/library/${fixture.film.id}`);

		await page.locator(test0('item-companions-scan')).click();
		await expect(page.locator(test0('notify')).first()).toHaveAttribute('data-type', 'success');
		expect(scans, 'the scan button asked the server for nothing').toHaveLength(1);
	});

	/**
	 * A year the gateway would refuse is refused here, visibly, and nothing is sent.
	 *
	 * The field says something else afterwards — compared with what it said before
	 * rather than with a sentence, because the message is our rule in whichever
	 * language the browser reads. And the dialog stays open with the value in it, so
	 * the person can fix it rather than type it all again.
	 */
	test('refuses a year out of range, on the field, and sends nothing', async ({ page, request }) => {
		const sent: string[] = [];
		page.on('request', one => {
			if (one.method() === 'PUT' && one.url().includes('/override')) {
				sent.push(one.postData() ?? '');
			}
		});

		await signIn(page);
		await page.goto(`/library/${fixture.film.id}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();

		const year = page.locator(test0('override-year'));
		const saidBefore = (await year.textContent() ?? '').trim();

		await page.locator(field0('override-year')).fill('1200');
		await page.locator(test0('override-save')).click();

		await expect
			.poll(async () => (await year.textContent() ?? '').trim(), {
				message: 'the form said nothing about a year it cannot accept',
			})
			.not
			.toBe(saidBefore);

		await expect(page.locator(test0('override-form'))).toBeVisible();
		await expect(page.locator(field0('override-year'))).toHaveValue('1200');
		expect(sent, `a year out of range was sent: ${sent.join(', ')}`).toHaveLength(0);
		expect((await readItem(request, fixture.film.sourceItemId)).overrides).toBeNull();
	});

	/**
	 * Correcting a title and a year, then taking the correction back.
	 *
	 * Checked on the page — the heading is the corrected media, not the one the page
	 * loaded with — and on the gateway, which is what every rescan and correlation will
	 * read afterwards.
	 */
	test('corrects a title and a year, and takes the correction back', async ({ page, request }) => {
		const failures = watchApi(page);
		await signIn(page);
		await page.goto(`/library/${fixture.film.id}`);

		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();
		await expect(page.locator(field0('override-title'))).toHaveValue(fixture.film.title);

		await page.locator(field0('override-title')).fill(CORRECTED);
		await page.locator(field0('override-year')).fill('2020');
		await page.locator(test0('override-save')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();
		await expect(page.locator(test0('notify')).first()).toHaveAttribute('data-type', 'success');

		await expect(page.locator(test0('page-title'))).toHaveText(CORRECTED);
		const corrected = await readItem(request, fixture.film.sourceItemId);
		expect(corrected.title).toBe(CORRECTED);
		expect(corrected.year).toBe(2020);

		// Reopened, it says what the server had said, which is what makes a correction
		// something somebody can judge.
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-title-was'))).toContainText(fixture.film.title);

		await page.locator(test0('override-restore')).click();
		await expect(page.locator(test0('override-form'))).toBeHidden();
		await expect(page.locator(test0('page-title'))).toHaveText(fixture.film.title);

		const restored = await readItem(request, fixture.film.sourceItemId);
		expect(restored.overrides).toBeNull();
		expect(restored.title).toBe(fixture.film.title);
		expect(restored.year).toBe(2019);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	/**
	 * The media went away while somebody was correcting it.
	 *
	 * A server removed in another tab takes its media with it, and the correction then
	 * has nothing to land on. The gateway refuses it; the dialog has to say so, on the
	 * form, rather than close as if it had worked or sit there with a spinner.
	 */
	test('refuses a correction to a media that has gone, and says so on the form', async ({ page, request }) => {
		await signIn(page);
		await page.goto(`/library/${fixture.film.id}`);
		await page.locator(test0('item-override')).click();
		await expect(page.locator(test0('override-form'))).toBeVisible();
		await page.locator(field0('override-title')).fill(CORRECTED);

		const removed = await request.delete(`${API_URL}/services/${fixture.serviceId}`, {
			headers: await authorized(request),
		});
		expect(removed.ok(), `could not remove the fixture: ${removed.status()}`).toBeTruthy();

		await page.locator(test0('override-save')).click();

		const error = page.locator(test0('form-main-error'));
		await expect(error, 'the refusal appeared nowhere on the form').toBeVisible();
		await expect(error).not.toContainText('error.');
		await expect(page.locator(test0('override-form'))).toBeVisible();
	});
});
