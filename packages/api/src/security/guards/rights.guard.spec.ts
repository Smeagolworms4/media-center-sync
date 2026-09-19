import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorKey, Right, type SessionUser } from '@mcs/shared';
import { GRANTED_RIGHTS, PEER_ROUTE } from '@/decorators';
import { RightsGuard } from './rights.guard';

/**
 * The guard with its authentication step replaced.
 *
 * `super.canActivate()` runs passport, which needs a strategy, a request and a real
 * token; none of that says anything about the rule under test, which is what happens
 * once a user is — or is not — on the request.
 */
class TestableGuard extends RightsGuard {
	public constructor(
		reflector: Reflector,
		private readonly _authenticated: boolean,
	) {
		super(reflector);
	}

	protected override async authenticate(): Promise<boolean> {
		if (!this._authenticated) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		return true;
	}
}

const contextFor = (user?: SessionUser): ExecutionContext =>
	({
		getHandler: () => (): void => undefined,
		getClass: () => class Controller {},
		switchToHttp: () => ({ getRequest: () => ({ user }) }),
	}) as unknown as ExecutionContext;

const reflectorReturning = (metadata: Record<string, unknown>): Reflector =>
	({
		getAllAndOverride: jest.fn((key: string) => metadata[key]),
	}) as unknown as Reflector;

const userWith = (...rights: Right[]): SessionUser => ({ rights }) as SessionUser;

describe('RightsGuard', () => {
	it('lets a route with no decorator through, without authenticating', async () => {
		const guard = new TestableGuard(reflectorReturning({}), false);

		await expect(guard.canActivate(contextFor())).resolves.toBe(true);
	});

	it('lets a route through when the decorator names no right', async () => {
		const guard = new TestableGuard(reflectorReturning({ [GRANTED_RIGHTS]: [] }), false);

		await expect(guard.canActivate(contextFor())).resolves.toBe(true);
	});

	it('leaves peer routes to the peer guard', async () => {
		const guard = new TestableGuard(
			reflectorReturning({ [PEER_ROUTE]: true, [GRANTED_RIGHTS]: [Right.MEDIA_READ] }),
			false,
		);

		await expect(guard.canActivate(contextFor())).resolves.toBe(true);
	});

	it('grants access when the user carries every required right', async () => {
		const guard = new TestableGuard(
			reflectorReturning({ [GRANTED_RIGHTS]: [Right.MEDIA_READ, Right.SYNC_READ] }),
			true,
		);

		await expect(
			guard.canActivate(contextFor(userWith(Right.MEDIA_READ, Right.SYNC_READ, Right.PEER_READ))),
		).resolves.toBe(true);
	});

	it('denies access when one of the required rights is missing', async () => {
		const guard = new TestableGuard(
			reflectorReturning({ [GRANTED_RIGHTS]: [Right.MEDIA_READ, Right.SERVICE_MANAGE] }),
			true,
		);

		await expect(guard.canActivate(contextFor(userWith(Right.MEDIA_READ)))).rejects.toThrow(
			ForbiddenException,
		);
	});

	it('answers with an error key and never a sentence', async () => {
		const guard = new TestableGuard(
			reflectorReturning({ [GRANTED_RIGHTS]: [Right.SERVICE_MANAGE] }),
			true,
		);

		await expect(guard.canActivate(contextFor(userWith()))).rejects.toThrow(
			ErrorKey.AUTH_FORBIDDEN,
		);
	});

	it('refuses an anonymous caller on a protected route', async () => {
		const guard = new TestableGuard(
			reflectorReturning({ [GRANTED_RIGHTS]: [Right.MEDIA_READ] }),
			false,
		);

		await expect(guard.canActivate(contextFor())).rejects.toThrow(UnauthorizedException);
	});

	it('turns a passport rejection into the session error key', () => {
		const guard = new TestableGuard(reflectorReturning({}), true);

		expect(() => guard.handleRequest(null, false)).toThrow(ErrorKey.AUTH_SESSION_EXPIRED);
		expect(guard.handleRequest(null, userWith(Right.MEDIA_READ))).toEqual(
			userWith(Right.MEDIA_READ),
		);
	});
});
