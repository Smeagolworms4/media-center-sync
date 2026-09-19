import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@mcs/shared';

/** The request, once a strategy has put the authenticated user on it. */
export interface AuthenticatedRequest extends Request {
	user?: SessionUser;
	peerId?: string;
}

/**
 * The signed-in user, or `undefined` on a public route.
 *
 * Optional on purpose: a controller that also answers anonymous callers should be
 * able to ask who it is talking to without the framework deciding, from the type
 * alone, that nobody may.
 */
export const CurrentUser = createParamDecorator(
	(_data: unknown, context: ExecutionContext): SessionUser | undefined =>
		context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
