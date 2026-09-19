export * from './http-range.transport';
export * from './peer.transport';
export * from './swarm.transport';
export * from './transport.decorator';
export * from './transport.interface';
export * from './transport.registry';

import { HttpRangeTransport } from './http-range.transport';
import { PeerTransport } from './peer.transport';
import { PeerLinkSwarmWire, SwarmTransport } from './swarm.transport';
import { TransportRegistry } from './transport.registry';

/** Every transport, plus the registry and the swarm's wire implementation. */
export const TRANSPORT_PROVIDERS = [
	TransportRegistry,
	HttpRangeTransport,
	PeerTransport,
	PeerLinkSwarmWire,
	SwarmTransport,
];
