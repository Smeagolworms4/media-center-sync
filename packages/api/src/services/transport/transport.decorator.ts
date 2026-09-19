import type { TransferTransport } from '@mcs/shared';
import { SetMetadata } from '@nestjs/common';

/** Metadata key the transport registry scans for. Shared so no literal is repeated. */
export const TRANSPORT_KIND = 'mcs:transport-kind';

/**
 * Marks a provider as the implementation of one transport.
 *
 * Same extension point as `@MediaHandler`, and the same trap behind it: discovery
 * needs `DiscoveryModule` imported, or the registry quietly finds nothing.
 */
export const Transport = (transport: TransferTransport): ClassDecorator =>
	SetMetadata(TRANSPORT_KIND, transport);
