import { ErrorKey, MediaServiceType } from '@mcs/shared';
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { MEDIA_HANDLER_TYPE } from './handler.decorator';
import type { MediaServiceHandler } from './media-handler.interface';

/**
 * Finds every `@MediaHandler` provider and resolves one by service type.
 *
 * The trap, and it costs an afternoon every time: discovery only sees what Nest
 * instantiated, and `DiscoveryService` is only injectable when `DiscoveryModule` is
 * imported by the module that provides this registry. Forget that import and
 * nothing fails to compile and no error is logged by Nest — the registry simply
 * finds zero handlers and the application behaves exactly as if no media service
 * type were supported, which looks like a bug in the handlers themselves. The
 * warning logged below on an empty registry exists solely so that afternoon is
 * spent somewhere else.
 */
@Injectable()
export class HandlerRegistry implements OnModuleInit {
	private readonly _logger = new Logger(HandlerRegistry.name);
	private readonly _handlers = new Map<MediaServiceType, MediaServiceHandler>();

	public constructor(
		private readonly _discovery: DiscoveryService,
		private readonly _reflector: Reflector,
	) {}

	public onModuleInit(): void {
		for (const wrapper of this._discovery.getProviders()) {
			const instance = wrapper.instance as MediaServiceHandler | undefined;

			// A provider with no instance is a factory Nest has not resolved, and its
			// metatype is what carries our decorator — reading the metadata off the
			// instance's prototype would find nothing.
			if (!instance || !wrapper.metatype) {
				continue;
			}

			const type = this._reflector.get<MediaServiceType | undefined>(
				MEDIA_HANDLER_TYPE,
				wrapper.metatype,
			);

			if (!type) {
				continue;
			}

			const existing = this._handlers.get(type);

			if (existing) {
				// Two handlers for one type is always a mistake, and picking one
				// silently would make the transfers of that service type behave
				// according to whichever class the module happened to list first.
				this._logger.warn(
					`Two handlers declared for "${type}": keeping ${existing.constructor.name}, ignoring ${instance.constructor.name}`,
				);

				continue;
			}

			this._handlers.set(type, instance);
		}

		if (this._handlers.size === 0) {
			this._logger.warn(
				'No media handler discovered. If handlers are declared, DiscoveryModule is most likely missing from the module that provides HandlerRegistry.',
			);
		}
	}

	public get(type: MediaServiceType): MediaServiceHandler {
		const handler = this._handlers.get(type);

		if (!handler) {
			throw new NotFoundException({ key: ErrorKey.SERVICE_HANDLER_UNKNOWN, type });
		}

		return handler;
	}

	/** Null rather than an exception, for the callers that are only asking. */
	public find(type: MediaServiceType): MediaServiceHandler | null {
		return this._handlers.get(type) ?? null;
	}

	/** What the interface offers in the "add a service" screen. */
	public supportedTypes(): MediaServiceType[] {
		return [...this._handlers.keys()];
	}

	/**
	 * Registers a handler by hand.
	 *
	 * Only for tests and for the command-line entry points, which boot a trimmed
	 * context without the discovery pass. Production goes through the decorator.
	 */
	public register(handler: MediaServiceHandler): void {
		this._handlers.set(handler.type, handler);
	}
}
