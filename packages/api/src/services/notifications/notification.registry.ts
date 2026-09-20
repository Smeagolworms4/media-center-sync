import { ErrorKey, NotificationChannelType } from '@mcs/shared';
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { NOTIFICATION_CHANNEL_TYPE } from './notification.decorator';
import type { NotificationChannelHandler } from './notification-handler.interface';

/**
 * Finds every `@NotificationHandler` provider and resolves one by channel type.
 *
 * A third registry beside the handler and transport ones rather than a generic taking
 * a metadata key: the three sets are discovered in the same pass and would be
 * indistinguishable in one map, and the parameterised version reads worse than the
 * twenty lines it saves.
 *
 * The trap is the one `HandlerRegistry` documents at length, and it costs an
 * afternoon every time: discovery only sees what Nest instantiated, and
 * `DiscoveryService` is only injectable where `DiscoveryModule` is imported. Forget
 * it and nothing fails to compile, nothing is logged by Nest, and the gateway simply
 * behaves as though no channel type were supported — which looks like a bug in the
 * handlers. The warning below on an empty registry is the whole reason that afternoon
 * is spent somewhere else.
 */
@Injectable()
export class NotificationRegistry implements OnModuleInit {
	private readonly _logger = new Logger(NotificationRegistry.name);
	private readonly _handlers = new Map<NotificationChannelType, NotificationChannelHandler>();

	public constructor(
		private readonly _discovery: DiscoveryService,
		private readonly _reflector: Reflector,
	) {}

	public onModuleInit(): void {
		for (const wrapper of this._discovery.getProviders()) {
			const instance = wrapper.instance as NotificationChannelHandler | undefined;

			// A provider with no instance is a factory Nest has not resolved, and the
			// metatype is what carries the decorator — reading the metadata off the
			// instance's prototype finds nothing at all.
			if (!instance || !wrapper.metatype) {
				continue;
			}

			const type = this._reflector.get<NotificationChannelType | undefined>(
				NOTIFICATION_CHANNEL_TYPE,
				wrapper.metatype,
			);

			if (!type) {
				continue;
			}

			const existing = this._handlers.get(type);

			if (existing) {
				// Two handlers for one type is always a mistake, and choosing one
				// silently would make every channel of that type behave according to
				// whichever class the providers list happened to mention first.
				this._logger.warn(
					`Two notification handlers declared for "${type}": keeping ${existing.constructor.name}, ignoring ${instance.constructor.name}`,
				);

				continue;
			}

			this._handlers.set(type, instance);
		}

		if (this._handlers.size === 0) {
			this._logger.warn(
				'No notification handler discovered. If handlers are declared, DiscoveryModule is most likely missing from the module that provides NotificationRegistry.',
			);
		}
	}

	public get(type: NotificationChannelType): NotificationChannelHandler {
		const handler = this._handlers.get(type);

		if (!handler) {
			throw new NotFoundException({ key: ErrorKey.NOTIFICATION_HANDLER_UNKNOWN, type });
		}

		return handler;
	}

	/** Null rather than an exception, for the callers that are only asking. */
	public find(type: NotificationChannelType): NotificationChannelHandler | null {
		return this._handlers.get(type) ?? null;
	}

	/** What the interface offers in the "add a channel" form. */
	public supportedTypes(): NotificationChannelType[] {
		return [...this._handlers.keys()];
	}

	/**
	 * Registers a handler by hand.
	 *
	 * Only for tests and for the command-line entry points, which boot a trimmed
	 * context with no discovery pass. Production goes through the decorator.
	 */
	public register(handler: NotificationChannelHandler): void {
		this._handlers.set(handler.type, handler);
	}
}
