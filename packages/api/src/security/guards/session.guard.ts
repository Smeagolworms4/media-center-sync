import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ErrorKey, type SessionUser } from '@mcs/shared';

/**
 * Authenticates a route that needs to know who is calling and nothing more.
 *
 * The global rights guard only authenticates a route that names a `Right`, which is
 * what keeps sign-in reachable without a session. But a handful of routes — who am I,
 * sign out, change my own password — need an identity without naming a privilege, and
 * borrowing a right they do not need would be a lie that breaks the day that right
 * stops being held by every role.
 *
 * Passport's guard is subclassed for one reason: its default rejection is the sentence
 * `Unauthorized`, and every other failure this API answers is a key the interface
 * translates. One route answering prose is enough to make the front end special-case
 * it for ever.
 */
@Injectable()
export class SessionGuard extends AuthGuard('jwt') {
	public handleRequest<TUser = SessionUser>(error: unknown, user: TUser | false): TUser {
		if (error !== null && error !== undefined) {
			throw error;
		}

		if (user === false || user === null || user === undefined) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		return user;
	}
}
