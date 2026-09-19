import type { MediaServiceType } from '@mcs/shared';
import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key the registry scans for.
 *
 * Exported because the registry and the tests both need it, and a string literal
 * repeated in two files is a silent failure waiting to happen — a typo produces a
 * handler nobody finds, with nothing to compile against.
 */
export const MEDIA_HANDLER_TYPE = 'mcs:media-handler-type';

/**
 * Marks a provider as the handler for one service type.
 *
 * This is the whole extension point: a new service means a decorated class and a
 * line in the providers list, and no registry, factory or switch to update.
 */
export const MediaHandler = (type: MediaServiceType): ClassDecorator =>
	SetMetadata(MEDIA_HANDLER_TYPE, type);
