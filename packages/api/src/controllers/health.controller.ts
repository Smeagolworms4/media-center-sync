import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import type { Health, HealthCheck } from '@mcs/shared';
import type { MediaConfig } from '@/config';
import { Public } from '@/decorators';

/**
 * What the container healthcheck and the status screen read.
 *
 * It runs a real query instead of answering 200 because a process that is up is not
 * the same thing as a gateway that works: a database file that lost its mount leaves
 * the server standing, the routes answering, and every single one of them failing.
 * Docker restarts this container on what this endpoint says, so it has to be able to
 * say no — hence the 503 below rather than a 200 carrying `ok: false`, which every
 * orchestrator would read as healthy.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
	public constructor(
		@InjectDataSource()
		private readonly _dataSource: DataSource,
		private readonly _config: ConfigService,
	) {}

	@Get()
	@Public()
	@ApiOkResponse({ description: 'Gateway status, its version and its dependency checks.' })
	public async read(@Res({ passthrough: true }) response: Response): Promise<Health> {
		const database = await this._checkDatabase();
		const checks = [database, await this._checkMediaRoot()];
		// Only the database decides. An unreadable media root is worth reporting and
		// worth fixing, but restarting the container over it would take away the one
		// interface somebody could have used to see what is wrong.
		const ok = database.ok;

		response.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

		return {
			ok,
			version: this._config.get<string>('version') ?? 'dev',
			uptimeSeconds: Math.floor(process.uptime()),
			checks,
		};
	}

	private async _checkDatabase(): Promise<HealthCheck> {
		try {
			await this._dataSource.query('SELECT 1');

			return { name: 'database', ok: true, detail: this._dataSource.options.type };
		} catch (error) {
			return { name: 'database', ok: false, detail: (error as Error).message };
		}
	}

	/**
	 * The libraries have to be readable, and a missing mount is the usual cause.
	 *
	 * Reported as a check rather than as a failure of the whole gateway: the API is
	 * still worth answering — somebody has to be able to open the interface and see
	 * what is wrong.
	 */
	private async _checkMediaRoot(): Promise<HealthCheck> {
		const root = this._config.getOrThrow<MediaConfig>('media').root;

		try {
			await access(root, constants.R_OK);

			return { name: 'media-root', ok: true, detail: root };
		} catch {
			return { name: 'media-root', ok: false, detail: `${root} is not readable` };
		}
	}
}
