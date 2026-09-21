import type {
	CreateMediaServiceRequest,
	Library,
	MediaService,
	MediaServiceProbe,
	ProbeMediaServiceRequest,
	ScanProgress,
	ServerStructure,
	ServerStructureRequest,
	UpdateMediaServiceRequest,
} from '@mcs/shared';
import { EventName } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';
import { useEvents } from '@/hooks/useEvents';

/**
 * The registered media services.
 *
 * The list is bounded by what somebody registered, so it is held whole rather
 * than paginated, and every screen that needs a service name — a transfer row, a
 * sync plan, a peer page — reads it from here instead of asking again.
 */
export const useServicesStore = defineStore('services', () => {
	const { caller } = useCaller();
	const events = useEvents();

	const services = ref<MediaService[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	/** Scan progress per service, so a page can show a scan it did not start. */
	const scans = ref<Record<string, ScanProgress>>({});

	const byId = computed(() => {
		const map: Record<string, MediaService> = {};
		for (const service of services.value) {
			map[service.id] = service;
		}
		return map;
	});

	/** Lowest priority first, which is the order a sync consults them in. */
	const byPriority = computed(() => {
		// `toSorted` would be cleaner, but it is not in the library version this
		// build targets; the copy is what keeps `sort` from reordering the array
		// under everything that renders it.
		// eslint-disable-next-line unicorn/no-array-sort
		return [...services.value].sort((a, b) => a.priority - b.priority);
	});

	function replace (service: MediaService): void {
		const index = services.value.findIndex(one => one.id === service.id);
		if (index === -1) {
			services.value = [...services.value, service];
		} else {
			services.value[index] = service;
		}
	}

	async function load (): Promise<MediaService[]> {
		loading.value = true;
		error.value = null;
		try {
			const loadedList = await caller('api').get<MediaService[]>('/services', {
				keepLastKey: 'services|list',
			});
			// An empty body parses to `null`, and a gateway that answers nothing must
			// not leave a page rendering a list that is not one.
			services.value = Array.isArray(loadedList) ? loadedList : [];
			loaded.value = true;
			return services.value;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	async function get (id: string): Promise<MediaService> {
		const service = await caller('api').get<MediaService>(`/services/${id}`);
		replace(service);
		return service;
	}

	async function create (request: CreateMediaServiceRequest): Promise<MediaService> {
		const service = await caller('api').post<MediaService>('/services', request);
		replace(service);
		return service;
	}

	async function update (id: string, request: UpdateMediaServiceRequest): Promise<MediaService> {
		const service = await caller('api').patch<MediaService>(`/services/${id}`, request);
		replace(service);
		return service;
	}

	async function remove (id: string): Promise<void> {
		await caller('api').delete(`/services/${id}`);
		services.value = services.value.filter(one => one.id !== id);
	}

	/**
	 * Tests a connection that is not registered yet.
	 *
	 * This is what lets the form tell somebody their token is wrong while they are
	 * still typing it, rather than after they have saved a service that does not
	 * work and wondered why their library stays empty.
	 */
	function probe (request: ProbeMediaServiceRequest): Promise<MediaServiceProbe> {
		return caller('api').post<MediaServiceProbe>('/services/probe', request);
	}

	async function probeService (id: string): Promise<MediaServiceProbe> {
		const result = await caller('api').post<MediaServiceProbe>(`/services/${id}/probe`);
		// The probe answers what it found; the status the row shows comes from the
		// service itself, so it is re-read rather than guessed from the probe.
		await get(id).catch(() => undefined);
		return result;
	}

	/** Both answer `202`: the work reports itself through `scan.progress`. */
	function scan (id: string): Promise<void> {
		return caller('api').post<void>(`/services/${id}/scan`);
	}

	function refresh (id: string): Promise<void> {
		return caller('api').post<void>(`/services/${id}/refresh`);
	}

	function libraries (id: string): Promise<Library[]> {
		return caller('api').get<Library[]>(`/services/${id}/libraries`);
	}

	/**
	 * Where this service says its own files are.
	 *
	 * The authoritative half of the mapping somebody is configuring: the server says
	 * `/data/media/shows`, this gateway sees `/mnt/nas/shows`, and until this existed
	 * the only help on offer was browsing our own disk and guessing which directory
	 * was the same one.
	 *
	 * Nothing is cached, for the same reason a directory browse is not: it is a
	 * question about a filesystem somebody may have just changed — a library added on
	 * the server, a mount that came up — and a remembered answer is the one thing that
	 * would make this assist lie.
	 *
	 * Failures are silent as far as the notifier is concerned: the picker shows what
	 * it got in place of its own list, and a toast over the whole application about a
	 * server that cannot say where its folders are would be noise about a field
	 * somebody is still filling in.
	 */
	function structure (
		id: string,
		request: ServerStructureRequest = {},
	): Promise<ServerStructure> {
		const params = new URLSearchParams();

		if (request.libraryExternalId) {
			params.set('libraryExternalId', request.libraryExternalId);
		}
		if (request.path) {
			params.set('path', request.path);
		}

		const query = params.toString();

		return caller('api').get<ServerStructure>(
			`/services/${id}/structure${query ? `?${query}` : ''}`,
			{ silentError: true },
		);
	}

	events.on(EventName.SERVICE_STATUS, payload => {
		const service = services.value.find(one => one.id === payload.id);
		if (service) {
			// Patched in place rather than replaced: the row is keyed by identifier
			// and only its status cell depends on these two fields.
			service.status = payload.status;
			service.lastProbeAt = payload.lastProbeAt;
		}
	});

	/**
	 * The list again, one request at a time.
	 *
	 * A registration adopts its libraries and may re-probe, so one change can arrive as
	 * several events in a row; overlapping loads would each replace the list and the
	 * last to answer — not the newest — would win.
	 */
	let reloading: Promise<MediaService[]> | null = null;

	function reload (): Promise<MediaService[]> {
		reloading ??= load().finally(() => {
			reloading = null;
		});
		return reloading;
	}

	// Only once somebody has read the list: a session that never opened a screen
	// naming services has nothing stale to correct, and should not fetch on its behalf.
	events.on(EventName.SERVICE_CHANGED, () => {
		if (loaded.value) {
			void reload().catch(() => undefined);
		}
	});

	events.on(EventName.SCAN_PROGRESS, payload => {
		if (payload.done) {
			const { [payload.serviceId]: _done, ...rest } = scans.value;
			scans.value = rest;
			return;
		}
		scans.value = { ...scans.value, [payload.serviceId]: payload };
	});

	return {
		services,
		loading,
		loaded,
		reload,
		error,
		scans,
		byId,
		byPriority,
		load,
		get,
		create,
		update,
		remove,
		probe,
		probeService,
		scan,
		refresh,
		libraries,
		structure,
	};
});
