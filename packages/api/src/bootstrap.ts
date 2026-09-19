import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from '@/app.module';
import type { AppConfig } from '@/config';

/**
 * Builds the application, configured, but not listening.
 *
 * Separate from `main.ts` so the functional tests get exactly the application the
 * image runs — pipes, guards, interceptor and all. A test suite that assembles its
 * own application proves that the controllers work and says nothing about the one
 * people will actually talk to.
 */
export const createApp = async (): Promise<NestExpressApplication> => {
	const app = await NestFactory.create<NestExpressApplication>(AppModule);
	const config = app.get(ConfigService);
	const prefix = config.getOrThrow<string>('prefix');
	const corsOrigins = config.getOrThrow<AppConfig['corsOrigins']>('corsOrigins');
	const staticRoot = config.get<string>('staticRoot') ?? '';

	app.setGlobalPrefix(prefix);

	// Lets `onModuleDestroy` run: without it a SIGTERM kills the process with
	// transfers holding open file handles and a database mid-write.
	app.enableShutdownHooks();

	app.use(
		helmet({
			// The API answers JSON and the interface is static files served below. A
			// content security policy here would only describe pages this process does
			// not generate, and its default one breaks the Swagger page.
			contentSecurityPolicy: false,
		}),
	);

	// Same origin in the shipped image — the interface is served from here — so an
	// empty list means no cross-origin caller is expected. The development stack sets
	// the list explicitly.
	app.enableCors({
		origin: corsOrigins.length > 0 ? corsOrigins : false,
		credentials: true,
	});

	app.useGlobalPipes(
		new ValidationPipe({
			// `whitelist` drops what the DTO does not declare and `forbidNonWhitelisted`
			// answers 400 instead of dropping it quietly. Together they are what stops a
			// request body from carrying `role: "admin"` into an update that was only
			// ever meant to change a display name: without them the extra property
			// reaches the entity, and nothing in the code reads as if it could.
			whitelist: true,
			forbidNonWhitelisted: true,
			// Bodies and query strings arrive as strings. Without this a numeric DTO
			// field is validated as the string it still is, and every comparison
			// downstream is made against text.
			transform: true,
			transformOptions: { enableImplicitConversion: true },
		}),
	);

	// Without this interceptor `@Exclude()` does nothing at all. Password hashes and
	// media service tokens are excluded on the entities, and they are excluded there
	// precisely because entities are returned directly — so removing this line puts
	// them in responses, silently, with nothing failing anywhere.
	app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

	if (config.getOrThrow<AppConfig['docs']>('docs').enabled) {
		const document = SwaggerModule.createDocument(
			app,
			new DocumentBuilder()
				.setTitle('Media Center Sync')
				.setDescription('Sync gateway between media services — local and remote, peer to peer')
				.setVersion(config.get<string>('version') ?? 'dev')
				.addBearerAuth()
				.build(),
		);

		SwaggerModule.setup(`${prefix}/docs`, app, document);
	}

	if (staticRoot !== '') {
		mountInterface(app, staticRoot, prefix);
	}

	return app;
};

/**
 * Serves the built interface from the same process.
 *
 * The production image is one container: no reverse proxy, no second web server.
 * Anything that is not under the API prefix and is not a file on disk is answered
 * with `index.html`, because the interface routes in the browser — opening
 * `/transfers` directly would otherwise be a 404 from a server that has never heard
 * of that path.
 */
const mountInterface = (app: NestExpressApplication, staticRoot: string, prefix: string): void => {
	const root = resolve(staticRoot);
	const index = join(root, 'index.html');

	app.useStaticAssets(root, { index: false });

	app.use((request: Request, response: Response, next: NextFunction): void => {
		if (request.method !== 'GET' || request.path.startsWith(`/${prefix}`) || !existsSync(index)) {
			next();

			return;
		}

		response.sendFile(index);
	});
};
