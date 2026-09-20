import { ErrorKey, TransferTransport } from '@mcs/shared';
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { TRANSPORT_KIND } from './transport.decorator';
import type { ByteTransport } from './transport.interface';

/**
 * Resolves a transport by kind, the same way handlers are resolved.
 *
 * Deliberately a second registry rather than a shared generic one: the two sets are
 * discovered at the same moment and would be indistinguishable in one map, and a
 * generic that takes a metadata key as a parameter reads worse than the twenty
 * lines it saves.
 */
@Injectable()
export class TransportRegistry implements OnModuleInit {
	private readonly _logger = new Logger(TransportRegistry.name);
	private readonly _transports = new Map<TransferTransport, ByteTransport>();

	public constructor(
		private readonly _discovery: DiscoveryService,
		private readonly _reflector: Reflector,
	) {}

	public onModuleInit(): void {
		for (const wrapper of this._discovery.getProviders()) {
			const instance = wrapper.instance as ByteTransport | undefined;

			if (!instance || !wrapper.metatype) {
				continue;
			}

			const kind = this._reflector.get<TransferTransport | undefined>(
				TRANSPORT_KIND,
				wrapper.metatype,
			);

			if (kind && !this._transports.has(kind)) {
				this._transports.set(kind, instance);
			}
		}

		if (this._transports.size === 0) {
			this._logger.warn(
				'No transport discovered. Without DiscoveryModule imported, every transfer will fail with an unknown transport.',
			);
		}
	}

	public get(kind: TransferTransport): ByteTransport {
		const transport = this.find(kind);

		if (!transport) {
			throw new NotFoundException({ key: ErrorKey.GENERAL, transport: kind });
		}

		return transport;
	}

	public find(kind: TransferTransport): ByteTransport | null {
		return this._transports.get(this._alias(kind)) ?? null;
	}

	/**
	 * Direct and relayed are the same transport.
	 *
	 * Whether a peer link goes straight there or through a friend is decided
	 * when the link is established, can change under a running transfer, and makes no
	 * difference at all to how a range is asked for. The two enum values exist so the
	 * interface can say which one is in use, not so there can be two implementations.
	 */
	private _alias(kind: TransferTransport): TransferTransport {
		return kind === TransferTransport.PEER_RELAY ? TransferTransport.PEER_DIRECT : kind;
	}

	/** For tests and the command-line entry points, which skip the discovery pass. */
	public register(transport: ByteTransport): void {
		this._transports.set(transport.transport, transport);
	}
}
