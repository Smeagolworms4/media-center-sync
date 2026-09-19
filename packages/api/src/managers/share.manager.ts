import {
	ErrorKey,
	MediaServiceScope,
	ShareVisibility,
	type ShareAudit,
	type SharePolicy,
	type UpdateSharePolicyRequest,
} from '@mcs/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { In } from 'typeorm';
import type { Library as LibraryEntity, Peer as PeerEntity } from '@/entities';
import {
	LibraryRepository,
	MediaServiceRepository,
	PeerRepository,
	SharePolicyRepository,
} from '@/repositories';
import { PeerCatalogueService, type CataloguePolicy } from '@/services';
import { toSharePolicy } from './mappers';

/**
 * Who sees what.
 *
 * One rule runs through every method and is the reason this manager exists as
 * something other than a wrapper around a table: **the absence of a policy means
 * private**. Not "unconfigured", not "inherits from the service" — private. A library
 * is never shared by having been forgotten, which is the only safe default for a
 * mechanism that exposes somebody's files to another household. Every read here
 * therefore starts from the policies that exist and never from the libraries, so a
 * library with no row cannot appear in an answer at all.
 */
@Injectable()
export class ShareManager {
	public constructor(
		private readonly _policies: SharePolicyRepository,
		private readonly _libraries: LibraryRepository,
		private readonly _peers: PeerRepository,
		private readonly _catalogue: PeerCatalogueService,
		private readonly _services: MediaServiceRepository,
	) {}

	public async list(): Promise<SharePolicy[]> {
		const policies = await this._policies.find();
		const libraries = await this._librariesOf(policies.map((policy) => policy.libraryId));
		// Read once for the whole page rather than per row, and passed through: the
		// mapper treats an unstated scope as remote, so a list that left it out reported
		// every policy as making us a relay — including our own libraries, which makes
		// the flag say nothing on the one screen that shows them side by side.
		const localServices = await this._localServiceIds();

		return policies.map((policy) => {
			const library = libraries.get(policy.libraryId) ?? null;

			return toSharePolicy(
				policy,
				library,
				library !== null && localServices.has(library.serviceId),
			);
		});
	}

	/**
	 * Write the policy of one library, creating it if there was none.
	 *
	 * `PUT` rather than `POST` because a library has at most one: the identifier in the
	 * path is the library's, not the policy's, and saving twice has to be the same as
	 * saving once.
	 */
	public async put(libraryId: string, patch: UpdateSharePolicyRequest): Promise<SharePolicy> {
		const library = await this._libraries.findOne({ where: { id: libraryId } });

		if (library === null) {
			throw new NotFoundException(ErrorKey.LIBRARY_NOT_FOUND);
		}

		const existing = await this._policies.findByLibrary(libraryId);
		const policy =
			existing ??
			this._policies.create({
				libraryId,
				// A policy created by a request that said nothing about visibility is
				// still private. The row's existence is not consent.
				visibility: ShareVisibility.PRIVATE,
				allowedPeerIds: [],
				deniedPeerIds: [],
				rateLimit: 0,
				relay: false,
			});

		policy.visibility = patch.visibility ?? policy.visibility;
		policy.allowedPeerIds = patch.allowedPeerIds ?? policy.allowedPeerIds;
		policy.deniedPeerIds = patch.deniedPeerIds ?? policy.deniedPeerIds;
		policy.rateLimit = patch.rateLimit ?? policy.rateLimit;
		policy.relay = patch.relay ?? policy.relay ?? false;

		const local = await this._isLocal(library.serviceId);

		/*
		 * A library that is not ours stays private until somebody says otherwise.
		 *
		 * Sharing one of our own libraries gives away our own bytes off our own disk.
		 * Sharing a remote one makes us the conduit: our bandwidth, our connection, and
		 * an access granted to us rather than to the people we would be handing it to.
		 * That is a useful thing to do on purpose — it is how somebody with a good line
		 * makes a distant server reachable for their friends — and never a thing to do
		 * by accident, so it is refused rather than assumed.
		 */
		if (!local && !policy.relay && policy.visibility !== ShareVisibility.PRIVATE) {
			throw new ConflictException(ErrorKey.SHARE_RELAY_NOT_AGREED);
		}

		const saved = await this._policies.save(policy);

		return toSharePolicy(saved, { name: library.name, serviceId: library.serviceId }, local);
	}

	/** The services whose libraries are ours to give rather than ours to pass on. */
	private async _localServiceIds(): Promise<Set<string>> {
		const services = await this._services.find();

		return new Set(
			services
				.filter((service) => service.scope === MediaServiceScope.LOCAL)
				.map((service) => service.id),
		);
	}

	private async _isLocal(serviceId: string): Promise<boolean> {
		return (await this._localServiceIds()).has(serviceId);
	}

	/**
	 * Delete the policy, which makes the library private again.
	 *
	 * The same thing as never having shared it, which is why deleting is a complete
	 * answer and no "private" row has to be left behind.
	 */
	public async remove(libraryId: string): Promise<void> {
		await this._policies.deleteForLibrary(libraryId);
	}

	/**
	 * What this peer would see of us.
	 *
	 * The question people actually ask before saving, and the only way to answer it
	 * honestly is to run the same visibility test the peer-facing routes run — not a
	 * summary of the settings, which is where the two would drift apart.
	 */
	public async audit(peerId: string): Promise<ShareAudit> {
		const peer = await this._requirePeer(peerId);
		const policies = await this._policies.find();
		const libraries = await this._librariesOf(policies.map((policy) => policy.libraryId));
		const localServices = await this._localServiceIds();

		const visible = policies.filter((policy) =>
			this._catalogue.isVisible(this._asCataloguePolicy(policy), {
				id: peer.id,
				name: peer.name,
				trust: peer.trust,
				viaPeerId: peer.viaPeerId,
			}),
		);

		return {
			peerId: peer.id,
			peerName: peer.name,
			trust: peer.trust,
			libraries: visible.map((policy) => ({
				libraryId: policy.libraryId,
				name: libraries.get(policy.libraryId)?.name ?? '',
				itemCount: libraries.get(policy.libraryId)?.itemCount ?? 0,
				// Worth saying plainly in an audit: this one costs us, and hands on an
				// access somebody gave to us rather than to them.
				throughUs: !localServices.has(libraries.get(policy.libraryId)?.serviceId ?? ''),
			})),
		};
	}

	/** The policies a peer may see, already filtered. Used by the peer-facing routes. */
	public async visiblePolicies(peer: PeerEntity): Promise<CataloguePolicy[]> {
		const policies = await this._policies.find();

		return policies
			.map((policy) => this._asCataloguePolicy(policy))
			.filter((policy) =>
				this._catalogue.isVisible(policy, {
					id: peer.id,
					name: peer.name,
					trust: peer.trust,
					viaPeerId: peer.viaPeerId,
				}),
			);
	}

	private _asCataloguePolicy(policy: {
		libraryId: string;
		visibility: ShareVisibility;
		allowedPeerIds: string[];
		deniedPeerIds: string[];
		rateLimit?: number | string | null;
	}): CataloguePolicy {
		return {
			libraryId: policy.libraryId,
			visibility: policy.visibility,
			allowedPeerIds: policy.allowedPeerIds,
			deniedPeerIds: policy.deniedPeerIds,
			// Stored as a bigint, which the driver hands back as a string on one engine
			// and a number on the other. Zero is the honest fallback for both, and it
			// means no cap of this library's own.
			rateLimit: Number(policy.rateLimit ?? 0) || 0,
		};
	}

	private async _librariesOf(
		ids: string[],
	): Promise<Map<string, { name: string; serviceId: string; itemCount: number }>> {
		if (ids.length === 0) {
			return new Map();
		}

		const libraries = await this._libraries.find({ where: { id: In(ids) } });

		return new Map(
			libraries.map((library: LibraryEntity) => [
				library.id,
				{ name: library.name, serviceId: library.serviceId, itemCount: library.itemCount },
			]),
		);
	}

	private async _requirePeer(id: string): Promise<PeerEntity> {
		const peer = await this._peers.findOne({ where: { id } });

		if (peer === null) {
			throw new NotFoundException(ErrorKey.PEER_NOT_FOUND);
		}

		return peer;
	}
}
