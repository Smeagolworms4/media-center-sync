import { Module, type Type } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { SignOptions } from 'jsonwebtoken';
import { configuration, type SecurityConfig } from '@/config';
import * as controllers from '@/controllers';
import { ENTITIES, dataSourceOptions } from '@/database';
import * as managers from '@/managers';
import * as repositories from '@/repositories';
import * as security from '@/security';
import * as services from '@/services';

/**
 * The classes exported by a barrel, and only the classes.
 *
 * Barrels export providers next to plain helpers — `rightsForRole`, `configuration`,
 * a decorator factory. Handing one of those to `providers` fails at startup with a
 * message about an undefined metatype that names neither the function nor the barrel
 * it came from, so the filter is worth more than it looks.
 */
const injectables = (barrel: Record<string, unknown>): Type[] =>
	Object.values(barrel).filter(
		(value): value is Type => typeof value === 'function' && /^class\s/.test(value.toString()),
	);

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
		TypeOrmModule.forRoot(dataSourceOptions()),
		TypeOrmModule.forFeature(ENTITIES),
		ScheduleModule.forRoot(),
		PassportModule,
		JwtModule.registerAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService) => {
				const options = config.getOrThrow<SecurityConfig>('security');

				// `expiresIn` is typed as a template-literal union of duration strings,
				// which a value read from the environment can never narrow to. The cast
				// is the shape of the value, not a claim about it: an unparsable
				// duration still fails on the first token signed.
				return {
					secret: options.jwtSecret,
					signOptions: { expiresIn: options.accessTtl as SignOptions['expiresIn'] },
				};
			},
		}),
		// Handlers register themselves with a decorator and are found by walking the
		// container with `DiscoveryService`. Without this module there is nothing to
		// walk: no error, no warning — the handlers simply never appear, and every
		// service registration fails with "unknown handler" for a reason nothing states.
		DiscoveryModule,
	],
	controllers: injectables(controllers),
	providers: [
		...injectables(repositories),
		...injectables(services),
		...injectables(managers),
		...injectables(security),
		// Global, so that a route is covered by having been written rather than by
		// somebody remembering to decorate it. Both guards let through what is not
		// theirs: the rights guard ignores peer routes, the peer guard ignores
		// everything else.
		{ provide: APP_GUARD, useClass: security.RightsGuard },
		{ provide: APP_GUARD, useClass: security.PeerGuard },
	],
})
export class AppModule {}
