import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ErrorKey, type SessionUser } from '@mcs/shared';
import type { SecurityConfig } from '@/config';
import { SessionRepository, UserRepository } from '@/repositories';
import { rightsForRole } from '../role-hierarchy';

/** What the gateway puts in an access token, and nothing else. */
export interface JwtPayload {
	/** User identifier. */
	sub: string;
	/** Session identifier: the row that makes the token revocable. */
	sid: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
	public constructor(
		config: ConfigService,
		private readonly _sessions: SessionRepository,
		private readonly _users: UserRepository,
	) {
		super({
			/*
			 * The header first, and a `token` query parameter as a fallback.
			 *
			 * Two things a browser does cannot carry a header: the WebSocket handshake
			 * of the progress stream, and an `<img>` asking for a poster. Both are
			 * ordinary parts of this interface, and neither has an alternative — a
			 * poster fetched through `fetch` and turned into an object URL would defeat
			 * the browser's own image cache on a page showing two hundred of them.
			 *
			 * The cost is real and bounded: a token in a query string reaches server
			 * logs and, on a cross-origin navigation, a referrer. It is mitigated by
			 * the token being the short-lived access one — fifteen minutes — never the
			 * refresh token, and by these responses being marked private so no shared
			 * cache keeps them. The header remains the way everything else
			 * authenticates.
			 */
			jwtFromRequest: ExtractJwt.fromExtractors([
				ExtractJwt.fromAuthHeaderAsBearerToken(),
				ExtractJwt.fromUrlQueryParameter('token'),
			]),
			ignoreExpiration: false,
			secretOrKey: config.getOrThrow<SecurityConfig>('security').jwtSecret,
		});
	}

	/**
	 * Resolves the token into a user, and refuses it when its session is gone.
	 *
	 * A JWT is valid because of its signature, and nothing else: once issued, it keeps
	 * working until it expires, whatever happens afterwards. Signing out, revoking a
	 * device, disabling an account — none of them would take effect for the lifetime of
	 * a token already in someone's hands. Reading the session row on every call is what
	 * turns those actions into something immediate, and it is the reason sessions are
	 * stored at all. Drop this lookup and sign-out becomes a button that changes
	 * nothing for the next fifteen minutes.
	 */
	public async validate(payload: JwtPayload): Promise<SessionUser> {
		const session = await this._sessions.findValidById(payload.sid);

		if (session === null || session.userId !== payload.sub) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		const user = await this._users.findOne({ where: { id: payload.sub } });

		if (user === null) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		return {
			id: user.id,
			username: user.username,
			displayName: user.displayName,
			email: user.email,
			role: user.role,
			provider: user.provider,
			providerUserId: user.providerUserId,
			avatarUrl: user.avatarUrl,
			lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
			createdAt: user.createdAt.toISOString(),
			updatedAt: user.updatedAt.toISOString(),
			rights: rightsForRole(user.role),
		};
	}
}
