import type { MediaService } from '@mcs/shared';
import {
	EventName,
	MediaServiceMode,
	MediaServiceScope,
	MediaServiceStatus,
	MediaServiceType } from '@mcs/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useServicesStore } from '@/stores/services';
import { connectFakeSocket, createStoreContext, emitServerEvent, stubFetch } from './helpers';

function service (overrides: Partial<MediaService> = {}): MediaService {
	return {
		id: 's1',
		name: 'Living room',
		type: MediaServiceType.JELLYFIN,
		scope: MediaServiceScope.LOCAL,
		mode: MediaServiceMode.LOCAL,
		baseUrl: 'http://10.0.0.2:8096',
		status: MediaServiceStatus.ONLINE,
		version: '10.9',
		remoteRoot: null,
		localRoot: null,
		authProvider: true,
		priority: 10,
		peerId: null,
		lastProbeAt: null,
		lastScanAt: null,
		libraryCount: 2,
		itemCount: 1200,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('stores/services', () => {
	let pinia: ReturnType<typeof createStoreContext>['pinia'];

	beforeEach(() => {
		pinia = createStoreContext().pinia;
	});

	it('loads the registered services and orders them by priority', async () => {
		stubFetch([{ body: [service({ id: 'a', priority: 30 }), service({ id: 'b', priority: 5 })] }]);
		const store = useServicesStore();

		await store.load();

		expect(store.services).toHaveLength(2);
		expect(store.loaded).toBe(true);
		expect(store.byPriority.map(one => one.id)).toEqual(['b', 'a']);
		expect(store.byId.a.priority).toBe(30);
	});

	it('keeps the failure so a page can offer a retry instead of a blank frame', async () => {
		stubFetch([{ status: 503, body: { message: 'error.general' } }]);
		const store = useServicesStore();

		await expect(store.load()).rejects.toBeDefined();

		expect(store.error).toBeDefined();
		expect(store.loading).toBe(false);
		expect(store.loaded).toBe(false);
	});

	it('probes a connection before anything is registered', async () => {
		const stub = stubFetch([{ body: { reachable: true, authenticated: true, libraries: [] } }]);
		const store = useServicesStore();

		const result = await store.probe({
			type: MediaServiceType.PLEX,
			baseUrl: 'http://10.0.0.3:32400',
			token: 'secret',
		});

		expect(result.reachable).toBe(true);
		expect(String(stub.mock.calls[0][0])).toContain('/api/services/probe');
		expect(stub.mock.calls[0][1]?.method).toBe('POST');

		// Only what a probe reads. The route declares these five fields and refuses
		// anything else, which is how sending the whole form came back as six
		// "property … should not exist" lines on a body the very next request would
		// have accepted verbatim.
		expect(Object.keys(JSON.parse(String(stub.mock.calls[0][1]?.body))))
			.toEqual(['type', 'baseUrl', 'token']);
	});

	it('adds a created service to the list without a reload', async () => {
		stubFetch([{ body: service({ id: 'new' }) }]);
		const store = useServicesStore();

		await store.create({
			name: 'New',
			type: MediaServiceType.JELLYFIN,
			scope: MediaServiceScope.LOCAL,
			baseUrl: 'http://10.0.0.4:8096',
		});

		expect(store.services.map(one => one.id)).toEqual(['new']);
	});

	it('drops a removed service from the list', async () => {
		// `204` cannot be built by the Response constructor in this environment, and
		// an empty body is what the caller actually sees either way.
		stubFetch([{ body: [service({ id: 'a' }), service({ id: 'b' })] }, {}]);
		const store = useServicesStore();
		await store.load();

		await store.remove('a');

		expect(store.services.map(one => one.id)).toEqual(['b']);
	});

	it('applies a status frame to the row it names, and to no other', async () => {
		stubFetch([{ body: [service({ id: 'a' }), service({ id: 'b' })] }]);
		const store = useServicesStore();
		await store.load();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.SERVICE_STATUS, {
			id: 'b',
			status: MediaServiceStatus.OFFLINE,
			lastProbeAt: '2026-02-02T10:00:00.000Z',
		});

		expect(store.byId.b.status).toBe(MediaServiceStatus.OFFLINE);
		expect(store.byId.b.lastProbeAt).toBe('2026-02-02T10:00:00.000Z');
		expect(store.byId.a.status).toBe(MediaServiceStatus.ONLINE);
	});

	it('tracks a running scan and forgets it once it is done', async () => {
		stubFetch([{ body: [service({ id: 'a' })] }]);
		const store = useServicesStore();
		await store.load();
		connectFakeSocket(pinia);

		emitServerEvent(EventName.SCAN_PROGRESS, {
			serviceId: 'a', libraryId: null, itemsSeen: 10, itemsTotal: 100, done: false,
		});
		expect(store.scans.a.itemsSeen).toBe(10);

		emitServerEvent(EventName.SCAN_PROGRESS, {
			serviceId: 'a', libraryId: null, itemsSeen: 100, itemsTotal: 100, done: true,
		});
		expect(store.scans.a).toBeUndefined();
	});
});
