import type { MediaServiceType } from '@mcs/shared';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { MEDIA_DIRECTORY_TYPE } from './directory.decorator';
import type { ServiceDirectory } from './service-directory.interface';

/**
 * Finds every `@MediaDirectory` provider and resolves one by service type.
 *
 * A registry of its own rather than a second key in the handler registry, for the
 * reason `TransportRegistry` gives: the two sets are discovered at the same moment and
 * would be indistinguishable in one map. It does not warn when it finds nothing, unlike
 * the handler registry: a gateway with no directory is a gateway that registers every
 * server by address, which is what it did before this existed.
 */
@Injectable()
export class DirectoryRegistry implements OnModuleInit {
	private readonly _directories = new Map<MediaServiceType, ServiceDirectory>();

	public constructor(
		private readonly _discovery: DiscoveryService,
		private readonly _reflector: Reflector,
	) {}

	public onModuleInit(): void {
		for (const wrapper of this._discovery.getProviders()) {
			const instance = wrapper.instance as ServiceDirectory | undefined;

			if (!instance || !wrapper.metatype) {
				continue;
			}

			const type = this._reflector.get<MediaServiceType | undefined>(
				MEDIA_DIRECTORY_TYPE,
				wrapper.metatype,
			);

			if (type && !this._directories.has(type)) {
				this._directories.set(type, instance);
			}
		}
	}

	/** Null for a type nobody can sign in to and be told its servers. */
	public find(type: MediaServiceType): ServiceDirectory | null {
		return this._directories.get(type) ?? null;
	}

	/** What the add screen offers a sign-in for. */
	public types(): MediaServiceType[] {
		return [...this._directories.keys()];
	}

	/** For tests and trimmed contexts, like `HandlerRegistry.register`. */
	public register(directory: ServiceDirectory): void {
		this._directories.set(directory.type, directory);
	}
}
