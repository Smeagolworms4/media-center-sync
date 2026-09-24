import type {
	MediaRequest,
	MediaRequestView,
	RequestCreate,
	RequestQuery,
} from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * What the household asked for, read from where it asked.
 *
 * The one source in this product that hands over no bytes: it answers what anybody
 * actually wants, and the gateway answers whether that is already held. So there are
 * exactly three calls here — read the asks, say one is answered, and push an ask the
 * other way — and nothing that starts a download. A request carries the search it
 * implies and that search is run from the releases store, on a press, which is what
 * keeps an account on somebody else's Seerr from spending this gateway's disk.
 */
export const useRequestsStore = defineStore('requests', () => {
	const { caller } = useCaller();

	const requests = ref<MediaRequestView[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);
	/**
	 * Whether the gateway has a request source at all.
	 *
	 * Held apart from `error` because it is not a failure: a household that never
	 * configured Seerr has a screen with nothing wrong with it, and showing them the
	 * generic "the gateway could not answer" would send somebody looking for a fault
	 * instead of at the settings screen the API's refusal names.
	 */
	const notConfigured = ref(false);
	/** What the held list was read with, so a refresh asks the same question again. */
	const asked = ref<RequestQuery>({});

	/** The asks this gateway could honestly close, which is what a count on a badge is. */
	const fulfillable = computed(() => requests.value.filter(one => one.fulfillable));

	/** Only what was actually asked for: an empty parameter is not the same as none. */
	function queryString (query: RequestQuery): string {
		const params = new URLSearchParams();

		if (query.state !== undefined) {
			params.set('state', query.state);
		}
		if (query.take !== undefined) {
			params.set('take', String(query.take));
		}

		const encoded = params.toString();

		return encoded ? `?${encoded}` : '';
	}

	function replace (view: MediaRequestView): void {
		const index = requests.value.findIndex(one => one.id === view.id);

		if (index === -1) {
			requests.value = [view, ...requests.value];
		} else {
			requests.value[index] = view;
		}
	}

	async function load (query: RequestQuery = {}): Promise<MediaRequestView[]> {
		loading.value = true;
		error.value = null;
		asked.value = query;

		try {
			const rows = await caller('api').get<MediaRequestView[]>(
				`/requests${queryString(query)}`,
				// Silent because the one refusal this route has is a gateway with no request
				// source, which the screen states in words of its own; a toast on top of it
				// would report a configuration choice as a fault.
				{ keepLastKey: 'requests|list', silentError: true },
			);

			// An empty body parses to `null`, and a gateway that answers nothing must not
			// leave a page rendering a list that is not one.
			requests.value = Array.isArray(rows) ? rows : [];
			notConfigured.value = false;
			loaded.value = true;

			return requests.value;
		} catch (loadError) {
			/*
			 * A conflict from this route means one thing and the controller documents no
			 * other: there is no request source configured. Read from the status rather
			 * than from the body because the body is a stream that can only be consumed
			 * once, and whoever handles `error` afterwards would find it empty.
			 */
			notConfigured.value = loadError instanceof Response && loadError.status === 409;
			requests.value = [];
			error.value = loadError;

			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	/** The same question again, which is what somebody pressing refresh means. */
	function refresh (): Promise<MediaRequestView[]> {
		return load(asked.value);
	}

	/**
	 * Tell the source the ask is answered.
	 *
	 * The answered row is kept as the API returned it rather than being dropped from the
	 * list: Seerr recomputes a request's status after the write, so reading the listing
	 * back immediately would show the old state and look like the press had failed —
	 * and a row that vanished would leave nobody able to see what they had just done.
	 */
	async function markFulfilled (id: string): Promise<MediaRequestView> {
		const view = await caller('api').post<MediaRequestView>(
			`/requests/${encodeURIComponent(id)}/fulfilled`,
		);

		replace(view);

		return view;
	}

	/**
	 * Push an ask the other way: this is what we are following here.
	 *
	 * The held list is left alone. The new ask lives over there and comes back with the
	 * next read, and a row invented here would be this gateway's guess at what the
	 * source made of it — including the case where the same ask was already open, which
	 * answers nothing and is a success.
	 */
	function create (body: RequestCreate): Promise<MediaRequest | null> {
		return caller('api').post<MediaRequest | null>('/requests', body);
	}

	return {
		requests,
		loading,
		loaded,
		error,
		notConfigured,
		asked,
		fulfillable,
		load,
		refresh,
		markFulfilled,
		create,
	};
});
