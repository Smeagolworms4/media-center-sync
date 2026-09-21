import type { DiscoveredServer, MediaService, DirectorySignIn as SignIn } from '@mcs/shared';
import {
	ConnectionRoute,
	DirectorySignInState,
	MediaServiceMode,
	MediaServiceStatus,
	MediaServiceType,
} from '@mcs/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ConnectionRouteChip from '@/components/service/ConnectionRouteChip.vue';
import DirectorySignIn from '@/components/service/DirectorySignIn.vue';
import ServiceAdd from '@/components/service/ServiceAdd.vue';
import Services from '@/pages/Services.vue';
import { useDirectoriesStore } from '@/stores/directories';
import { useServicesStore } from '@/stores/services';
import { createStoreContext, mountWithApp, tooltipStub } from './helpers';

/**
 * Adding Plex servers by signing in to plex.tv, as the dialog shows it.
 *
 * The gateway is a fake `fetch` answering by method and path, so a test can say what
 * each poll answers in turn — pending, then approved — the way the real one would. The
 * browser tab plex.tv opens in is a fake too: jsdom has no windows to open.
 */

async function settle (times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 5);
		});
	}
}

type Answer = { status?: number; body?: unknown };
type Route = Answer | ((init: RequestInit | undefined) => Answer);

interface Recorded {
	method: string;
	path: string;
	body: unknown;
}

/** A gateway answering `METHOD /api/path`; a route that is a function is asked every time. */
function gateway (routes: Record<string, Route>): Recorded[] {
	const calls: Recorded[] = [];

	globalThis.fetch = vi.fn((input: any, init?: RequestInit) => {
		const url = new URL(String(typeof input === 'string' ? input : input?.url), 'http://localhost');
		const method = init?.method ?? 'GET';
		const key = `${method} ${url.pathname}`;

		calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });

		const route = routes[key];
		const answer: Answer = route === undefined
			? { status: 404, body: { message: 'error.general' } }
			: (typeof route === 'function' ? route(init) : route);
		const status = answer.status ?? 200;

		return Promise.resolve(status === 204
			? new Response(null, { status })
			: new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
				status,
				headers: { 'Content-Type': 'application/json' },
			}));
	}) as unknown as typeof fetch;

	return calls;
}

function signIn (overrides: Partial<SignIn> = {}): SignIn {
	return {
		id: '5f0c4e1a-0000-4000-8000-000000000001',
		type: MediaServiceType.PLEX,
		state: DirectorySignInState.PENDING,
		authUrl: 'https://app.plex.tv/auth#?clientID=mcs-node&code=strong-code',
		code: 'strong-code',
		expiresAt: '2099-01-01T00:00:00.000Z',
		...overrides,
	};
}

function discovered (overrides: Partial<DiscoveredServer> = {}): DiscoveredServer {
	return {
		identifier: 'machine-own',
		name: 'Attic',
		owned: true,
		ownerName: null,
		version: '1.41.3',
		reachable: true,
		route: ConnectionRoute.LOCAL,
		baseUrl: 'http://192.168.1.20:32400',
		registeredServiceId: null,
		...overrides,
	};
}

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
		id: 'created-1',
		name: 'Attic',
		type: MediaServiceType.PLEX,
		shared: true,
		filesMounted: false,
		mode: MediaServiceMode.REMOTE,
		baseUrl: 'http://192.168.1.20:32400',
		status: MediaServiceStatus.ONLINE,
		version: '1.41.3',
		rootMappings: [],
		authProvider: false,
		priority: 100,
		peerId: null,
		serverIdentifier: 'machine-own',
		connectionRoute: ConnectionRoute.LOCAL,
		lastProbeAt: null,
		lastScanAt: null,
		libraryCount: 0,
		itemCount: 0,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

/** The account the owner described: his server, two friends' — one only the relay reaches — and one asleep. */
const ACCOUNT: DiscoveredServer[] = [
	discovered(),
	discovered({ identifier: 'machine-asleep', name: 'Asleep', reachable: false, route: null, baseUrl: null }),
	discovered({
		identifier: 'machine-bob',
		name: 'Home',
		owned: false,
		ownerName: 'bob',
		route: ConnectionRoute.REMOTE,
		baseUrl: 'https://82-1-2-3.bob.plex.direct:32400',
	}),
	discovered({
		identifier: 'machine-carol',
		name: 'Basement',
		owned: false,
		ownerName: 'carol',
		route: ConnectionRoute.RELAY,
		baseUrl: 'https://5-6-7-8.carol.plex.direct:8443',
	}),
];

const SIGN_IN_PATH = `/api/directories/sign-ins/${signIn().id}`;

/** A gateway where the sign-in is approved on the `approveAfter`-th poll. */
function approvingGateway (options: {
	approveAfter?: number;
	servers?: DiscoveredServer[];
	register?: Route;
} = {}): Recorded[] {
	let polls = 0;

	return gateway({
		'POST /api/directories/plex/sign-ins': { status: 201, body: signIn() },
		[`GET ${SIGN_IN_PATH}`]: () => {
			polls += 1;
			return {
				body: signIn({
					state: polls >= (options.approveAfter ?? 1) ? DirectorySignInState.APPROVED : DirectorySignInState.PENDING,
				}),
			};
		},
		[`GET ${SIGN_IN_PATH}/servers`]: { body: options.servers ?? ACCOUNT },
		[`POST ${SIGN_IN_PATH}/servers`]: options.register ?? { body: { created: [], failed: [] } },
		[`DELETE ${SIGN_IN_PATH}`]: { status: 204 },
	});
}

interface FakeTab {
	opener: unknown;
	location: { href: string };
	close: ReturnType<typeof vi.fn>;
}

let tab: FakeTab;
let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	tab = { opener: window, location: { href: '' }, close: vi.fn() };
	openSpy = vi.fn(() => tab as unknown as Window | null);
	vi.stubGlobal('open', openSpy);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function mountSignIn () {
	return mountWithApp(DirectorySignIn, {
		props: { type: MediaServiceType.PLEX, pollMs: 5 },
		global: { stubs: tooltipStub },
	});
}

describe('components/service/DirectorySignIn', () => {
	it('leads with signing in on plex.tv, and says the password is typed there', async () => {
		gateway({});
		const { wrapper } = mountSignIn();

		expect(wrapper.find('[data-test="directory-start"]').text()).toContain('Sign in with Plex');
		expect(wrapper.text()).toContain('never sees it');
		expect(wrapper.find('[data-test="directory-manual"]').exists()).toBe(true);
	});

	it('opens plex.tv in a new tab and waits, saying what it is waiting for', async () => {
		approvingGateway({ approveAfter: 1000 });
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		// Opened inside the click, before the gateway answered: a popup blocker refuses
		// a window opened once the answer is in.
		expect(openSpy).toHaveBeenCalledWith('', '_blank');
		await settle();

		expect(tab.location.href).toBe(signIn().authUrl);
		expect(tab.opener).toBeNull();

		const waiting = wrapper.find('[data-test="directory-waiting"]');
		expect(waiting.exists()).toBe(true);
		expect(waiting.text()).toContain('Waiting for you to approve on plex.tv');
		expect(waiting.text()).toContain('strong-code');
		expect(wrapper.find('[data-test="directory-open"]').attributes('href')).toBe(signIn().authUrl);
	});

	it('offers the link itself when the browser refused to open the tab', async () => {
		openSpy.mockImplementation(() => null);
		approvingGateway({ approveAfter: 1000 });
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle();

		expect(wrapper.find('[data-test="directory-popup-blocked"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="directory-open"]').attributes('href')).toBe(signIn().authUrl);
	});

	it('moves on to the servers by itself once the person approved', async () => {
		const calls = approvingGateway({ approveAfter: 2 });
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);

		expect(calls.filter(call => call.method === 'GET' && call.path === SIGN_IN_PATH).length).toBe(2);
		expect(wrapper.find('[data-test="directory-waiting"]').exists()).toBe(false);
		expect(wrapper.findAll('[data-test="discovered-server"]')).toHaveLength(4);
	});

	it('groups the servers as yours and as shared by each friend, with how each is reached', async () => {
		approvingGateway();
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);

		const groups = wrapper.findAll('[data-test="discovered-group"]');
		expect(groups.map(group => group.find('h4').text())).toEqual([
			'Your servers',
			'Shared with you by bob',
			'Shared with you by carol',
		]);
		expect(groups[0].findAll('[data-test="discovered-server"]').map(row => row.attributes('data-identifier')))
			.toEqual(['machine-own', 'machine-asleep']);

		const route = (identifier: string) => wrapper
			.find(`[data-identifier="${identifier}"] [data-test="connection-route"]`)
			.attributes('data-route');
		expect(route('machine-own')).toBe(ConnectionRoute.LOCAL);
		expect(route('machine-bob')).toBe(ConnectionRoute.REMOTE);
		expect(route('machine-carol')).toBe(ConnectionRoute.RELAY);
		expect(route('machine-asleep')).toBe('unreachable');

		// The relay says what it costs, and a server nothing answered for says so and
		// cannot be ticked.
		expect(wrapper.find('[data-identifier="machine-carol"] [data-test="discovered-relay-note"]').text())
			.toContain('very slow for pulling files');
		expect(wrapper.find('[data-identifier="machine-asleep"] [data-test="discovered-unreachable-note"]').exists())
			.toBe(true);
		expect(wrapper.find('[data-test="discovered-select-machine-asleep"] input').attributes('disabled')).toBeDefined();
	});

	it('shows a server already registered as such, and does not offer it again', async () => {
		approvingGateway({
			servers: [discovered({ registeredServiceId: 'existing-service' }), ACCOUNT[2]],
		});
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);

		const own = wrapper.find('[data-identifier="machine-own"]');
		expect(own.find('[data-test="discovered-registered"]').text()).toBe('Already registered');
		expect(own.find('input[type="checkbox"]').attributes('disabled')).toBeDefined();
		expect(wrapper.find('[data-identifier="machine-bob"] input[type="checkbox"]').attributes('disabled'))
			.toBeUndefined();
	});

	it('adds several at once and hands them back', async () => {
		const created = [service(), service({ id: 'created-2', name: 'Home (bob)', serverIdentifier: 'machine-bob' })];
		const calls = approvingGateway({ register: { body: { created, failed: [] } } });
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);

		const add = wrapper.find('[data-test="directory-add"]');
		expect(add.attributes('disabled')).toBeDefined();

		await wrapper.find('[data-test="discovered-select-machine-own"] input').setValue(true);
		await wrapper.find('[data-test="discovered-select-machine-bob"] input').setValue(true);
		expect(wrapper.find('[data-test="directory-add"]').text()).toContain('(2)');

		await wrapper.find('form').trigger('submit');
		await settle();

		const registered = calls.find(call => call.method === 'POST' && call.path === `${SIGN_IN_PATH}/servers`);
		expect(registered?.body).toEqual({ identifiers: ['machine-own', 'machine-bob'] });
		expect(wrapper.emitted('saved')?.[0]?.[0]).toEqual(created);
		// And they are in the list the services screen reads, without another request.
		expect(useServicesStore().byId['created-2']?.name).toBe('Home (bob)');
	});

	it('names every server that could not come in, and why, and keeps the rest', async () => {
		approvingGateway({
			register: {
				body: {
					created: [service()],
					failed: [{ identifier: 'machine-bob', name: 'Home', error: 'error.directory.server_unreachable' }],
				},
			},
		});
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);
		await wrapper.find('[data-test="discovered-select-machine-own"] input').setValue(true);
		await wrapper.find('[data-test="discovered-select-machine-bob"] input').setValue(true);
		await wrapper.find('form').trigger('submit');
		await settle(20);

		const failure = wrapper.find('[data-test="directory-failure"]');
		expect(failure.text()).toContain('Home');
		expect(failure.text()).toContain('answered as this server');
		expect(failure.text()).not.toContain('error.directory');
		expect(wrapper.find('[data-test="directory-created"]').text()).toContain('Attic');
		expect(wrapper.emitted('saved')).toBeUndefined();

		// Leaving now is a success for the one that came in.
		await wrapper.find('[data-test="directory-cancel"]').trigger('click');
		await settle();
		expect(wrapper.emitted('saved')?.[0]?.[0]).toEqual([service()]);
	});

	it('says so when the sign-in expired before anybody approved, and starts again on request', async () => {
		const calls = gateway({
			'POST /api/directories/plex/sign-ins': { status: 201, body: signIn() },
			[`GET ${SIGN_IN_PATH}`]: { body: signIn({ state: DirectorySignInState.EXPIRED }) },
		});
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);

		const expired = wrapper.find('[data-test="directory-expired"]');
		expect(expired.exists()).toBe(true);
		expect(expired.text()).toContain('expired before it was approved');

		await wrapper.find('[data-test="directory-retry"]').trigger('click');
		await settle(3);
		expect(calls.filter(call => call.method === 'POST' && call.path === '/api/directories/plex/sign-ins')).toHaveLength(2);
	});

	it('shows what plex.tv or the gateway refused, in words, and closes the tab it opened', async () => {
		gateway({
			'POST /api/directories/plex/sign-ins': { status: 503, body: { key: 'error.directory.unreachable' } },
		});
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle();

		const failed = wrapper.find('[data-test="directory-failed"]');
		expect(failed.text()).toContain('plex.tv did not answer');
		expect(failed.text()).not.toContain('error.directory');
		expect(tab.close).toHaveBeenCalled();
	});

	it('reports a listing refused by plex.tv rather than an empty account', async () => {
		gateway({
			'POST /api/directories/plex/sign-ins': { status: 201, body: signIn() },
			[`GET ${SIGN_IN_PATH}`]: { body: signIn({ state: DirectorySignInState.APPROVED }) },
			[`GET ${SIGN_IN_PATH}/servers`]: { status: 401, body: { key: 'error.directory.refused' } },
		});
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);

		expect(wrapper.find('[data-test="directory-failed"]').text()).toContain('refused this gateway');
		expect(wrapper.find('[data-test="directory-empty"]').exists()).toBe(false);
	});

	it('says an account with no server has none, and points at the address instead', async () => {
		approvingGateway({ servers: [] });
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle(20);

		expect(wrapper.find('[data-test="directory-empty"]').text()).toContain('reaches no server');
		expect(wrapper.find('[data-test="directory-add"]').exists()).toBe(false);
	});

	it('forgets the sign-in on the gateway when the person cancels', async () => {
		const calls = approvingGateway({ approveAfter: 1000 });
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle();
		await wrapper.find('[data-test="directory-cancel"]').trigger('click');
		await settle();

		expect(calls.some(call => call.method === 'DELETE' && call.path === SIGN_IN_PATH)).toBe(true);
		expect(wrapper.emitted('cancel')).toHaveLength(1);
		const polls = calls.filter(call => call.method === 'GET').length;
		await settle();
		expect(calls.filter(call => call.method === 'GET').length).toBe(polls);
	});

	it('stops polling and forgets the sign-in when the dialog goes away mid-wait', async () => {
		const calls = approvingGateway({ approveAfter: 1000 });
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-start"]').trigger('click');
		await settle();
		wrapper.unmount();
		await settle();

		expect(calls.some(call => call.method === 'DELETE' && call.path === SIGN_IN_PATH)).toBe(true);
	});

	it('hands over to the address form on request', async () => {
		gateway({});
		const { wrapper } = mountSignIn();

		await wrapper.find('[data-test="directory-manual"]').trigger('click');

		expect(wrapper.emitted('manual')).toHaveLength(1);
	});
});

describe('components/service/ServiceAdd', () => {
	function mountAdd () {
		return mountWithApp(ServiceAdd, { global: { stubs: tooltipStub } });
	}

	it('goes straight to the address form for a kind with no directory', async () => {
		gateway({ 'GET /api/directories': { body: [MediaServiceType.PLEX] } });
		const { wrapper } = mountAdd();
		await settle();

		expect(wrapper.find('[data-test="service-name"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="directory-sign-in"]').exists()).toBe(false);
		// The kind is chosen above, once: the form does not ask it again.
		expect(wrapper.find('[data-test="service-type"]').exists()).toBe(false);
	});

	it('leads with signing in for Plex, and keeps the address form one click away', async () => {
		gateway({ 'GET /api/directories': { body: [MediaServiceType.PLEX] } });
		const { wrapper } = mountAdd();
		await settle();

		await wrapper.find('[data-test="service-add-type-plex"]').trigger('click');
		await settle(2);
		expect(wrapper.find('[data-test="directory-sign-in"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="service-name"]').exists()).toBe(false);

		await wrapper.find('[data-test="directory-manual"]').trigger('click');
		await settle(2);
		expect(wrapper.find('[data-test="service-url"]').exists()).toBe(true);

		await wrapper.find('[data-test="directory-back"]').trigger('click');
		await settle(2);
		expect(wrapper.find('[data-test="directory-sign-in"]').exists()).toBe(true);
	});

	it('falls back to the address form for Plex, and says why, when sign-in is unavailable', async () => {
		gateway({ 'GET /api/directories': { status: 500, body: { message: 'error.general' } } });
		const { wrapper } = mountAdd();
		await settle();

		await wrapper.find('[data-test="service-add-type-plex"]').trigger('click');
		await settle(2);

		expect(wrapper.find('[data-test="directory-sign-in"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="directory-unavailable"]').text()).toContain('unavailable');
		expect(wrapper.find('[data-test="service-url"]').exists()).toBe(true);
	});
});

describe('components/service/ConnectionRouteChip', () => {
	it('shows nothing for an address somebody typed', () => {
		const { wrapper } = mountWithApp(ConnectionRouteChip, { props: { route: null } });

		expect(wrapper.find('[data-test="connection-route"]').exists()).toBe(false);
	});

	it('calls the relay the relay, and an unreachable server unreachable', () => {
		const relay = mountWithApp(ConnectionRouteChip, { props: { route: ConnectionRoute.RELAY } });
		const down = mountWithApp(ConnectionRouteChip, { props: { route: null, reachable: false } });

		expect(relay.wrapper.text()).toBe('Plex relay only');
		expect(down.wrapper.find('[data-test="connection-route"]').attributes('data-route')).toBe('unreachable');
	});
});

describe('pages/Services, for a server found through plex.tv', () => {
	it('says in words that a service only the relay reaches will be slow to pull from', async () => {
		gateway({
			'GET /api/services': {
				body: [
					service({ id: 'relayed', name: 'Basement (carol)', connectionRoute: ConnectionRoute.RELAY }),
					service({ id: 'typed', name: 'Typed', connectionRoute: null, serverIdentifier: null }),
				],
			},
		});
		const { wrapper } = mountWithApp(Services, { global: { stubs: tooltipStub } });
		await settle();

		const relayed = wrapper.find('[data-test="service-row"][data-id="relayed"]');
		expect(relayed.find('[data-test="connection-route"]').attributes('data-route')).toBe(ConnectionRoute.RELAY);
		expect(relayed.find('[data-test="service-relay-note"]').text()).toContain('very slow for pulling files');

		const typed = wrapper.find('[data-test="service-row"][data-id="typed"]');
		expect(typed.find('[data-test="connection-route"]').exists()).toBe(false);
		expect(typed.find('[data-test="service-relay-note"]').exists()).toBe(false);
	});
});

describe('stores/directories', () => {
	it('treats a gateway that answers no list as offering no sign-in', async () => {
		createStoreContext();
		gateway({ 'GET /api/directories': { body: null } });

		await expect(useDirectoriesStore().loadTypes()).resolves.toEqual([]);
	});
});
