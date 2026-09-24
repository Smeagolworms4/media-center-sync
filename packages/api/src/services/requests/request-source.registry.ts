import { ErrorKey, RequestSourceType } from '@mcs/shared';
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { REQUEST_SOURCE_TYPE } from './request-source.decorator';
import type { RequestSource } from './request-source.interface';

/**
 * Finds every `@RequestSourceFor` provider and resolves one by type.
 *
 * The same discovery trap as `IndexerRegistry`, and it costs the same afternoon:
 * `DiscoveryService` only sees what Nest instantiated, and is only injectable when the
 * providing module imports `DiscoveryModule`. Forget it and nothing fails to compile,
 * nothing is logged by Nest, and the product behaves exactly as though no request source
 * type existed. The warning below on an empty registry is there so that afternoon is
 * spent somewhere else.
 */
@Injectable()
export class RequestSourceRegistry implements OnModuleInit {
	private readonly _logger = new Logger(RequestSourceRegistry.name);
	private readonly _sources = new Map<RequestSourceType, RequestSource>();

	public constructor(
		private readonly _discovery: DiscoveryService,
		private readonly _reflector: Reflector,
	) {}

	public onModuleInit(): void {
		for (const wrapper of this._discovery.getProviders()) {
			const instance = wrapper.instance as RequestSource | undefined;

			if (!instance || !wrapper.metatype) {
				continue;
			}

			const type = this._reflector.get<RequestSourceType | undefined>(
				REQUEST_SOURCE_TYPE,
				wrapper.metatype,
			);

			if (!type || this._sources.has(type)) {
				continue;
			}

			this._sources.set(type, instance);
		}

		if (this._sources.size === 0) {
			this._logger.warn('No request source found. Is DiscoveryModule imported?');
		}
	}

	public get(type: RequestSourceType): RequestSource {
		const source = this._sources.get(type);

		if (source === undefined) {
			throw new NotFoundException({ key: ErrorKey.REQUEST_SOURCE_UNKNOWN, detail: type });
		}

		return source;
	}
}
