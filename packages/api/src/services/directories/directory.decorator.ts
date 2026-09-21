import type { MediaServiceType } from '@mcs/shared';
import { SetMetadata } from '@nestjs/common';

/** Metadata key the directory registry scans for. See `MEDIA_HANDLER_TYPE`. */
export const MEDIA_DIRECTORY_TYPE = 'mcs:media-directory-type';

/**
 * Marks a provider as the directory for one service type.
 *
 * The same extension point as `@MediaHandler`: a new directory is a decorated class
 * and nothing else — no switch on the type anywhere above it.
 */
export const MediaDirectory = (type: MediaServiceType): ClassDecorator =>
	SetMetadata(MEDIA_DIRECTORY_TYPE, type);
