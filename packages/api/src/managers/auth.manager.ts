import { createHash, randomBytes } from 'node:crypto';
import {
	AuthProviderType,
	ErrorKey,
	MediaServiceStatus,
	UserRole,
	type AuthProvider,
	type LoginRequest,
	type SessionUser,
	type TokenPair,
} from '@mcs/shared';
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import type { SecurityConfig } from '@/config';
import type { MediaService, User } from '@/entities';
import { MediaServiceRepository, SessionRepository, UserRepository } from '@/repositories';
import { rightsForRole } from '@/security';
import { HandlerRegistry, type ExternalIdentity } from '@/services';
import { toUser } from './mappers';

/** The key of the provider that holds accounts of our own. */
export const INTERNAL_PROVIDER = 'internal';

/** `service:<uuid>` — the key a media service is offered under on the sign-in screen. */
const SERVICE_PROVIDER = /^service:([0-9a-f-]{36})$/i;

/** What the sign-in screen and a refresh may tell us about the caller. */
export interface SessionContext {
	userAgent?: string | null;
	address?: string | null;
}

/**
 * `15m`, `30d`, `3600` — the forms the configuration accepts, in seconds.
 *
 * Kept here rather than trusted to the JWT library because the number also goes out
 * in `expiresIn`, and an interface that refreshes on the wrong schedule either
 * hammers the API or lets every request fail once before noticing.
 */
export const durationSeconds = (value: string, fallback: number): number => {
	const match = /^(\d+)\s*([smhd])?$/i.exec(value.trim());

	if (match === null) {
		return fallback;
	}

	const amount = Number(match[1]);
	const unit = (match[2] ?? 's').toLowerCase();
	const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;

	return amount * multiplier;
};

/**
 * Signing in, staying in, and getting out.
 *
 * Two rules run through the whole class. The gateway never stores a password it did
 * not issue, so an account mirrored from Jellyfin has a null hash for ever and its
 * credentials keep being checked where they live. And a refresh token is used once:
 * presenting one that has already been spent is not a mistake to shrug off, it is the
 * signature of a stolen token being replayed, so the whole session goes rather than
 * just that request.
 */
@Injectable()
export class AuthManager {
	private readonly _logger = new Logger(AuthManager.name);

	private readonly _security: SecurityConfig;

	public constructor(
		private readonly _users: UserRepository,
		private readonly _sessions: SessionRepository,
		private readonly _services: MediaServiceRepository,
		private readonly _handlers: HandlerRegistry,
		private readonly _jwt: JwtService,
		config: ConfigService,
	) {
		this._security = config.getOrThrow<SecurityConfig>('security');
	}

	/**
	 * The ways in, as the sign-in screen offers them.
	 *
	 * `internal` is always first and always there. A gateway whose only media service
	 * is down would otherwise have no way in at all, which is precisely the moment
	 * somebody needs to get in and fix it.
	 */
	public async providers(): Promise<AuthProvider[]> {
		const services = await this._services.findAuthProviders();

		return [
			{
				key: INTERNAL_PROVIDER,
				type: AuthProviderType.INTERNAL,
				label: 'Gateway account',
				icon: 'key',
				credentials: true,
			},
			...services.map((service) => ({
				key: `service:${service.id}`,
				type: AuthProviderType.SERVICE,
				label: service.name,
				icon: service.type,
				credentials: true,
			})),
		];
	}

	public async login(request: LoginRequest, context: SessionContext = {}): Promise<TokenPair> {
		const user =
			request.provider === INTERNAL_PROVIDER
				? await this._authenticateInternal(request.username, request.password)
				: await this._authenticateService(request);

		await this._users.touchLastSeen(user.id);

		return this._issue(user, context);
	}

	/**
	 * Trade a refresh token for a new pair.
	 *
	 * Single use: the presented session is revoked and a new one takes its place. That
	 * is what makes the replay check below mean anything — a token that is still valid
	 * after being used could be replayed for ever and nothing would be able to tell.
	 */
	public async refresh(refreshToken: string, context: SessionContext = {}): Promise<TokenPair> {
		const refreshTokenHash = this._hashToken(refreshToken);
		const session = await this._sessions.findValidByHash(refreshTokenHash);

		if (session === null) {
			await this._reportReplay(refreshTokenHash);

			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		const user = await this._users.findOne({ where: { id: session.userId } });

		if (user === null) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		await this._sessions.revoke(session.id);

		return this._issue(user, context);
	}

	/**
	 * Sign out.
	 *
	 * Every session of the account, not only the one that asked. The access token
	 * carries the session it belongs to but the authenticated user handed to a
	 * controller does not, so the choice is between signing out everywhere and signing
	 * out nowhere — and a sign-out button that leaves other sessions alive is worse
	 * than one that is broader than expected.
	 */
	public async logout(userId: string): Promise<void> {
		await this._sessions.revokeAllForUser(userId);
	}

	/** The signed-in user as the interface reads it, rights included. */
	public async session(userId: string): Promise<SessionUser> {
		const user = await this._users.findOne({ where: { id: userId } });

		if (user === null) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		return { ...toUser(user), rights: rightsForRole(user.role) };
	}

	/**
	 * Change the password of an account the gateway owns.
	 *
	 * Refused outright for a mirrored account: the password lives on the media
	 * service, and accepting a new one here would store a credential the gateway never
	 * issued and that nothing would ever check.
	 */
	public async changePassword(
		userId: string,
		currentPassword: string,
		newPassword: string,
	): Promise<void> {
		const user = await this._users
			.createQueryBuilder('user')
			.addSelect('user.passwordHash')
			.where('user.id = :userId', { userId })
			.getOne();

		if (user === null) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		if (user.provider !== INTERNAL_PROVIDER) {
			throw new ForbiddenException(ErrorKey.AUTH_FORBIDDEN);
		}

		if (user.passwordHash === null || !(await compare(currentPassword, user.passwordHash))) {
			throw new UnauthorizedException(ErrorKey.AUTH_INVALID_CREDENTIALS);
		}

		await this._users.update(
			{ id: user.id },
			{ passwordHash: await hash(newPassword, this._security.bcryptRounds) },
		);

		// A password change that leaves the old sessions alive changes nothing for
		// whoever the password was being changed because of.
		await this._sessions.revokeAllForUser(user.id);
	}

	private async _authenticateInternal(username: string, password: string): Promise<User> {
		const user = await this._users.findForAuthentication(username);

		// The same answer for an unknown account and a wrong password. Telling them
		// apart turns the sign-in form into a list of who has an account here.
		if (user === null || user.passwordHash === null) {
			throw new UnauthorizedException(ErrorKey.AUTH_INVALID_CREDENTIALS);
		}

		if (!(await compare(password, user.passwordHash))) {
			throw new UnauthorizedException(ErrorKey.AUTH_INVALID_CREDENTIALS);
		}

		return user;
	}

	private async _authenticateService(request: LoginRequest): Promise<User> {
		const match = SERVICE_PROVIDER.exec(request.provider);

		if (match === null) {
			throw new BadRequestException(ErrorKey.AUTH_PROVIDER_UNKNOWN);
		}

		const service = await this._services.findWithSecrets(match[1]);

		if (service === null || !service.authProvider) {
			throw new BadRequestException(ErrorKey.AUTH_PROVIDER_UNKNOWN);
		}

		const identity = await this._askService(service, request.username, request.password);

		return this._mirror(request.provider, identity);
	}

	private async _askService(
		service: MediaService,
		username: string,
		password: string,
	): Promise<ExternalIdentity> {
		try {
			return await this._handlers.get(service.type).authenticate(
				{
					id: service.id,
					type: service.type,
					baseUrl: service.baseUrl,
					token: service.token,
					username: service.username,
					password: service.password,
				},
				username,
				password,
			);
		} catch (error) {
			// A service that refuses these credentials and a service that is down are
			// different answers: one is "try again", the other is "this is not your
			// fault". The handler already answers 401 as an unauthorised exception.
			if (error instanceof UnauthorizedException) {
				throw new UnauthorizedException(ErrorKey.AUTH_INVALID_CREDENTIALS);
			}

			this._logger.warn(`Provider ${service.name} could not be asked: ${String(error)}`);
			await this._services.setStatus(service.id, MediaServiceStatus.OFFLINE);

			throw new ServiceUnavailableException(ErrorKey.AUTH_PROVIDER_UNREACHABLE);
		}
	}

	/**
	 * The local account standing for somebody who signs in through a media service.
	 *
	 * Created on first use and never given a password hash. The role is ours to decide
	 * and defaults to the least we can grant: being an administrator of a Jellyfin
	 * says nothing about who should be allowed to reconfigure this gateway.
	 */
	private async _mirror(provider: string, identity: ExternalIdentity): Promise<User> {
		const existing = await this._users.findByProvider(provider, identity.externalUserId);

		if (existing !== null) {
			existing.displayName = identity.displayName ?? existing.displayName;
			existing.email = identity.email ?? existing.email;
			existing.avatarUrl = identity.avatarUrl ?? existing.avatarUrl;

			return this._users.save(existing);
		}

		return this._users.save(
			this._users.create({
				username: await this._freeUsername(identity.username),
				displayName: identity.displayName,
				email: identity.email,
				avatarUrl: identity.avatarUrl,
				role: UserRole.USER,
				provider,
				providerUserId: identity.externalUserId,
				passwordHash: null,
			}),
		);
	}

	/**
	 * A username nothing else holds.
	 *
	 * Two people called `admin` on two different Jellyfins are two different people,
	 * and the column is unique. Suffixing is ugly and is the only thing that does not
	 * either fail the sign-in or hand one person the other's account.
	 */
	private async _freeUsername(preferred: string): Promise<string> {
		const base = preferred.trim() === '' ? 'user' : preferred.trim();

		for (let suffix = 0; suffix < 100; suffix += 1) {
			const candidate = suffix === 0 ? base : `${base}-${suffix}`;

			if ((await this._users.findByUsername(candidate)) === null) {
				return candidate;
			}
		}

		return `${base}-${randomBytes(4).toString('hex')}`;
	}

	private async _issue(user: User, context: SessionContext): Promise<TokenPair> {
		const refreshToken = randomBytes(48).toString('hex');
		const expiresIn = durationSeconds(this._security.accessTtl, 900);
		const refreshSeconds = durationSeconds(this._security.refreshTtl, 2_592_000);

		const session = await this._sessions.save(
			this._sessions.create({
				userId: user.id,
				// Only the hash is stored. A refresh token is a credential, and a stolen
				// database should not hand over live sessions along with the rows.
				refreshTokenHash: this._hashToken(refreshToken),
				expiresAt: new Date(Date.now() + refreshSeconds * 1000),
				userAgent: context.userAgent ?? null,
				address: context.address ?? null,
			}),
		);

		return {
			accessToken: this._jwt.sign({ sub: user.id, sid: session.id }),
			refreshToken,
			expiresIn,
			user: toUser(user),
			rights: rightsForRole(user.role),
		};
	}

	/**
	 * A refresh token that is known and no longer valid means somebody replayed one.
	 *
	 * The honest reading is that the token leaked: the legitimate client rotated it
	 * away, so whoever is presenting the old one got it somewhere else. Ignoring it
	 * would leave the thief's own session — obtained from the same leak — working. So
	 * the account's sessions all go, and both sides have to sign in again.
	 */
	private async _reportReplay(refreshTokenHash: string): Promise<void> {
		const spent = await this._sessions.findOne({ where: { refreshTokenHash } });

		if (spent === null) {
			return;
		}

		this._logger.warn(
			`A spent refresh token was presented for user ${spent.userId}; every session revoked.`,
		);

		await this._sessions.revokeAllForUser(spent.userId);
	}

	/**
	 * SHA-256, not bcrypt.
	 *
	 * The row is looked up by this value, so it has to be deterministic; a salted hash
	 * would mean reading every session on every refresh to find the one that matches.
	 * The input is 48 bytes of randomness rather than something a person chose, so
	 * there is nothing here for a slow hash to defend against.
	 */
	private _hashToken(token: string): string {
		return createHash('sha256').update(token).digest('hex');
	}
}
