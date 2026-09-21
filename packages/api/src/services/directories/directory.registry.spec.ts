import { MediaServiceType } from '@mcs/shared';
import { Reflector, type DiscoveryService } from '@nestjs/core';
import { MEDIA_DIRECTORY_TYPE, MediaDirectory } from './directory.decorator';
import { DirectoryRegistry } from './directory.registry';
import type { ServiceDirectory } from './service-directory.interface';

@MediaDirectory(MediaServiceType.PLEX)
class FakePlexDirectory {
	public readonly type = MediaServiceType.PLEX;
}

@MediaDirectory(MediaServiceType.PLEX)
class SecondPlexDirectory {
	public readonly type = MediaServiceType.PLEX;
}

class UndecoratedService {}

function registryOver(providers: { instance?: object; metatype?: unknown }[]): DirectoryRegistry {
	const discovery = { getProviders: () => providers };

	return new DirectoryRegistry(discovery as unknown as DiscoveryService, new Reflector());
}

const provider = (instance: object): { instance: object; metatype: unknown } => ({
	instance,
	metatype: instance.constructor,
});

describe('DirectoryRegistry', () => {
	it('marks a class with the service type it finds servers for', () => {
		expect(Reflect.getMetadata(MEDIA_DIRECTORY_TYPE, FakePlexDirectory)).toBe(MediaServiceType.PLEX);
	});

	it('collects the decorated providers and nothing else', () => {
		const registry = registryOver([
			provider(new FakePlexDirectory()),
			provider(new UndecoratedService()),
			// A factory Nest has not resolved yet: no instance to register.
			{ metatype: FakePlexDirectory },
			{ instance: new UndecoratedService() },
		]);

		registry.onModuleInit();

		expect(registry.types()).toEqual([MediaServiceType.PLEX]);
		expect(registry.find(MediaServiceType.PLEX)).toBeInstanceOf(FakePlexDirectory);
	});

	it('keeps the first of two directories claiming one type', () => {
		const registry = registryOver([provider(new FakePlexDirectory()), provider(new SecondPlexDirectory())]);

		registry.onModuleInit();

		expect(registry.find(MediaServiceType.PLEX)).toBeInstanceOf(FakePlexDirectory);
	});

	it('answers nothing for a type no directory serves, which is an answer and not a fault', () => {
		const registry = registryOver([]);

		registry.onModuleInit();

		expect(registry.find(MediaServiceType.JELLYFIN)).toBeNull();
		expect(registry.types()).toEqual([]);
	});

	it('takes one registered by hand, for the contexts that skip discovery', () => {
		const registry = registryOver([]);

		registry.register(new FakePlexDirectory() as unknown as ServiceDirectory);

		expect(registry.find(MediaServiceType.PLEX)).toBeInstanceOf(FakePlexDirectory);
	});
});
