import { AuthProviderType, Right, UserRole } from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import Login from '@/pages/Login.vue';
import { useTokenStore } from '@/stores/token';
import { mountWithApp, stubFetch } from './helpers';

const internal = {
	key: 'internal',
	type: AuthProviderType.INTERNAL,
	label: 'Gateway account',
	icon: 'key',
	credentials: true,
};

const jellyfin = {
	key: 'service:1',
	type: AuthProviderType.SERVICE,
	label: 'Jellyfin (attic)',
	icon: 'jellyfin',
	credentials: true,
};

const oidc = {
	key: 'oidc',
	type: AuthProviderType.OIDC,
	label: 'Company SSO',
	icon: 'key',
	credentials: false,
	redirectUrl: 'https://sso.example.org/authorize',
};

const tokenPair = {
	accessToken: 'access-1',
	refreshToken: 'refresh-1',
	expiresIn: 900,
	user: {
		id: 'u1',
		username: 'ada',
		displayName: 'Ada',
		email: null,
		role: UserRole.USER,
		provider: 'internal',
		providerUserId: null,
		avatarUrl: null,
		lastSeenAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	},
	rights: [Right.LIBRARY_READ],
};

async function flush (times = 4): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

describe('pages/Login', () => {
	it('shows a spinner until the providers arrive', async () => {
		stubFetch([{ body: [internal] }]);
		const { wrapper } = mountWithApp(Login);

		expect(wrapper.find('.login_loading').exists()).toBe(true);

		await flush();
		expect(wrapper.find('.login_loading').exists()).toBe(false);
		expect(wrapper.find('.login_form').exists()).toBe(true);
	});

	it('hides the provider picker when there is only one way in', async () => {
		stubFetch([{ body: [internal] }]);
		const { wrapper } = mountWithApp(Login);
		await flush();

		expect(wrapper.find('.login_provider').exists()).toBe(false);
		expect(wrapper.find('.login_username').exists()).toBe(true);
		expect(wrapper.find('.login_password').exists()).toBe(true);
	});

	it('offers the picker as soon as there are several', async () => {
		stubFetch([{ body: [internal, jellyfin] }]);
		const { wrapper } = mountWithApp(Login);
		await flush();

		expect(wrapper.find('.login_provider').exists()).toBe(true);
	});

	it('explains itself instead of dying when the gateway offers nothing', async () => {
		stubFetch([{ body: [] }]);
		const { wrapper } = mountWithApp(Login);
		await flush();

		expect(wrapper.text()).toContain('No way in is configured');
		expect(wrapper.find('.login_form').exists()).toBe(false);
		// The retry button is the only way out of this state, so it has to be there.
		expect(wrapper.text()).toContain('Try again');
	});

	it('retries the provider list after a failure', async () => {
		const stub = stubFetch([
			{ status: 503, body: { statusCode: 503, message: 'error.general' } },
			{ body: [internal] },
		]);
		const { wrapper } = mountWithApp(Login);
		await flush();

		expect(wrapper.text()).toContain('Something went wrong');

		await wrapper.find('.error-state button').trigger('click');
		await flush();

		expect(stub).toHaveBeenCalledTimes(2);
		expect(wrapper.find('.login_form').exists()).toBe(true);
	});

	it('refuses to submit before the credentials are filled in', async () => {
		const stub = stubFetch([{ body: [internal] }]);
		const { wrapper } = mountWithApp(Login);
		await flush();

		await wrapper.find('form').trigger('submit');
		await flush();

		// Only the provider list was fetched: the form never reached the API.
		expect(stub).toHaveBeenCalledTimes(1);
		expect(wrapper.text()).toContain('This field is required.');
	});

	it('signs in and keeps the session', async () => {
		const stub = stubFetch([{ body: [internal] }, { body: tokenPair }]);
		const { wrapper, pinia, router } = mountWithApp(Login);
		await flush();

		await wrapper.find('.login_username input').setValue('ada');
		await wrapper.find('.login_password input').setValue('secret');
		await wrapper.find('form').trigger('submit');
		await flush(8);

		expect(stub.mock.calls[1][0]).toBe('/api/auth/login');
		expect(JSON.parse((stub.mock.calls[1][1] as RequestInit).body as string)).toEqual({
			provider: 'internal', username: 'ada', password: 'secret',
		});
		expect(useTokenStore(pinia).accessToken).toBe('access-1');
		expect(router.currentRoute.value.name).toBe('dashboard');
	});

	it('shows the refusal from the API against the whole form', async () => {
		stubFetch([
			{ body: [internal] },
			{ status: 401, body: { statusCode: 401, message: 'error.auth.invalid_credentials' } },
		]);
		const { wrapper } = mountWithApp(Login);
		await flush();

		await wrapper.find('.login_username input').setValue('ada');
		await wrapper.find('.login_password input').setValue('nope');
		await wrapper.find('form').trigger('submit');
		await flush(8);

		expect(wrapper.find('.form-main-error').text()).toBe('Wrong username or password.');
	});

	it('maps a field error from the API onto its input', async () => {
		stubFetch([
			{ body: [internal] },
			{ status: 400, body: { statusCode: 400, message: ['username must be longer than 2 characters'] } },
		]);
		const { wrapper } = mountWithApp(Login);
		await flush();

		await wrapper.find('.login_username input').setValue('a');
		await wrapper.find('.login_password input').setValue('secret');
		await wrapper.find('form').trigger('submit');
		await flush(8);

		expect(wrapper.find('.login_username').text()).toContain('must be longer than 2 characters');
	});

	it('asks for no credentials when the provider redirects away', async () => {
		stubFetch([{ body: [oidc] }]);
		const assign = vi.fn();
		vi.spyOn(window, 'location', 'get').mockReturnValue({ assign } as unknown as Location);

		const { wrapper } = mountWithApp(Login);
		await flush();

		expect(wrapper.find('.login_username').exists()).toBe(false);
		expect(wrapper.text()).toContain('Company SSO');

		await wrapper.find('form').trigger('submit');
		await flush();

		expect(assign).toHaveBeenCalledWith('https://sso.example.org/authorize');
	});
});
