import { ErrorKey, IndexerType } from '@mcs/shared';
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { INDEXER_TYPE } from './indexer.decorator';
import type { ReleaseIndexer } from './indexer.interface';

/**
 * Finds every `@ReleaseIndexerFor` provider and resolves one by type.
 *
 * The same discovery trap as `HandlerRegistry`, and it costs the same afternoon:
 * `DiscoveryService` only sees what Nest instantiated, and is only injectable when the
 * providing module imports `DiscoveryModule`. Forget it and nothing fails to compile,
 * nothing is logged by Nest, and the product behaves exactly as though no indexer type
 * existed. The warning below on an empty registry is there so that afternoon is spent
 * somewhere else.
 */
@Injectable()
export class IndexerRegistry implements OnModuleInit {
	private readonly _logger = new Logger(IndexerRegistry.name);
	private readonly _indexers = new Map<IndexerType, ReleaseIndexer>();

	public constructor(
		private readonly _discovery: DiscoveryService,
		private readonly _reflector: Reflector,
	) {}

	public onModuleInit(): void {
		for (const wrapper of this._discovery.getProviders()) {
			const instance = wrapper.instance as ReleaseIndexer | undefined;

			if (!instance || !wrapper.metatype) {
				continue;
			}

			const type = this._reflector.get<IndexerType | undefined>(INDEXER_TYPE, wrapper.metatype);

			if (!type || this._indexers.has(type)) {
				continue;
			}

			this._indexers.set(type, instance);
		}

		if (this._indexers.size === 0) {
			this._logger.warn('No release indexer found. Is DiscoveryModule imported?');
		}
	}

	public get(type: IndexerType): ReleaseIndexer {
		const indexer = this._indexers.get(type);

		if (indexer === undefined) {
			throw new NotFoundException({ key: ErrorKey.INDEXER_UNKNOWN, detail: type });
		}

		return indexer;
	}
}
