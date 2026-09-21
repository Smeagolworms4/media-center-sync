export * from './handler.decorator';
export * from './handler.http';
export * from './handler.registry';
export * from './jellyfin.handler';
export * from './media-handler.interface';
export * from './payload';
export * from './peer.handler';
export * from './plex.handler';
export * from './server-path';

import { HandlerRegistry } from './handler.registry';
import { JellyfinHandler } from './jellyfin.handler';
import { PeerHandler } from './peer.handler';
import { PlexHandler } from './plex.handler';

/**
 * Every handler, plus the registry that finds them.
 *
 * A new service type is added here and nowhere else — which is only half true, and
 * the half that bites: the module providing these must also import `DiscoveryModule`
 * or the registry finds none of them, silently. See `HandlerRegistry`.
 */
export const MEDIA_HANDLER_PROVIDERS = [HandlerRegistry, JellyfinHandler, PlexHandler, PeerHandler];
