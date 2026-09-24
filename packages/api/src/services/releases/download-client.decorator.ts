import type { DownloadClientType } from '@mcs/shared';
import { SetMetadata } from '@nestjs/common';

/** Metadata key the download client registry scans for. */
export const DOWNLOAD_CLIENT_TYPE = 'mcs:download-client-type';

/**
 * Marks a provider as the implementation of one download client.
 *
 * See `ReleaseIndexerFor` for the discovery trap this shares with every other
 * registry here.
 */
export const DownloadClientFor = (type: DownloadClientType): ClassDecorator =>
	SetMetadata(DOWNLOAD_CLIENT_TYPE, type);
