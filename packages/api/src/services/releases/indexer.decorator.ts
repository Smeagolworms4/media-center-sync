import type { IndexerType } from '@mcs/shared';
import { SetMetadata } from '@nestjs/common';

/** Metadata key the indexer registry scans for. Shared so no literal is repeated. */
export const INDEXER_TYPE = 'mcs:indexer-type';

/**
 * Marks a provider as the implementation of one indexer.
 *
 * Same extension point as `@MediaHandler`, and the same trap behind it: discovery
 * needs `DiscoveryModule` imported by the module that provides the registry, or it
 * quietly finds nothing and the product behaves as though no indexer type existed.
 */
export const ReleaseIndexerFor = (type: IndexerType): ClassDecorator =>
	SetMetadata(INDEXER_TYPE, type);
