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
import { WorkerPoolService } from '@/services';

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
		/** Asked whether heavy passes are delegated. See `_checkWorker`. */
		private readonly _workers: WorkerPoolService,
	) {}

	@Get()
	@Public()
	@ApiOkResponse({ description: 'Gateway status, its version and its dependency checks.' })
	public async read(@Res({ passthrough: true }) response: Response): Promise<Health> {
		const database = await this._checkDatabase();
		const checks = [database, await this._checkMediaRoot(), this._checkWorker()];
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

	/**
	 * Which journal SQLite is really using, as a suffix for the detail above.
	 *
	 * Asked rather than assumed, and that is the whole reason it is here. WAL is what
	 * lets one writer and many readers share this file — a scan writing while somebody
	 * browses — and it needs shared memory beside the database, which some network
	 * filesystems do not provide. SQLite does not complain on those: it quietly stays on
	 * the default journal, where a writer locks every reader out. The deployment would
	 * look identical and behave nothing alike, so the mode is reported where anybody can
	 * read it instead of being taken on trust.
	 *
	 * Nothing here fails over it. An engine that cannot answer the question — PostgreSQL,
	 * which has no such pragma — simply says nothing.
	 */
	private async _journalMode(): Promise<string> {
		if (this._dataSource.options.type !== 'better-sqlite3') {
			return '';
		}

		try {
			const rows = await this._dataSource.query('PRAGMA journal_mode') as { journal_mode?: string }[];
			const mode = rows[0]?.journal_mode;

			return typeof mode === 'string' ? ` (${mode})` : '';
		} catch {
			return '';
		}
	}

	private async _checkDatabase(): Promise<HealthCheck> {
		try {
			await this._dataSource.query('SELECT 1');

			return {
				name: 'database',
				ok: true,
				detail: `${this._dataSource.options.type}${await this._journalMode()}`,
			};
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
	/**
	 * Whether the long database work runs beside this gateway or inside it.
	 *
	 * Worth a line somebody can read, because the two deployments look identical and
	 * behave nothing alike. `better-sqlite3` is synchronous: a correlation pass over a
	 * real catalogue does not slow this process, it stops it — eight seconds on an API
	 * call, measured on a household's gateway, while a static file from the same proxy
	 * answered in a tenth of one. A worker thread is what removes that, and an image that
	 * shipped without one would go straight back to stalling with nothing saying why.
	 *
	 * Not a failure. The gateway works either way, and inside a worker the honest answer
	 * is "no" — a thread must never spawn a thread.
	 */
	private _checkWorker(): HealthCheck {
		return this._workers.available
			? { name: 'worker', ok: true, detail: 'heavy passes run on a thread of their own' }
			: { name: 'worker', ok: false, detail: 'heavy passes run on the gateway thread and block it' };
	}

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
