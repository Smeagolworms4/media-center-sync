import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { UserRole } from '@mcs/shared';
import { createApp } from '@/bootstrap';
import { SessionRepository, UserRepository } from '@/repositories';
import type { Session, User } from '@/entities';

export interface TestApp {
	app: NestExpressApplication;
	dataSource: DataSource;
	close(): Promise<void>;
}

export interface TestIdentity {
	user: User;
	session: Session;
	/** Ready for `Authorization: Bearer …`. */
	token: string;
}

/**
 * The real application, over a throwaway database.
 *
 * It goes through `createApp()` — the same function `main.ts` calls — so the guards,
 * the validation pipe and the serialisation interceptor are the ones production runs.
 * A test that assembled its own module would pass while the shipped application
 * leaked a password hash, because the interceptor that hides it is wiring and not
 * controller code.
 */
export const createTestApp = async (): Promise<TestApp> => {
	const app = await createApp();
	const dataSource = app.get<DataSource>(getDataSourceToken());

	// Before `init()`, and that order matters. The schema is not created by the
	// connection — `synchronize` is off everywhere — while `init()` is what runs
	// `onModuleInit`, where services read their settings. Migrating afterwards would
	// have them query tables that do not exist yet.
	await dataSource.runMigrations();

	await app.init();

	return {
		app,
		dataSource,
		close: async (): Promise<void> => {
			await app.close();
		},
	};
};

/**
 * An account with a live session, and the bearer token that goes with it.
 *
 * Written against the repositories rather than through the sign-in route on purpose:
 * a test about transfers should not fail because the authentication flow changed
 * shape, and this keeps working while that route is still being written.
 */
export const signInAs = async (
	context: TestApp,
	role: UserRole = UserRole.ADMIN,
): Promise<TestIdentity> => {
	const users = context.app.get(UserRepository);
	const sessions = context.app.get(SessionRepository);
	const jwt = context.app.get(JwtService);

	const user = await users.save(
		users.create({
			username: `test-${role}-${randomUUID().slice(0, 8)}`,
			role,
			provider: 'internal',
		}),
	);

	const session = await sessions.save(
		sessions.create({
			userId: user.id,
			refreshTokenHash: randomUUID(),
			expiresAt: new Date(Date.now() + 3_600_000),
		}),
	);

	return { user, session, token: jwt.sign({ sub: user.id, sid: session.id }) };
};
