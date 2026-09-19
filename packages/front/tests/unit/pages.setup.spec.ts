import { Right, UserRole } from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import Setup from '@/pages/Setup.vue';
import { useTokenStore } from '@/stores/token';
import { mountWithApp } from './helpers';

/**
 * The first screen anybody ever sees, and the one that cannot be retried.
 *
 * Everything asserted here is a mistake that would be found by somebody unpacking
 * a fresh gateway: a password refused after it was typed twice, a session thrown
 * away so the credentials have to be retyped on a sign-in page, or a form still
 * offered on a gateway that has already been claimed.
 */
const tokenPair = {
	accessToken: 'access-1',
	refreshToken: 'refresh-1',
	expiresIn: 900,
	user: {
		id: 'u1',
		username: 'ada',
		displayName: 'Ada',
		email: null,
		role: UserRole.ADMIN,
		provider: 'internal',
		providerUserId: null,
		avatarUrl: null,
		lastSeenAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	},
	rights: [Right.SETTINGS_MANAGE],
};

/**
 * A `fetch` keyed by method as well as path.
 *
 * `/auth/setup` is one path answering two very different things — the state on
 * `GET`, a session on `POST` — so a stub keyed on the path alone cannot describe
 * this page at all.
 */
function stubApi (answers: Record<string, { status?: number; body?: unknown }>): ReturnType<typeof vi.fn> {
	const stub = vi.fn((input: any, init: any) => {
		const url = String(typeof input === 'string' ? input : input?.url ?? '');
		const method = String(init?.method ?? 'GET').toUpperCase();
		const key = Object.keys(answers).find(one => {
			const [wantedMethod, path] = one.split(' ');
			return wantedMethod === method && url.includes(path);
		});
		const answer = key ? answers[key] : { status: 404, body: { message: 'error.general' } };
		const status = answer.status ?? 200;
		return Promise.resolve(new Response(
			answer.body === undefined || answer.body === null ? '' : JSON.stringify(answer.body),
			{ status, headers: { 'Content-Type': 'application/json' } },
		));
	});
	globalThis.fetch = stub as unknown as typeof fetch;
	return stub;
}

async function flush (times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

/**
 * Waits for a navigation to land.
 *
 * Every page is a lazy chunk, and a dynamic import resolves on a task rather than
 * on a microtask: a loop that only drains promises spins for ever and then fails
 * on a number that looks like an arbitrary patience setting.
 */
async function waitForRoute (router: { currentRoute: { value: { name?: unknown } } }, name: string): Promise<void> {
	for (let attempt = 0; attempt < 300 && router.currentRoute.value.name !== name; attempt += 1) {
		await flush(1);
	}
}

const FRESH = { 'GET /api/auth/setup': { body: { required: true, version: '1.4.0' } } };

describe('pages/Setup', () => {
	it('reads as a welcome, not as a form', async () => {
		stubApi(FRESH);
		const { wrapper } = mountWithApp(Setup);
		await flush();

		expect(wrapper.text()).toContain('Welcome to Media Center Sync');
		// What this gateway is, before what it wants: somebody who just ran a
		// container has no idea yet what they are creating an account for.
		expect(wrapper.text()).toContain('Index the Jellyfin and Plex servers you already run.');
		expect(wrapper.find('[data-test="setup-form"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="setup-version"]').text()).toContain('1.4.0');
	});

	it('says the password floor before anybody submits', async () => {
		stubApi(FRESH);
		const { wrapper } = mountWithApp(Setup);
		await flush();

		expect(wrapper.text()).toContain('At least 8 characters');
	});

	it('refuses a password the API was always going to refuse', async () => {
		const stub = stubApi(FRESH);
		const { wrapper } = mountWithApp(Setup);
		await flush();

		await wrapper.find('[data-test="setup-username"] input').setValue('ada');
		await wrapper.find('[data-test="setup-password"] input').setValue('short');
		await wrapper.find('[data-test="setup-confirmation"] input').setValue('short');
		await wrapper.find('form').trigger('submit');
		await flush();

		expect(wrapper.text()).toContain('Use at least 8 characters.');
		// Only the state was read: nothing was sent.
		expect(stub).toHaveBeenCalledTimes(1);
	});

	it('refuses two passwords that do not match', async () => {
		stubApi(FRESH);
		const { wrapper } = mountWithApp(Setup);
		await flush();

		await wrapper.find('[data-test="setup-username"] input').setValue('ada');
		await wrapper.find('[data-test="setup-password"] input').setValue('correct horse');
		await wrapper.find('[data-test="setup-confirmation"] input').setValue('correct hose');
		await wrapper.find('form').trigger('submit');
		await flush();

		expect(wrapper.text()).toContain('The two values do not match.');
	});

	it('creates the first administrator and keeps the session it answered', async () => {
		const stub = stubApi({
			...FRESH,
			'POST /api/auth/setup': { status: 201, body: tokenPair },
			'GET /api/services': { body: [] },
			'GET /api/libraries': { body: [] },
			'GET /api/peers': { body: [] },
			'GET /api/transfers': { body: { items: [], pagination: null } },
			'GET /api/sync/jobs': { body: { items: [], pagination: null } },
			'GET /api/media': { body: { items: [], pagination: null } },
			'GET /api/settings': { body: {} },
		});
		const { wrapper, pinia, router } = mountWithApp(Setup);
		await flush();

		await wrapper.find('[data-test="setup-display-name"] input').setValue('Ada');
		await wrapper.find('[data-test="setup-username"] input').setValue('ada');
		await wrapper.find('[data-test="setup-password"] input').setValue('correct horse');
		await wrapper.find('[data-test="setup-confirmation"] input').setValue('correct horse');
		await wrapper.find('form').trigger('submit');
		await flush(8);

		const created = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'POST');
		expect(JSON.parse(created?.[1].body as string)).toEqual({
			username: 'ada',
			password: 'correct horse',
			displayName: 'Ada',
		});

		// Signed in, rather than sent to a sign-in page to retype what was just
		// chosen: the route answered a session precisely so that this works.
		expect(useTokenStore(pinia).accessToken).toBe('access-1');

		await waitForRoute(router as never, 'dashboard');
		expect(router.currentRoute.value.name).toBe('dashboard');
	});

	it('leaves the display name out when nobody typed one', async () => {
		const stub = stubApi({
			...FRESH,
			'POST /api/auth/setup': { status: 201, body: tokenPair },
			'GET /api/settings': { body: {} },
		});
		const { wrapper } = mountWithApp(Setup);
		await flush();

		await wrapper.find('[data-test="setup-username"] input').setValue('ada');
		await wrapper.find('[data-test="setup-password"] input').setValue('correct horse');
		await wrapper.find('[data-test="setup-confirmation"] input').setValue('correct horse');
		await wrapper.find('form').trigger('submit');
		await flush(8);

		const created = stub.mock.calls.find(call => String(call[1]?.method).toUpperCase() === 'POST');
		expect(JSON.parse(created?.[1].body as string)).toEqual({
			username: 'ada',
			password: 'correct horse',
		});
	});

	it('sends somebody to the sign-in page when the gateway is already claimed', async () => {
		stubApi({ 'GET /api/auth/setup': { body: { required: false, version: '1.4.0' } } });
		const { wrapper, router } = mountWithApp(Setup);
		await flush();

		// A form whose submit can no longer succeed is worse than no form: the
		// account exists, and what this visitor needs is the way in.
		expect(wrapper.find('[data-test="setup-form"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="setup-claimed"]').exists()).toBe(true);
		await waitForRoute(router as never, 'login');
		expect(router.currentRoute.value.name).toBe('login');
	});

	it('offers a retry rather than an empty page when the gateway does not answer', async () => {
		stubApi({ 'GET /api/auth/setup': { status: 503, body: { message: 'error.general' } } });
		const { wrapper } = mountWithApp(Setup);
		await flush();

		expect(wrapper.find('.error-state').exists()).toBe(true);
		expect(wrapper.text()).toContain('Try again');
	});
});
