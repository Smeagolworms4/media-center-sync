import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ErrorKey, type Right, type SessionUser } from '@mcs/shared';
import { GRANTED_RIGHTS, PEER_ROUTE, type AuthenticatedRequest } from '@/decorators';

/**
 * Authentication and rights, in that order, for every HTTP route.
 *
 * A route with no `@Granted(...)` is public, deliberately. The alternative — deny
 * everything unless a decorator opens it — reads as the safer default and is not:
 * sign-in itself would need the identity it exists to establish, and so would the
 * health endpoint the container polls before anything is up. What makes that default
 * safe is that a route which forgets its decorator is a route that returns data to
 * anonymous callers, so `@Granted` belongs on the controller class whenever every one
 * of its routes needs the same right.
 */
@Injectable()
export class RightsGuard extends AuthGuard('jwt') {
	public constructor(private readonly _reflector: Reflector) {
		super();
	}

	public async canActivate(context: ExecutionContext): Promise<boolean> {
		// Peer routes carry a link credential rather than a session; the peer guard is
		// what checks them, and asking a machine for a user token would reject them all.
		if (this._reflector.getAllAndOverride<boolean>(PEER_ROUTE, [
			context.getHandler(),
			context.getClass(),
		]) === true) {
			return true;
		}

		const required = this._reflector.getAllAndOverride<Right[]>(GRANTED_RIGHTS, [
			context.getHandler(),
			context.getClass(),
		]);

		if (required === undefined || required.length === 0) {
			return true;
		}

		await this.authenticate(context);

		const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;

		if (user === undefined) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		if (!required.every((right) => user.rights.includes(right))) {
			throw new ForbiddenException(ErrorKey.AUTH_FORBIDDEN);
		}

		return true;
	}

	/** Runs the JWT strategy. Split out so it can be replaced in a unit test. */
	protected async authenticate(context: ExecutionContext): Promise<boolean> {
		return (await super.canActivate(context)) as boolean;
	}

	/**
	 * Every authentication failure answers with the same key.
	 *
	 * A missing token, an expired one and a revoked session are the same event as far
	 * as the caller is concerned: sign in again. Telling them apart would only tell an
	 * attacker which half of a guess was right.
	 */
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
