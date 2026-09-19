import type { DataSource } from 'typeorm';
import { UserRole } from '@mcs/shared';
import type { User } from '@/entities';
import { createTestDataSource } from '../../test/utils/database';
import { SessionRepository } from './session.repository';
import { UserRepository } from './user.repository';

describe('SessionRepository', () => {
	let dataSource: DataSource;
	let sessions: SessionRepository;
	let users: UserRepository;
	let user: User;

	beforeEach(async () => {
		dataSource = await createTestDataSource();
		sessions = new SessionRepository(dataSource);
		users = new UserRepository(dataSource);
		user = await users.save(
			users.create({ username: 'ada', role: UserRole.ADMIN, provider: 'internal' }),
		);
	});

	afterEach(async () => {
		await dataSource.destroy();
	});

	const aSession = async (overrides: Partial<{ revokedAt: Date | null; expiresAt: Date }> = {}) =>
		sessions.save(
			sessions.create({
				userId: user.id,
				refreshTokenHash: `hash-${Math.random()}`,
				expiresAt: new Date(Date.now() + 3_600_000),
				revokedAt: null,
				...overrides,
			}),
		);

	it('finds a session that is still usable', async () => {
		const session = await aSession();

		await expect(sessions.findValidByHash(session.refreshTokenHash)).resolves.toMatchObject({
			id: session.id,
		});
	});

	it('does not find a revoked session, although its hash still matches', async () => {
		const session = await aSession({ revokedAt: new Date() });

		await expect(sessions.findValidByHash(session.refreshTokenHash)).resolves.toBeNull();
	});

	it('does not find an expired session', async () => {
		const session = await aSession({ expiresAt: new Date(Date.now() - 1_000) });

		await expect(sessions.findValidByHash(session.refreshTokenHash)).resolves.toBeNull();
	});

	it('finds a live session by its identifier, which is what an access token carries', async () => {
		const session = await aSession();

		await expect(sessions.findValidById(session.id)).resolves.toMatchObject({ id: session.id });

		await sessions.revoke(session.id);

		await expect(sessions.findValidById(session.id)).resolves.toBeNull();
	});

	it('revokes every session of a user at once, and leaves other users alone', async () => {
		const other = await users.save(
			users.create({ username: 'grace', role: UserRole.USER, provider: 'internal' }),
		);
		const otherSession = await sessions.save(
			sessions.create({
				userId: other.id,
				refreshTokenHash: 'other',
				expiresAt: new Date(Date.now() + 3_600_000),
			}),
		);

		await aSession();
		await aSession();

		await expect(sessions.revokeAllForUser(user.id)).resolves.toBe(2);
		await expect(sessions.findValidById(otherSession.id)).resolves.not.toBeNull();
	});

	it('counts a second revocation as nothing, so it can be called twice', async () => {
		await aSession();
		await sessions.revokeAllForUser(user.id);

		await expect(sessions.revokeAllForUser(user.id)).resolves.toBe(0);
	});

	it('deletes expired rows and keeps the live ones', async () => {
		await aSession({ expiresAt: new Date(Date.now() - 1_000) });
		const live = await aSession();

		await expect(sessions.deleteExpired()).resolves.toBe(1);
		await expect(sessions.findValidById(live.id)).resolves.not.toBeNull();
	});
});
