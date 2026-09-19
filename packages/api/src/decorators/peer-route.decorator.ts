import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const PEER_ROUTE = 'mcs:peer-route';

/**
 * Marks a route as belonging to the peer protocol.
 *
 * These are not called by a browser and have no user behind them: the caller is
 * another gateway, proving itself with the link credential negotiated when the two
 * were introduced. Marking them is what tells the peer guard to demand that
 * credential — and what keeps the user guard from asking for a session that a machine
 * could never have.
 */
export const PeerRoute = (): CustomDecorator<string> => SetMetadata(PEER_ROUTE, true);
