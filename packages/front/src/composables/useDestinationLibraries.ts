import type { Library, MediaService } from '@mcs/shared';
import { MediaServiceMode, MediaServiceType } from '@mcs/shared';
import { computed, type ComputedRef } from 'vue';
import { useLibrariesStore } from '@/stores/libraries';
import { useServicesStore } from '@/stores/services';

/** A library a pulled file can actually land in. */
export interface DestinationLibrary {
	id: string;
	name: string;
	serviceName: string;
	/** Where the gateway writes it, so a choice is made against something real. */
	path: string | null;
}

/**
 * Why a library cannot be offered as a destination.
 *
 * Two reasons, because they are fixed in two different places: `not_ours` is a
 * library on somebody else's server and will never be writable from here, while
 * `not_writable` is one of ours whose local path is wrong or missing — that one is
 * a mistake somebody can go and correct.
 */
export type RejectionReason = 'not_ours' | 'not_writable';

export interface RejectedLibrary {
	id: string;
	name: string;
	serviceName: string;
	reason: RejectionReason;
}

export interface DestinationLibraries {
	destinations: ComputedRef<DestinationLibrary[]>;
	rejected: ComputedRef<RejectedLibrary[]>;
}

/**
 * Which service a library belongs to, in the same terms the services page uses.
 *
 * Derived rather than read straight off `mode`, because a record written before that
 * field existed has none — and a library whose service falls into no band would be
 * silently dropped from every destination list, which is the one outcome this whole
 * screen exists to prevent.
 *
 * The fallback reads the mount and never the sharing switch: a pull has to land on a
 * path the media server scans, and offering a service's libraries to peers puts no
 * file anywhere.
 */
function modeOf (service: MediaService): MediaServiceMode {
	if (service.mode) {
		return service.mode;
	}
	if (service.type === MediaServiceType.PEER) {
		return MediaServiceMode.PEER;
	}

	return service.filesMounted ? MediaServiceMode.LOCAL : MediaServiceMode.REMOTE;
}

/**
 * The libraries a pull may be sent to, and the ones that were left out with the
 * reason why.
 *
 * Both halves matter. Offering a library the gateway cannot write into accepts
 * transfers the media server will never see and reports no error anywhere — that is
 * the failure this product exists to avoid, so an unwritable library is not
 * selectable. But a library that simply vanishes from a list reads as a bug: somebody
 * who expects to send their shows to a friend's server needs to be told that it is
 * somebody else's disk, not left wondering why the name is missing.
 *
 * A check takes precedence over the library's stored flag when one has been run: the
 * flag is what the last scan believed, and a disk unmounted since then is exactly the
 * case worth catching.
 */
export function useDestinationLibraries (): DestinationLibraries {
	const librariesStore = useLibrariesStore();
	const servicesStore = useServicesStore();

	const ours = computed(() => {
		const map: Record<string, MediaService> = {};
		for (const service of servicesStore.services) {
			if (modeOf(service) === MediaServiceMode.LOCAL) {
				map[service.id] = service;
			}
		}
		return map;
	});

	const serviceName = (library: Library): string =>
		servicesStore.byId[library.serviceId]?.name ?? library.serviceId;

	const writable = (library: Library): boolean =>
		librariesStore.checkById[library.id]?.writable ?? library.writable;

	// Sorted by the gateway's own order and then by name, so the list reads the same
	// way the library wall does rather than in whatever order rows came back in.
	const sorted = computed(() => [...librariesStore.libraries]
		// eslint-disable-next-line unicorn/no-array-sort
		.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)));

	/*
	 * One entry per *root*, not per library.
	 *
	 * A library is not one folder. A shelf called `Series TV` can be five directories
	 * on five disks, and offering the library offered only the first of them — every
	 * pull landed there and nothing said why. So each of a library's own roots is its
	 * own answer, named by the folder it actually is.
	 *
	 * A library the gateway cannot reach has no roots and therefore no entry, which is
	 * the same rule as before said in the data rather than in a filter: there is nothing
	 * to offer, not a choice to grey out.
	 */
	const destinations = computed<DestinationLibrary[]>(() => sorted.value
		.filter(one => one.serviceId in ours.value && writable(one))
		.flatMap(one => {
			// An older gateway sends no roots at all; its single path is still an answer,
			// and offering nothing would empty the menu on every one of its libraries.
			const roots = one.localRoots?.length ? one.localRoots : [one.localPath].filter(Boolean);

			return (roots as string[]).map(path => ({
				id: one.id,
				name: one.alias ?? one.name,
				serviceName: serviceName(one),
				path,
			}));
		}));

	const rejected = computed<RejectedLibrary[]>(() => sorted.value
		.filter(one => !(one.serviceId in ours.value) || !writable(one))
		.map(one => ({
			id: one.id,
			name: one.alias ?? one.name,
			serviceName: serviceName(one),
			reason: one.serviceId in ours.value ? 'not_writable' : 'not_ours',
		})));

	return { destinations, rejected };
}
