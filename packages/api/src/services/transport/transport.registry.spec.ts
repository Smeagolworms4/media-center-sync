import { TransferTransport } from '@mcs/shared';
import { Reflector, type DiscoveryService } from '@nestjs/core';
import { Transport } from './transport.decorator';
import type { ByteTransport } from './transport.interface';
import { TransportRegistry } from './transport.registry';

@Transport(TransferTransport.HTTP_RANGE)
class FakeHttpTransport {
	public readonly transport = TransferTransport.HTTP_RANGE;
}

@Transport(TransferTransport.PEER_DIRECT)
class FakePeerTransport {
	public readonly transport = TransferTransport.PEER_DIRECT;
}

function registryOver(instances: object[]): TransportRegistry {
	const discovery = {
		getProviders: () =>
			instances.map((instance) => ({ instance, metatype: instance.constructor })),
	};

	return new TransportRegistry(discovery as unknown as DiscoveryService, new Reflector());
}

describe('TransportRegistry', () => {
	it('resolves a transport by kind', () => {
		const registry = registryOver([new FakeHttpTransport(), new FakePeerTransport()]);

		registry.onModuleInit();

		expect(registry.get(TransferTransport.HTTP_RANGE)).toBeInstanceOf(FakeHttpTransport);
	});

	it('serves a relayed transfer with the peer transport', () => {
		// Direct or relayed is a property of the link, decided when it is established
		// and able to change under a running transfer; it makes no difference to how a
		// range is asked for.
		const registry = registryOver([new FakePeerTransport()]);

		registry.onModuleInit();

		expect(registry.get(TransferTransport.PEER_RELAY)).toBeInstanceOf(FakePeerTransport);
	});

	it('throws for a transport nobody implements', () => {
		const registry = registryOver([]);

		registry.onModuleInit();

		expect(() => registry.get(TransferTransport.SWARM)).toThrow();
		expect(registry.find(TransferTransport.SWARM)).toBeNull();
	});

	it('finds nothing when discovery is not wired up', () => {
		const registry = registryOver([]);

		registry.onModuleInit();

		expect(registry.find(TransferTransport.HTTP_RANGE)).toBeNull();
	});

	it('accepts a transport registered by hand', () => {
		const registry = registryOver([]);
		const transport = new FakeHttpTransport() as unknown as ByteTransport;

		registry.onModuleInit();
		registry.register(transport);

		expect(registry.get(TransferTransport.HTTP_RANGE)).toBe(transport);
	});
});
