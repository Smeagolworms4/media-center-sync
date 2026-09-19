import { MediaServiceType } from '@mcs/shared';
import { Reflector, type DiscoveryService } from '@nestjs/core';
import { MEDIA_HANDLER_TYPE, MediaHandler } from './handler.decorator';
import { HandlerRegistry } from './handler.registry';
import type { MediaServiceHandler } from './media-handler.interface';

@MediaHandler(MediaServiceType.JELLYFIN)
class FakeJellyfinHandler {
	public readonly type = MediaServiceType.JELLYFIN;
}

@MediaHandler(MediaServiceType.JELLYFIN)
class DuplicateHandler {
	public readonly type = MediaServiceType.JELLYFIN;
}

class UndecoratedService {}

function registryOver(instances: object[]): HandlerRegistry {
	const discovery = {
		getProviders: () =>
			instances.map((instance) => ({
				instance,
				metatype: instance.constructor,
			})),
	};

	return new HandlerRegistry(discovery as unknown as DiscoveryService, new Reflector());
}

describe('HandlerRegistry', () => {
	it('marks a class with its service type', () => {
		expect(Reflect.getMetadata(MEDIA_HANDLER_TYPE, FakeJellyfinHandler)).toBe(
			MediaServiceType.JELLYFIN,
		);
	});

	it('collects every decorated provider', () => {
		const registry = registryOver([new FakeJellyfinHandler(), new UndecoratedService()]);

		registry.onModuleInit();

		expect(registry.supportedTypes()).toEqual([MediaServiceType.JELLYFIN]);
		expect(registry.get(MediaServiceType.JELLYFIN)).toBeInstanceOf(FakeJellyfinHandler);
	});

	it('keeps the first of two handlers claiming one type', () => {
		// Picking one silently would make that service type behave according to
		// whichever class the module happened to list first, with nothing to read.
		const registry = registryOver([new FakeJellyfinHandler(), new DuplicateHandler()]);

		registry.onModuleInit();

		expect(registry.get(MediaServiceType.JELLYFIN)).toBeInstanceOf(FakeJellyfinHandler);
	});

	it('throws a key the interface can act on for an unknown type', () => {
		const registry = registryOver([]);

		registry.onModuleInit();

		expect(() => registry.get(MediaServiceType.PLEX)).toThrow();

		try {
			registry.get(MediaServiceType.PLEX);
		} catch (error) {
			expect(error).toMatchObject({
				response: { key: 'error.service.handler_unknown' },
			});
		}
	});

	it('answers null when only asked', () => {
		const registry = registryOver([]);

		registry.onModuleInit();

		expect(registry.find(MediaServiceType.PLEX)).toBeNull();
	});

	it('finds nothing at all when discovery returns nothing', () => {
		// This is exactly what a missing DiscoveryModule looks like: no error, no
		// failed compilation, and an application that behaves as if no service type
		// were supported.
		const registry = registryOver([]);

		registry.onModuleInit();

		expect(registry.supportedTypes()).toEqual([]);
	});

	it('accepts a handler registered by hand, for the command-line entry points', () => {
		const registry = registryOver([]);
		const handler = new FakeJellyfinHandler() as unknown as MediaServiceHandler;

		registry.onModuleInit();
		registry.register(handler);

		expect(registry.get(MediaServiceType.JELLYFIN)).toBe(handler);
	});
});
