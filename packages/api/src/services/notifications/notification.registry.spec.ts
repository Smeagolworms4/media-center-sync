import { NotificationChannelType } from '@mcs/shared';
import { NotFoundException } from '@nestjs/common';
import { Reflector, type DiscoveryService } from '@nestjs/core';
import { NOTIFICATION_CHANNEL_TYPE, NotificationHandler } from './notification.decorator';
import { NotificationRegistry } from './notification.registry';

@NotificationHandler(NotificationChannelType.NTFY)
class FakeNtfyHandler {
	public readonly type = NotificationChannelType.NTFY;
}

@NotificationHandler(NotificationChannelType.NTFY)
class DuplicateHandler {
	public readonly type = NotificationChannelType.NTFY;
}

@NotificationHandler(NotificationChannelType.SMTP)
class FakeSmtpHandler {
	public readonly type = NotificationChannelType.SMTP;
}

class UndecoratedService {}

function registryOver(instances: object[]): NotificationRegistry {
	const discovery = {
		getProviders: () =>
			instances.map((instance) => ({ instance, metatype: instance.constructor })),
	};

	return new NotificationRegistry(discovery as unknown as DiscoveryService, new Reflector());
}

describe('NotificationRegistry', () => {
	it('marks a class with its channel type', () => {
		expect(Reflect.getMetadata(NOTIFICATION_CHANNEL_TYPE, FakeNtfyHandler)).toBe(
			NotificationChannelType.NTFY,
		);
	});

	it('resolves a handler by type and ignores everything undecorated', () => {
		const registry = registryOver([
			new FakeNtfyHandler(),
			new FakeSmtpHandler(),
			new UndecoratedService(),
		]);

		registry.onModuleInit();

		expect(registry.supportedTypes()).toEqual([
			NotificationChannelType.NTFY,
			NotificationChannelType.SMTP,
		]);
		expect(registry.get(NotificationChannelType.NTFY)).toBeInstanceOf(FakeNtfyHandler);
		expect(registry.get(NotificationChannelType.SMTP)).toBeInstanceOf(FakeSmtpHandler);
	});

	it('keeps the first of two handlers claiming one type', () => {
		// Choosing silently would make every channel of that type behave according to
		// whichever class the providers list happened to mention first.
		const registry = registryOver([new FakeNtfyHandler(), new DuplicateHandler()]);

		registry.onModuleInit();

		expect(registry.get(NotificationChannelType.NTFY)).toBeInstanceOf(FakeNtfyHandler);
	});

	it('refuses a type it has no handler for with a key rather than undefined', () => {
		// A row naming a channel type this build does not have is what a rollback
		// looks like, and `undefined` here would crash the dispatch instead.
		const registry = registryOver([]);

		registry.onModuleInit();

		expect(() => registry.get(NotificationChannelType.NTFY)).toThrow(NotFoundException);
		expect(registry.find(NotificationChannelType.NTFY)).toBeNull();
	});

	it('takes a handler registered by hand, for the contexts with no discovery pass', () => {
		const registry = registryOver([]);

		registry.onModuleInit();
		registry.register(new FakeSmtpHandler() as never);

		expect(registry.get(NotificationChannelType.SMTP)).toBeInstanceOf(FakeSmtpHandler);
	});
});
