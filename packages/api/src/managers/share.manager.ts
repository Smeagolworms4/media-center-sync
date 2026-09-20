import {
	ErrorKey,
	MediaServiceMode,
	ShareVisibility,
	type ShareAudit,
	type SharePolicy,
	type UpdateSharePolicyRequest,
} from '@mcs/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type {
	Library as LibraryEntity,
	Peer as PeerEntity,
	SharePolicy as SharePolicyEntity,
} from '@/entities';
import {
	LibraryRepository,
	MediaServiceRepository,
	PeerRepository,
	SharePolicyRepository,
} from '@/repositories';
import {
	PeerCatalogueService,
	SettingsService,
	effectiveVisibility,
	serviceMode,
	type CataloguePolicy,
} from '@/services';
import { toSharePolicy } from './mappers';

/** One library, its stored policy if it has one, and what the two resolve to. */
interface ResolvedShare {
	library: LibraryEntity;
	stored: SharePolicyEntity | null;
	/** Whether the service this library sits on has its sharing switch on. */
	shared: boolean;
	/** Whether the gateway holds this library's files, rather than relaying them. */
	mounted: boolean;
	policy: CataloguePolicy;
}

/**
 * Who sees what.
 *
 * One rule runs through every method and is the reason this manager exists as
 * something other than a wrapper around a table: **the absence of a policy is not a
 * state, it is a question, and `effectiveVisibility` answers it**. A library on a
 * service whose sharing switch is on follows the gateway's `defaultShareVisibility`;
 * one on a service that is not shared stays private whatever that setting says.
 *
 * Whether the gateway holds the files does not enter into it, and used to. Serving a
 * library we only reach over HTTP works — `PeerExchangeManager.content()` opens a
 * stream against the media server and never looks for a local file — so refusing it
 * was gating something that already worked. What it needed was somebody saying so
 * once, and the switch on the service is where they say it.
 *
 * **Libraries on a peer-backed service are the exception and are never shared
 * onward.** Not off by default: excluded here, in the manager, so that it cannot
 * depend on a screen declining to offer a control. Reaching what a friend's friend
 * holds is going to be an introduction between the two ends that connects them
 * directly; carrying those bytes through the middle would be a second, independent
 * propagation stacked on the hop limit that exists to bound the first, and a path
 * people would come to depend on before the right one lands.
 *
 * Every read here therefore starts from the **libraries** and never from the policy
 * rows. Starting from the rows is what the previous version did, and it is precisely
 * why a fresh gateway shared nothing at all while its setting said
 * `friends_of_friends`: nothing writes a policy when a scan discovers a library, so
 * there were no rows to start from and every library was read as private.
 *
 * Nothing backfills those rows, deliberately. Writing the default into every library
 * would freeze the answer at install time — changing the setting afterwards would move
 * nothing — and would switch sharing on for data somebody already has. Resolved late,
 * the default moves everything nobody has overridden, and an explicit row always wins.
 */
@Injectable()
export class ShareManager {
	public constructor(
		private readonly _policies: SharePolicyRepository,
		private readonly _libraries: LibraryRepository,
		private readonly _peers: PeerRepository,
		private readonly _catalogue: PeerCatalogueService,
		private readonly _services: MediaServiceRepository,
		private readonly _settings: SettingsService,
	) {}

	/**
	 * Every library and what it exposes, whether or not anybody has said so.
	 *
	 * A library with no row is in this answer, marked as following the default. Leaving
	 * it out is what left the shares screen empty on a gateway that was in fact sharing
	 * its libraries — and a screen that cannot list a library cannot be used to change
	 * it either.
	 */
	public async list(): Promise<SharePolicy[]> {
		const resolved = await this._resolve();

		return resolved.map((share) =>
			toSharePolicy(share.library, share.stored, share.policy.visibility),
		);
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
		const shared = (await this._serviceFacts()).sharing.has(library.serviceId);
		const settings = await this._settings.get();
		const policy =
			existing ??
			this._policies.create({
				libraryId,
				/*
				 * A row created by a request that said nothing about visibility takes the
				 * answer the library had a moment ago, rather than private.
				 *
				 * Writing private here would make setting a rate limit on a library that
				 * was following the default silently stop sharing it: the row now exists,
				 * so the default no longer reaches it, and nothing on the screen said
				 * that was the trade. Seeding it with what was already in force makes a
				 * partial write change exactly the fields it names.
				 */
				visibility: effectiveVisibility({ library, policy: null, shared, settings }),
				allowedPeerIds: [],
				deniedPeerIds: [],
				rateLimit: 0,
			});

		policy.visibility = patch.visibility ?? policy.visibility;
		policy.allowedPeerIds = patch.allowedPeerIds ?? policy.allowedPeerIds;
		policy.deniedPeerIds = patch.deniedPeerIds ?? policy.deniedPeerIds;
		policy.rateLimit = patch.rateLimit ?? policy.rateLimit;

		const saved = await this._policies.save(policy);

		return toSharePolicy(library, saved, saved.visibility);
	}

	/**
	 * The two facts about services this manager reads, from one pass over them.
	 *
	 * `sharing` is the services whose libraries the gateway default reaches: the switch
	 * somebody set, minus every peer-backed service. That second half is not a
	 * duplicate of the switch's default — it is the enforcement, and it belongs here
	 * because a rule that lives only in the registration form holds until the first
	 * request somebody sends by hand. We do not carry a peer's bytes onward; that reach
	 * is an introduction between the two ends, not a relay through the middle, so no
	 * value of the switch may turn one of their libraries into something we serve.
	 *
	 * `mounted` is the services whose files we actually hold, and it gates nothing at
	 * all. A shared library we do not hold is read from its media server over HTTP and
	 * passed on, which works; this only says that doing so costs us our own line, which
	 * is worth stating in an audit and nowhere worth refusing over.
	 */
	private async _serviceFacts(): Promise<{ sharing: Set<string>; mounted: Set<string> }> {
		const services = await this._services.find();

		return {
			sharing: new Set(
				services
					.filter((service) => service.shared && service.peerId === null)
					.map((service) => service.id),
			),
			mounted: new Set(
				services
					.filter((service) => serviceMode(service) === MediaServiceMode.LOCAL)
					.map((service) => service.id),
			),
		};
	}

	/**
	 * Delete the policy, which hands the library back to the gateway default.
	 *
	 * Not the same thing as making it private any more: on one of our own services the
	 * default takes over, which is usually a level of sharing rather than none. Somebody
	 * who means private for this library alone writes `private` on it — that is an
	 * override, it survives a change of the default, and it is a different intention
	 * from "stop deciding about this one".
	 */
	public async remove(libraryId: string): Promise<void> {
		await this._policies.deleteForLibrary(libraryId);
	}

	/**
	 * What this peer would see of us.
	 *
	 * The question people actually ask before saving, and the only way to answer it
	 * honestly is to run the same visibility test the peer-facing routes run — not a
	 * summary of the settings, which is where the two would drift apart. That includes
	 * the libraries nobody has configured: they are most of a fresh gateway, and an
	 * audit that skipped them would answer "nothing" about a gateway that is sharing.
	 */
	public async audit(peerId: string): Promise<ShareAudit> {
		const peer = await this._requirePeer(peerId);
		const visible = await this._visibleShares(peer);

		// Read once for the whole answer. This list is not merged by name — it says what
		// one peer would be served, which is decided per library — so two rows called
		// `Movies` are ordinary here, and without the server beside them they read as a
		// rendering fault rather than as two libraries.
		const serviceNames = new Map(
			(await this._services.find()).map((service) => [service.id, service.name]),
		);

		return {
			peerId: peer.id,
			peerName: peer.name,
			trust: peer.trust,
			libraries: visible.map((share) => ({
				libraryId: share.library.id,
				name: share.library.name,
				serviceName: serviceNames.get(share.library.serviceId) ?? '',
				itemCount: share.library.itemCount,
				// Worth saying plainly in an audit: this one costs us our own line, and
				// hands on an access somebody gave to us rather than to them. It is a
				// fact about the share and not a refusal — saying it is the point.
				throughUs: !share.mounted,
			})),
		};
	}

	/** The policies a peer may see, already filtered. Used by the peer-facing routes. */
	public async visiblePolicies(peer: PeerEntity): Promise<CataloguePolicy[]> {
		return (await this._visibleShares(peer)).map((share) => share.policy);
	}

	/**
	 * The libraries one peer may see, which is where every answer to that question
	 * starts — the peer routes, and the audit that promises to say what they would get.
	 *
	 * **A peer forbidden from reading sees nothing, whatever the policies say.** The
	 * flag is read here and nowhere else on purpose: this is the one funnel
	 * `PeerExchangeManager` puts its catalogue, libraries, holders, announcements and
	 * per-item lookups through, so a second check elsewhere could only ever be a second
	 * place to forget. It sits a cut above `SharePolicy.deniedPeerIds`, which is per
	 * library and therefore cannot express "this person sees nothing of mine" without
	 * being edited into every policy that exists today and every one written next week.
	 *
	 * Nothing here touches the link. Forbidding reading leaves the socket open, so we
	 * keep pulling from them while they get an empty catalogue from us — the previous
	 * answer closed the connection and cut both directions at once.
	 */
	private async _visibleShares(peer: PeerEntity): Promise<ResolvedShare[]> {
		if (peer.readingForbidden) {
			return [];
		}

		return (await this._resolve()).filter((share) =>
			this._catalogue.isVisible(share.policy, {
				id: peer.id,
				name: peer.name,
				trust: peer.trust,
				viaPeerId: peer.viaPeerId,
			}),
		);
	}

	/**
	 * Every library, with the gateway default already applied to the ones nobody set.
	 *
	 * The single place the rule is read, so a caller cannot accidentally decide it a
	 * second way. Everything else in this manager — the list, the audit, what the peer
	 * routes are handed — starts here.
	 */
	private async _resolve(): Promise<ResolvedShare[]> {
		const libraries = await this._libraries.find();

		if (libraries.length === 0) {
			return [];
		}

		const rows = await this._policies.find();
		const stored = new Map(rows.map((row) => [row.libraryId, row]));
		const facts = await this._serviceFacts();
		const settings = await this._settings.get();

		return libraries.map((library) => {
			const policy = stored.get(library.id) ?? null;
			const shared = facts.sharing.has(library.serviceId);

			return {
				library,
				stored: policy,
				shared,
				mounted: facts.mounted.has(library.serviceId),
				policy: this._asCataloguePolicy(
					library.id,
					policy,
					effectiveVisibility({ library, policy, shared, settings }),
				),
			};
		});
	}

	private _asCataloguePolicy(
		libraryId: string,
		policy: {
			allowedPeerIds: string[];
			deniedPeerIds: string[];
			rateLimit?: number | string | null;
		} | null,
		visibility: ShareVisibility,
	): CataloguePolicy {
		return {
			libraryId,
			visibility,
			// A library nobody configured allows and denies nobody in particular: the
			// lists are exceptions to the rule above, and there is no row to hold them.
			allowedPeerIds: policy?.allowedPeerIds ?? [],
			deniedPeerIds: policy?.deniedPeerIds ?? [],
			// Stored as a bigint, which the driver hands back as a string on one engine
			// and a number on the other. Zero is the honest fallback for both, and it
			// means no cap of this library's own.
			rateLimit: Number(policy?.rateLimit ?? 0) || 0,
		};
	}

	private async _requirePeer(id: string): Promise<PeerEntity> {
		const peer = await this._peers.findOne({ where: { id } });

		if (peer === null) {
			throw new NotFoundException(ErrorKey.PEER_NOT_FOUND);
		}

		return peer;
	}
}
