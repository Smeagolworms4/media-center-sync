import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorKey, Right, UserRole } from '@mcs/shared';
import type { Session, User } from '@/entities';
import type { SessionRepository, UserRepository } from '@/repositories';
import { JwtStrategy } from './jwt.strategy';

const config = {
	getOrThrow: () => ({ jwtSecret: 'test-secret', accessTtl: '15m', refreshTtl: '30d', bcryptRounds: 4 }),
} as unknown as ConfigService;

const aUser = (): User =>
	({
		id: 'user-1',
		username: 'ada',
		displayName: null,
		email: null,
		role: UserRole.USER,
		provider: 'internal',
		providerUserId: null,
		avatarUrl: null,
		lastSeenAt: null,
		createdAt: new Date('2024-01-01T00:00:00.000Z'),
		updatedAt: new Date('2024-01-02T00:00:00.000Z'),
	}) as User;

const build = (
	session: Session | null,
	user: User | null,
): { strategy: JwtStrategy; sessions: { findValidById: jest.Mock }; users: { findOne: jest.Mock } } => {
	const sessions = { findValidById: jest.fn().mockResolvedValue(session) };
	const users = { findOne: jest.fn().mockResolvedValue(user) };

	return {
		strategy: new JwtStrategy(
			config,
			sessions as unknown as SessionRepository,
			users as unknown as UserRepository,
		),
		sessions,
		users,
	};
};

describe('JwtStrategy', () => {
	it('resolves the token into a user carrying the rights of its role', async () => {
		const { strategy } = build({ id: 'session-1', userId: 'user-1' } as Session, aUser());

		const resolved = await strategy.validate({ sub: 'user-1', sid: 'session-1' });

		expect(resolved.id).toBe('user-1');
		expect(resolved.rights).toContain(Right.MEDIA_READ);
		expect(resolved.rights).not.toContain(Right.USER_MANAGE);
		// The shared contract is made of strings; a Date here reaches the interface as
		// whatever `JSON.stringify` decides, which is not what the type promises.
		expect(resolved.createdAt).toBe('2024-01-01T00:00:00.000Z');
	});

	it('rejects a token whose session was revoked or has expired', async () => {
		// This is the whole reason sessions are stored: the token itself is still
		// perfectly signed and still within its lifetime.
		const { strategy, sessions } = build(null, aUser());

		await expect(strategy.validate({ sub: 'user-1', sid: 'session-1' })).rejects.toThrow(
			UnauthorizedException,
		);
		expect(sessions.findValidById).toHaveBeenCalledWith('session-1');
	});

	it('rejects a token whose session belongs to somebody else', async () => {
		const { strategy } = build({ id: 'session-1', userId: 'user-2' } as Session, aUser());

		await expect(strategy.validate({ sub: 'user-1', sid: 'session-1' })).rejects.toThrow(
			ErrorKey.AUTH_SESSION_EXPIRED,
		);
	});

	it('rejects a live session whose account is gone', async () => {
		const { strategy } = build({ id: 'session-1', userId: 'user-1' } as Session, null);

		await expect(strategy.validate({ sub: 'user-1', sid: 'session-1' })).rejects.toThrow(
			ErrorKey.AUTH_SESSION_EXPIRED,
		);
	});
});
