import type { CatalogueEntry, MediaItem } from '@mcs/shared';

/**
 * What a peer's row looks like once it is ours.
 *
 * A peer tells us what it holds, not how it files it: a `CatalogueEntry` carries
 * no path and no library identifier, on purpose. The browser never calls
 * `/peer/catalogue` — that route carries a peer credential, not a session — so
 * what this screen reads is the gateway's own index of that peer's services.
 * Reducing those rows to the catalogue shape keeps the peer screen honest about
 * what it is entitled to show: their titles, not the shape of their disk.
 */
export function toCatalogueEntry (item: MediaItem): CatalogueEntry {
	const externalIds: Record<string, string> = {};
	for (const [key, value] of Object.entries(item.externalIds ?? {})) {
		if (typeof value === 'string' && value.length > 0) {
			externalIds[key] = value;
		}
	}

	return {
		// Their identifier when the index kept one; ours is the only fallback, and
		// it is opaque on both sides either way.
		externalId: item.externalIds?.provider ?? item.id,
		kind: item.kind,
		title: item.title,
		year: item.year,
		seasonNumber: item.seasonNumber,
		episodeNumber: item.episodeNumber,
		// We hold no external identifier for the parent, and inventing one from our
		// own row would be a value nobody on the other side could resolve.
		parentExternalId: null,
		externalIds,
		contentId: item.file?.contentId ?? null,
		size: item.file?.size ?? null,
		quality: item.quality?.label ?? null,
	};
}

export function useCatalogue () {
	return { toCatalogueEntry };
}
