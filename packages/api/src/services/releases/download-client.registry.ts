import { DownloadClientType, ErrorKey } from '@mcs/shared';
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { DOWNLOAD_CLIENT_TYPE } from './download-client.decorator';
import type { DownloadClient } from './download-client.interface';

/** Finds every `@DownloadClientFor` provider. See `IndexerRegistry` for the trap. */
@Injectable()
export class DownloadClientRegistry implements OnModuleInit {
	private readonly _logger = new Logger(DownloadClientRegistry.name);
	private readonly _clients = new Map<DownloadClientType, DownloadClient>();

	public constructor(
		private readonly _discovery: DiscoveryService,
		private readonly _reflector: Reflector,
	) {}

	public onModuleInit(): void {
		for (const wrapper of this._discovery.getProviders()) {
			const instance = wrapper.instance as DownloadClient | undefined;

			if (!instance || !wrapper.metatype) {
				continue;
			}

			const type = this._reflector.get<DownloadClientType | undefined>(
				DOWNLOAD_CLIENT_TYPE,
				wrapper.metatype,
			);

			if (!type || this._clients.has(type)) {
				continue;
			}

			this._clients.set(type, instance);
		}

		if (this._clients.size === 0) {
			this._logger.warn('No download client found. Is DiscoveryModule imported?');
		}
	}

	public get(type: DownloadClientType): DownloadClient {
		const client = this._clients.get(type);

		if (client === undefined) {
			throw new NotFoundException({ key: ErrorKey.DOWNLOAD_CLIENT_UNKNOWN, detail: type });
		}

		return client;
	}
}
