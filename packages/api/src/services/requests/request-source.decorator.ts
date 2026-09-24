import type { RequestSourceType } from '@mcs/shared';
import { SetMetadata } from '@nestjs/common';

/** Metadata key the request source registry scans for. Shared so no literal is repeated. */
export const REQUEST_SOURCE_TYPE = 'mcs:request-source-type';

/**
 * Marks a provider as the implementation of one request source.
 *
 * See `ReleaseIndexerFor` for the discovery trap this shares with every other registry
 * here: it needs `DiscoveryModule` imported by the module that provides the registry, or
 * it quietly finds nothing and the product behaves as though no request source type
 * existed.
 */
export const RequestSourceFor = (type: RequestSourceType): ClassDecorator =>
	SetMetadata(REQUEST_SOURCE_TYPE, type);
