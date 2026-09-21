import { randomUUID } from 'node:crypto';
import {
	DirectorySignInState,
	ErrorKey,
	type DirectorySignIn,
	type DiscoveredFailure,
	type DiscoveredServer,
	type MediaServiceType,
	type RegisterDiscoveredResult,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	HttpException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import type { MediaService as MediaServiceEntity } from '@/entities';
import { MediaServiceRepository } from '@/repositories';
import {
	CacheService,
	DirectoryRegistry,
	type DirectoryServer,
	type ResolvedConnection,
	type ServiceDirectory,
} from '@/services';
import { ServiceManager } from './service.manager';

/**
 * How long a sign-in stays usable once it was approved.
 *
 * Long enough to read the list, tick boxes and change one's mind twice; short enough
 * that an account token nobody used does not sit in the cache for the rest of the day.
 * Nothing is lost when it lapses but the list on screen, and signing in again is one
 * click on a page where the person is already signed in.
 */
const APPROVED_TTL_SECONDS = 30 * 60;

/**
 * How long past its expiry a pending sign-in is kept, so that a poll arriving just
 * after the deadline is told "expired" rather than "no such sign-in".
 */
const EXPIRY_GRACE_SECONDS = 60;

const CACHE_PREFIX = 'directory:sign-in:';

/**
 * One sign-in, as the gateway keeps it between the dialog's polls.
 *
 * In the cache, and deliberately nowhere more durable. It holds an account token that
 * is only needed for the minutes somebody spends in the add dialog; a table would keep
 * it after they left, and a gateway that restarts in the middle simply asks them to
 * sign in again — which on plex.tv, where they are already signed in, is one click.
 */
interface SignInRecord {
	id: string;
	type: MediaServiceType;
	userId: string;
	pinId: string;
	code: string;
	authUrl: string;
	expiresAt: string;
	accountToken: string | null;
}

/**
 * Finding media servers through a directory — plex.tv — and registering them.
 *
 * The decisions live here and the conversation with plex.tv does not: which sign-in
 * belongs to whom, which servers are already registered, what a server shared by a
 * friend is registered as. How to ask plex.tv, and in which order to try a server's
 * addresses, is the directory's business.
 */
@Injectable()
export class DirectoryManager {
	public constructor(
		private readonly _directories: DirectoryRegistry,
		private readonly _cache: CacheService,
		private readonly _services: MediaServiceRepository,
		private readonly _serviceManager: ServiceManager,
	) {}

	/** The service types somebody can sign in to and be shown their servers. */
	public types(): MediaServiceType[] {
		return this._directories.types();
	}

	public async startSignIn(type: MediaServiceType, userId: string): Promise<DirectorySignIn> {
		const pin = await this._directory(type).startSignIn();
		const record: SignInRecord = {
			id: randomUUID(),
			type,
			userId,
			pinId: pin.pinId,
			code: pin.code,
			authUrl: pin.authUrl,
			expiresAt: pin.expiresAt.toISOString(),
			accountToken: null,
		};

		await this._store(record, this._pendingTtl(record));

		return this._present(record, DirectorySignInState.PENDING);
	}

	/**
	 * Where a sign-in stands, asking the directory only while there is something to ask.
	 *
	 * Once approved, the answer is ours and the directory is not polled again. Once
	 * expired, the record is dropped: the dialog is about to offer a new sign-in, and a
	 * stale one left behind is a PIN somebody could still approve for nothing.
	 */
	public async readSignIn(id: string, userId: string): Promise<DirectorySignIn> {
		const record = await this._require(id, userId);

		if (record.accountToken !== null) {
			return this._present(record, DirectorySignInState.APPROVED);
		}

		const check = new Date(record.expiresAt).getTime() <= Date.now()
			? ({ state: 'expired' } as const)
			: await this._directory(record.type).checkSignIn(record);

		if (check.state === 'expired') {
			await this._cache.delete(this._key(id));

			return this._present(record, DirectorySignInState.EXPIRED);
		}

		if (check.state === 'pending') {
			return this._present(record, DirectorySignInState.PENDING);
		}

		record.accountToken = check.accountToken;
		await this._store(record, APPROVED_TTL_SECONDS);

		return this._present(record, DirectorySignInState.APPROVED);
	}

	/**
	 * Forget a sign-in, and the account token with it.
	 *
	 * The PIN itself is left to lapse at plex.tv: there is no route to withdraw one, and
	 * once the gateway has forgotten it, approving it hands a token to nobody.
	 */
	public async cancelSignIn(id: string, userId: string): Promise<void> {
		await this._require(id, userId);
		await this._cache.delete(this._key(id));
	}

	/**
	 * Every server the account reaches, whether it answers from here, and whether it is
	 * already registered.
	 *
	 * Every server is probed, the registered ones included: "already registered" and
	 * "not answering right now" are both worth knowing when looking at the list, and
	 * the probes run at once, so the slowest address sets the wait, not their sum.
	 */
	public async servers(id: string, userId: string): Promise<DiscoveredServer[]> {
		const { record, directory, servers } = await this._approvedServers(id, userId);
		const registered = await this._registered(record.type, servers);
		const resolved = await Promise.all(servers.map((server) => directory.resolve(server)));

		return servers
			.map((server, index) => this._toDiscovered(server, resolved[index], registered.get(server.identifier)))
			.sort((a, b) =>
				Number(b.owned) - Number(a.owned)
				|| (a.ownerName ?? '').localeCompare(b.ownerName ?? '')
				|| a.name.localeCompare(b.name));
	}

	/**
	 * Register several servers at once, each on its own.
	 *
	 * One that cannot come in — it went offline between the list and the click, a
	 * friend stopped sharing it, it is registered already — is reported by name and
	 * does not hold the others back: somebody who ticked three servers and got one
	 * error would otherwise have to find out which two did not need retrying.
	 *
	 * One at a time rather than at once, because every registration checks the unique
	 * address and two of them racing past that check would be refused by the database
	 * with an error naming a constraint.
	 */
	public async register(
		id: string,
		userId: string,
		identifiers: string[],
	): Promise<RegisterDiscoveredResult> {
		const { record, directory, servers } = await this._approvedServers(id, userId);
		const registered = await this._registered(record.type, servers);
		const result: RegisterDiscoveredResult = { created: [], failed: [] };

		for (const identifier of new Set(identifiers)) {
			const server = servers.find((one) => one.identifier === identifier);

			if (server === undefined) {
				result.failed.push({ identifier, name: null, error: ErrorKey.DIRECTORY_SERVER_NOT_FOUND });

				continue;
			}

			if (registered.has(identifier)) {
				result.failed.push(this._failure(server, ErrorKey.SERVICE_DUPLICATE));

				continue;
			}

			const resolved = await directory.resolve(server);

			if (resolved === null) {
				result.failed.push(this._failure(server, ErrorKey.DIRECTORY_SERVER_UNREACHABLE));

				continue;
			}

			try {
				result.created.push(await this._serviceManager.createDiscovered(
					{
						name: this._nameOf(server),
						type: record.type,
						baseUrl: resolved.baseUrl,
						token: server.accessToken ?? undefined,
						/*
						 * A friend's server is not offered on to our own peers.
						 *
						 * Sharing is a switch on each service, on by default for one somebody
						 * registers by hand because it is usually theirs. A server shared
						 * with the account is somebody else's library, lent to this account;
						 * passing it on to people its owner has never heard of is a decision
						 * for its owner, and the person can still turn it on if they have it.
						 */
						shared: server.owned,
					},
					{
						serverIdentifier: server.identifier,
						accountToken: record.accountToken as string,
						connectionRoute: resolved.route,
					},
				));
			} catch (error) {
				result.failed.push(this._failure(server, this._keyOf(error)));
			}
		}

		return result;
	}

	private async _approvedServers(id: string, userId: string): Promise<{
		record: SignInRecord & { accountToken: string };
		directory: ServiceDirectory;
		servers: DirectoryServer[];
	}> {
		const record = await this._require(id, userId);

		if (record.accountToken === null) {
			throw new BadRequestException(ErrorKey.DIRECTORY_SIGN_IN_PENDING);
		}

		const directory = this._directory(record.type);
		const servers = await directory.listServers(record.accountToken);

		return { record: record as SignInRecord & { accountToken: string }, directory, servers };
	}

	/**
	 * Which of these servers this gateway already holds, by the service that holds each.
	 *
	 * By identity first, which is exact. By address as well, for a server somebody
	 * registered by hand before this existed: it carries no identity, but if its stored
	 * address is one plex.tv lists for that server, it is that server, and offering it
	 * again would index it twice.
	 */
	private async _registered(
		type: MediaServiceType,
		servers: DirectoryServer[],
	): Promise<Map<string, MediaServiceEntity>> {
		const byIdentity = await this._services.findByServerIdentifiers(servers.map((one) => one.identifier));
		const owned = (await this._services.findOwned()).filter((one) => one.type === type);
		const registered = new Map<string, MediaServiceEntity>();

		for (const server of servers) {
			const match = byIdentity.find((one) => one.serverIdentifier === server.identifier)
				?? owned.find((one) => server.connections.some((connection) => connection.uri === one.baseUrl));

			if (match !== undefined) {
				registered.set(server.identifier, match);
			}
		}

		return registered;
	}

	private _toDiscovered(
		server: DirectoryServer,
		resolved: ResolvedConnection | null,
		registered: MediaServiceEntity | undefined,
	): DiscoveredServer {
		return {
			identifier: server.identifier,
			name: server.name,
			owned: server.owned,
			ownerName: server.ownerName,
			version: server.version,
			reachable: resolved !== null,
			route: resolved?.route ?? null,
			baseUrl: resolved?.baseUrl ?? null,
			registeredServiceId: registered?.id ?? null,
		};
	}

	/**
	 * A friend's server carries its owner's name.
	 *
	 * Everybody's Plex is called something like "Plex" or "Home", and two friends
	 * sharing theirs would otherwise be two indistinguishable rows on the services
	 * screen, where nothing else says whose each one is.
	 */
	private _nameOf(server: DirectoryServer): string {
		return server.owned || server.ownerName === null
			? server.name
			: `${server.name} (${server.ownerName})`;
	}

	private _failure(server: DirectoryServer, error: string): DiscoveredFailure {
		return { identifier: server.identifier, name: server.name, error };
	}

	/**
	 * The error key an exception carries, whichever of the two shapes it was raised in —
	 * `{ key }` or the key as the message.
	 */
	private _keyOf(error: unknown): string {
		if (error instanceof ConflictException) {
			return ErrorKey.SERVICE_DUPLICATE;
		}

		if (error instanceof HttpException) {
			const response = error.getResponse() as { key?: unknown; message?: unknown } | string;
			const key = typeof response === 'string' ? response : (response.key ?? response.message);

			if (typeof key === 'string' && key.startsWith('error.')) {
				return key;
			}
		}

		return ErrorKey.GENERAL;
	}

	private _directory(type: MediaServiceType): ServiceDirectory {
		const directory = this._directories.find(type);

		if (directory === null) {
			throw new BadRequestException(ErrorKey.DIRECTORY_UNSUPPORTED);
		}

		return directory;
	}

	/**
	 * The sign-in, if it exists and was started by this person.
	 *
	 * Somebody else's is answered exactly like one that does not exist. Its handle is a
	 * random identifier nobody else was shown, and another administrator stumbling on
	 * it has no business listing, let alone registering, the servers of an account that
	 * is not theirs.
	 */
	private async _require(id: string, userId: string): Promise<SignInRecord> {
		const record = await this._cache.get<SignInRecord>(this._key(id));

		if (record === null || record.userId !== userId) {
			throw new NotFoundException(ErrorKey.DIRECTORY_SIGN_IN_NOT_FOUND);
		}

		return record;
	}

	private _present(record: SignInRecord, state: DirectorySignInState): DirectorySignIn {
		return {
			id: record.id,
			type: record.type,
			state,
			authUrl: record.authUrl,
			code: record.code,
			expiresAt: record.expiresAt,
		};
	}

	private _pendingTtl(record: SignInRecord): number {
		const remaining = Math.ceil((new Date(record.expiresAt).getTime() - Date.now()) / 1000);

		return Math.max(remaining, 0) + EXPIRY_GRACE_SECONDS;
	}

	private _store(record: SignInRecord, ttlSeconds: number): Promise<void> {
		return this._cache.set(this._key(record.id), record, ttlSeconds);
	}

	private _key(id: string): string {
		return `${CACHE_PREFIX}${id}`;
	}
}
