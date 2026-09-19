import 'reflect-metadata';
import { hash } from 'bcryptjs';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@mcs/shared';
import type { SecurityConfig } from '@/config';
import { SettingRepository, UserRepository } from '@/repositories';
import { DEFAULT_SETTINGS } from '@/services/settings.service';
import { runCommand } from './context';

/**
 * Installs what a gateway needs to be opened for the first time.
 *
 * Idempotent, because `make init` runs it on every setup and a CI pipeline runs it on
 * a database that may already be seeded. In particular it never rewrites the
 * administrator's password: doing so would silently reset the credentials of a
 * running installation the next time somebody re-ran the target.
 */
runCommand(async (app) => {
	const users = app.get(UserRepository);
	const settings = app.get(SettingRepository);
	const config = app.get(ConfigService);

	const username = process.env.MCS_ADMIN_USER ?? 'admin';
	const password = process.env.MCS_ADMIN_PASSWORD ?? 'admin';
	const existing = await users.findByUsername(username);

	if (existing === null) {
		await users.save(
			users.create({
				username,
				displayName: 'Administrator',
				role: UserRole.ADMIN,
				provider: 'internal',
				passwordHash: await hash(
					password,
					config.getOrThrow<SecurityConfig>('security').bcryptRounds,
				),
			}),
		);

		process.stdout.write(`Created the internal administrator "${username}".\n`);
	} else {
		process.stdout.write(`Administrator "${username}" already exists, left untouched.\n`);
	}

	// Only the keys that have no row yet. The settings table is sparse on purpose —
	// a key nobody changed has no row — so writing every default would turn each one
	// into an explicit choice and hide, forever, which ones the operator really made.
	const stored = await settings.findAllAsMap();
	const missing = Object.entries(DEFAULT_SETTINGS).filter(([key]) => !stored.has(key));

	await settings.putMany(
		Object.fromEntries(missing.map(([key, value]) => [key, JSON.stringify(value)])),
	);

	process.stdout.write(
		missing.length === 0
			? 'Settings already present, nothing written.\n'
			: `Wrote ${missing.length} default settings.\n`,
	);
});
