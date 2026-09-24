export * from './request-source.decorator';
export * from './request-source.interface';
export * from './request-source.registry';
export * from './seerr.source';

import { RequestSourceRegistry } from './request-source.registry';
import { SeerrRequestSource } from './seerr.source';

/**
 * Every request source, plus the registry that finds them.
 *
 * A new one is added here and nowhere else — which is only half true, and the half that
 * bites: the module providing these must also import `DiscoveryModule` or the registry
 * finds none of them, silently. See `RequestSourceRegistry`.
 */
export const REQUEST_PROVIDERS = [RequestSourceRegistry, SeerrRequestSource];
