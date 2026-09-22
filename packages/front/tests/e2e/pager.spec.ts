import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import {
	authorized,
	type FakeCatalogue,
	type FakeJellyfin,
	journeyTag,
	startFakeJellyfin,
	until,
} from './fake-jellyfin';
import { API_URL, signIn, test0, watchApi } from './helpers';

/**
 * Paging the library wall, from a browser, because that is the only place it broke.
 *
 * `GET /api/media/groups?…&page=0` answers **400 `page must not be less than 1`** — the
 * API counts pages from one and is right to refuse a zero. The wall counted from zero
 * in the address and converted in one of the two branches that build a request, so
 * pressing "next" on an opened category sent a number the API refuses, or sent `page: 1`
 * for every page and quietly showed the first one again.
 *
 * Neither half is visible to a unit test on the request builder alone: what has to hold
 * is that the address bar, the request and the rows on screen all say the same page —
 * and that a link carrying one opens on it. So this journey clicks, reads the address,
 * reads every answer the gateway gave, and reloads.
 *
 * Its own media server, because the wall needs more media than fit on a page and the
 * gateway must not be asked to paginate somebody's real catalogue.
 */

/** Enough films to page, with a page size the control actually offers. */
const FILMS = 12;
const PAGE_SIZE = 10;

function catalogue (tag: string): FakeCatalogue {
	const films = `pager-films-${tag}`;

	return {
		serverName: `Pager Jellyfin ${tag}`,
		libraries: [{
			externalId: films,
			name: `Pager Films ${tag}`,
			collectionType: 'movies',
			locations: ['/data/pager'],
		}],
		items: Array.from({ length: FILMS }, (_, index) => ({
			Id: `${tag}-film-${index}`,
			Type: 'Movie' as const,
			// Zero-padded, so the alphabetical order the wall sorts by is also the
			// numeric one and the two pages can be told apart by name.
			Name: `Pager Film ${String(index).padStart(2, '0')} ${tag}`,
			library: films,
			ProductionYear: 2000 + index,
			Path: `/data/pager/film-${index}.mkv`,
			DateCreated: '2024-01-01T09:00:00.0000000Z',
		})),
	};
}

interface PagerFixture {
	categoryKey: string;
	serviceId: string;
	server: FakeJellyfin;
}

async function createPagerFixture (request: APIRequestContext): Promise<PagerFixture> {
	const tag = journeyTag();
	const server = await startFakeJellyfin(catalogue(tag));
	const headers = await authorized(request);

	const created = await request.post(`${API_URL}/services`, {
		headers,
		// Never offered to peers: a fixture that advertises itself to somebody else's
		// gateway is a fixture that outlives the run on their side.
		data: { name: `Pager fixture ${tag}`, type: 'jellyfin', shared: false, baseUrl: server.baseUrl },
	});
	expect(created.ok(), `fixture service failed: ${created.status()} ${await created.text()}`)
		.toBeTruthy();
	const service = await created.json() as { id: string };

	const scanned = await request.post(`${API_URL}/services/${service.id}/scan`, { headers });
	expect(scanned.ok(), `scan failed: ${scanned.status()}`).toBeTruthy();

	// The scan answers before it has walked anything, so what proves it finished is the
	// rows it wrote — never a delay, which is the same wait spelled as a flake.
	await until(
		async () => {
			const listed = await request.get(
				`${API_URL}/media/groups?rootsOnly=true&limit=50&serviceIds=${service.id}`,
				{ headers },
			);
			return (await listed.json() as { items: unknown[] }).items;
		},
		items => items.length === FILMS,
		`the scan did not produce the ${FILMS} films the wall needs to page`,
	);

	return { categoryKey: `pager-films-${tag}`, serviceId: service.id, server };
}

/** Every answer the gateway gave to a grouped listing, so a 400 cannot pass unnoticed. */
function watchGroups (page: Page): { url: string; status: number }[] {
	const calls: { url: string; status: number }[] = [];

	page.on('response', response => {
		if (response.url().includes('/api/media/groups?')) {
			calls.push({ url: response.url(), status: response.status() });
		}
	});

	return calls;
}

async function titles (page: Page): Promise<string[]> {
	return page.locator(test0('media-card')).locator(test0('media-open')).allInnerTexts();
}

test.describe.serial('paging an opened category', () => {
	let fixture: PagerFixture;

	test.beforeAll(async ({ request }) => {
		fixture = await createPagerFixture(request);
	});

	test.afterAll(async ({ request }) => {
		await request.delete(`${API_URL}/services/${fixture.serviceId}`, {
			headers: await authorized(request),
		});
		await fixture.server.close();
	});

	test('asks for the next page, and every side says the same number', async ({ page }) => {
		const failures = watchApi(page);
		const groups = watchGroups(page);

		await signIn(page);
		await page.goto(`/library?category=${fixture.categoryKey}&limit=${PAGE_SIZE}`);

		const pager = page.locator(test0('pagination'));
		await expect(pager).toBeVisible();
		// The pager can only draw itself if the route told it how many there are; a
		// "next" offered without a total is the same class of defect as one that sends
		// a page number the API refuses.
		await expect(pager.locator(test0('pagination-range'))).toContainText(String(FILMS));
		await expect(page.locator(test0('media-card'))).toHaveCount(PAGE_SIZE);

		const first = await titles(page);

		await pager.locator(test0('pagination-next')).click();

		// The address says two — never zero, which is what the API refuses and what
		// pressing this button used to write.
		await expect(page).toHaveURL(/[?&]page=2(&|$)/);
		await expect(page.locator(test0('media-card'))).toHaveCount(FILMS - PAGE_SIZE);

		const second = await titles(page);

		// A different page, not the first one served again: that is what "paging does
		// nothing at all" looked like from here.
		expect(second).not.toEqual(first);
		expect(second.some(title => first.includes(title))).toBe(false);

		// And the gateway accepted every question the wall asked it.
		expect(groups.filter(call => call.status !== 200)).toEqual([]);
		expect(groups.some(call => call.url.includes('page=2'))).toBe(true);
		expect(groups.some(call => call.url.includes('page=0'))).toBe(false);

		// The pager's own state survives the reload it is in the address for.
		await page.reload();
		await expect(page).toHaveURL(/[?&]page=2(&|$)/);
		await expect(page.locator(test0('media-card'))).toHaveCount(FILMS - PAGE_SIZE);
		expect(await titles(page)).toEqual(second);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('opens a shared link on the page it names', async ({ page }) => {
		const failures = watchApi(page);
		const groups = watchGroups(page);

		await signIn(page);
		await page.goto(`/library?category=${fixture.categoryKey}&limit=${PAGE_SIZE}&page=2`);

		await expect(page.locator(test0('media-card'))).toHaveCount(FILMS - PAGE_SIZE);
		expect(groups.some(call => call.url.includes('page=2'))).toBe(true);
		expect(groups.filter(call => call.status !== 200)).toEqual([]);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});

	test('answers a hand-edited page zero with the first page rather than an error', async ({ page }) => {
		// A truncated or hand-edited link is the ordinary way `page=0` happens, and the
		// API is right to refuse it — a wall that forwards it shows a red error where
		// the posters should be.
		const failures = watchApi(page);
		const groups = watchGroups(page);

		await signIn(page);
		await page.goto(`/library?category=${fixture.categoryKey}&limit=${PAGE_SIZE}&page=0`);

		await expect(page.locator(test0('media-card'))).toHaveCount(PAGE_SIZE);
		await expect(page.locator(test0('error-state'))).toHaveCount(0);
		expect(groups.some(call => call.url.includes('page=1'))).toBe(true);
		expect(groups.filter(call => call.status !== 200)).toEqual([]);

		await page.waitForLoadState('networkidle');
		expect(failures, failures.join('\n')).toHaveLength(0);
	});
});
