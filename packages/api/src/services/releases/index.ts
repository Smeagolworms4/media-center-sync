export * from './download-client.decorator';
export * from './download-client.interface';
export * from './download-client.registry';
export * from './indexer.decorator';
export * from './indexer.interface';
export * from './indexer.registry';
export * from './peer-suggestions';
export * from './prowlarr.indexer';
export * from './qbittorrent.client';
export * from './release-grouping';
export * from './release-http';
export * from './release-name';
export * from './release-preferences';

import { DownloadClientRegistry } from './download-client.registry';
import { IndexerRegistry } from './indexer.registry';
import { PeerSuggestionService } from './peer-suggestions';
import { ProwlarrIndexer } from './prowlarr.indexer';
import { QbittorrentClient } from './qbittorrent.client';

/**
 * Every source of suggestions, plus the registries that find the pluggable ones.
 *
 * A new indexer or download client is added here and nowhere else — which is only half
 * true, and the half that bites: the module providing these must also import
 * `DiscoveryModule` or the registries find none of them, silently. See `IndexerRegistry`.
 *
 * `PeerSuggestionService` is an ordinary provider rather than a registered
 * implementation, and that is deliberate: there is one peer network, nobody configures it
 * as a type, and it answers a different shape. See `peer-suggestions.ts`.
 */
export const RELEASE_PROVIDERS = [
	IndexerRegistry,
	DownloadClientRegistry,
	ProwlarrIndexer,
	QbittorrentClient,
	PeerSuggestionService,
];
