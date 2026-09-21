import { type APIRequestContext, expect } from '@playwright/test';
import { authorized } from './fake-jellyfin';
import { API_URL } from './helpers';

/**
 * Fixtures that need a media server that actually answers.
 *
 * Most journeys need nothing but the gateway, and most of the rest are served by
 * `./fake-jellyfin.ts`, which answers the calls a probe and a scan make. A few cannot
 * be written either way — only a real Jellyfin walks into a folder below what it
 * reported, only a real Plex answers a request to walk deeper by ignoring the path —
 * and those take the servers of `docker/lab/` as their fixture.
 *
 * The servers are named by variables rather than assumed, and a journey that needs one
 * skips with the reason when it is absent. Assuming them would give a journey that
 * passes on a workstation where the lab happens to be up and fails on a runner for a
 * reason nobody can reproduce, which is worse than no journey at all.
 *
 * What these journeys register is theirs: a service under a name of their own,
 * unshared, removed in a `finally`. The address has to be one no other registration on
 * that gateway uses — the gateway refuses the same server twice, because the same
 * address twice is two of everything it holds — so on a gateway that already has the
 * lab registered, give these another spelling of it (`127.0.0.1` for `localhost`).
 */
export interface LabServer {
	url: string;
	token: string;
}

export const LAB_JELLYFIN: LabServer = {
	url: process.env.E2E_JELLYFIN_URL ?? '',
	token: process.env.E2E_JELLYFIN_TOKEN ?? '',
};

/**
 * An account on that Jellyfin, for the journeys about somebody signing in through it.
 *
 * Named rather than defaulted to the lab's `lab`/`lab`: a default would make a journey
 * run against whatever Jellyfin the URL points at with a password guessed for it, and
 * fail as "invalid credentials" — which reads as a gateway defect.
 */
export const LAB_JELLYFIN_ACCOUNT = {
	username: process.env.E2E_JELLYFIN_USER ?? '',
	password: process.env.E2E_JELLYFIN_PASSWORD ?? '',
};

export const LAB_PLEX: LabServer = {
	url: process.env.E2E_PLEX_URL ?? '',
	// The lab's Plex is unclaimed and answers its own network without a token.
	token: process.env.E2E_PLEX_TOKEN ?? '',
};

export const NEEDS_JELLYFIN
	= 'needs a Jellyfin that answers: set E2E_JELLYFIN_URL and E2E_JELLYFIN_TOKEN (the lab, `make lab/up`)';

export const NEEDS_JELLYFIN_ACCOUNT = [
	'needs an account on a Jellyfin that answers: set E2E_JELLYFIN_URL, E2E_JELLYFIN_TOKEN,',
	'E2E_JELLYFIN_USER and E2E_JELLYFIN_PASSWORD (the lab, `make lab/up`)',
].join(' ');

export const NEEDS_PLEX
	= 'needs a Plex that answers: set E2E_PLEX_URL, and E2E_PLEX_TOKEN if it is claimed (the lab, `make lab/up`)';

export interface FixtureService {
	id: string;
	name: string;
}

export interface FixtureLibrary {
	id: string;
	name: string;
	externalId: string;
	serviceId: string;
	paths: string[];
}

/**
 * Removes a fixture's services, and every account any of them mirrored.
 *
 * The accounts first. A mirrored account outlives the service it came from, and one
 * left behind is found by nothing afterwards — its provider names a service that no
 * longer exists. The sign-in journey promotes the account it creates to administrator,
 * so an orphan here is an administrator nobody chose.
 */
async function remove (request: APIRequestContext, services: FixtureService[]): Promise<void> {
	if (services.length === 0) {
		return;
	}

	const headers = await authorized(request);
	const providers = new Set(services.map(one => `service:${one.id}`));
	const users = await request.get(`${API_URL}/users`, { headers });
	expect(users.ok(), `users failed: ${users.status()}`).toBeTruthy();

	for (const user of await users.json() as { id: string; provider: string }[]) {
		if (providers.has(user.provider)) {
			await request.delete(`${API_URL}/users/${user.id}`, { headers });
		}
	}

	for (const service of services) {
		await request.delete(`${API_URL}/services/${service.id}`, { headers });
	}
}

async function servicesOf (request: APIRequestContext): Promise<(FixtureService & { baseUrl: string })[]> {
	const response = await request.get(`${API_URL}/services`, { headers: await authorized(request) });
	expect(response.ok(), `services failed: ${response.status()}`).toBeTruthy();
	return await response.json() as (FixtureService & { baseUrl: string })[];
}

/** Removes every service registered under this name, which is only ever a fixture's. */
export async function removeServices (request: APIRequestContext, name: string): Promise<void> {
	await remove(request, (await servicesOf(request)).filter(one => one.name === name));
}

/**
 * Registers a service of this journey's own.
 *
 * Whatever an interrupted run left under the same name goes first: a leftover holds the
 * address, and the gateway would refuse the new registration as a duplicate — failing
 * the journey for the previous run's sake rather than for anything it checks.
 */
export async function registerService (
	request: APIRequestContext,
	options: { name: string; type: 'jellyfin' | 'plex'; server: LabServer; authProvider?: boolean },
): Promise<FixtureService> {
	/*
	 * And whatever another journey left at the same address.
	 *
	 * Several journeys register the same lab server under their own names, so a
	 * leftover from any of them holds the address this one needs. Only registrations
	 * named as a journey's are cleared — a gateway's own registration of the lab is
	 * never a journey's to remove, and the conflict it causes is reported instead.
	 */
	const url = options.server.url.replace(/\/+$/, '');
	const sameAddress = (one: { baseUrl: string }): boolean => one.baseUrl.replace(/\/+$/, '') === url;
	const leftover = (one: FixtureService & { baseUrl: string }): boolean =>
		one.name === options.name || (one.name.startsWith('Journey ') && sameAddress(one));
	await remove(request, (await servicesOf(request)).filter(one => leftover(one)));

	const response = await request.post(`${API_URL}/services`, {
		headers: await authorized(request),
		data: {
			name: options.name,
			type: options.type,
			// Never offered to a peer: a fixture that a friend could see for the length
			// of a journey is a shelf that appears and vanishes on their screen.
			shared: false,
			baseUrl: options.server.url,
			...(options.server.token ? { token: options.server.token } : {}),
			authProvider: options.authProvider ?? false,
		},
	});
	expect(
		response.ok(),
		`the fixture could not be registered (a 409 means another registration already uses ${options.server.url}): `
		+ `${response.status()} ${await response.text()}`,
	).toBeTruthy();

	return await response.json() as FixtureService;
}

/** The libraries the gateway adopted when the service was registered. */
export async function librariesOfService (
	request: APIRequestContext,
	serviceId: string,
): Promise<FixtureLibrary[]> {
	const response = await request.get(`${API_URL}/services/${serviceId}/libraries`, {
		headers: await authorized(request),
	});
	expect(response.ok(), `libraries failed: ${response.status()}`).toBeTruthy();
	return await response.json() as FixtureLibrary[];
}
