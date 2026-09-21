export * from './connection-order';
export * from './directory.decorator';
export * from './directory.registry';
export * from './plex-tv.directory';
export * from './service-directory.interface';

import { DirectoryRegistry } from './directory.registry';
import { PlexTvDirectory } from './plex-tv.directory';

/**
 * Every directory, plus the registry that finds them. Like the handlers, the module
 * providing these must import `DiscoveryModule`, or the registry finds none of them.
 */
export const MEDIA_DIRECTORY_PROVIDERS = [DirectoryRegistry, PlexTvDirectory];
