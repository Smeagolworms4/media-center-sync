import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { configuration } from '@/config';
import { MIGRATIONS } from './migrations';
import {
	BannedPeer,
	CategoryKeyword,
	Library,
	MediaItem,
	MediaLanding,
	MediaMatch,
	MediaService,
	NotificationChannel,
	Peer,
	PeerInvite,
	ReleaseGrab,
	Revalidation,
	Session,
	Setting,
	SharePolicy,
	SyncJob,
	SyncJobItem,
	SyncPlan,
	Transfer,
	TransferChunk,
	User,
} from '@/entities';
import { applyAsynchronousReads } from './async-reads';
import { CONNECTION_PRAGMAS, WRITER_PRAGMAS } from './pragmas';
import { applyPostgresCompatibility } from './postgres-compat';

/**
 * Every persisted class, listed rather than globbed.
 *
 * `TypeOrmModule.forFeature()` needs the same list, and a glob would also pick up
 * `Timestampable`, which is a base class and not a table.
 */
export const ENTITIES = [
	BannedPeer,
	CategoryKeyword,
	Library,
	MediaItem,
	MediaLanding,
	MediaMatch,
	MediaService,
	NotificationChannel,
	Peer,
	PeerInvite,
	ReleaseGrab,
	Revalidation,
	Session,
	Setting,
	SharePolicy,
	SyncJob,
	SyncJobItem,
	SyncPlan,
	Transfer,
	TransferChunk,
	User,
];

/**
 * Where the migrations are looked up.
 *
 * Both extensions on purpose: the CLI and the tests run the TypeScript sources, the
 * shipped image runs what `nest build` produced.
 */


/**
 * Makes sure the directory holding the SQLite file exists.
 *
 * `better-sqlite3` creates the file but not the directory above it, and the default
 * `var/` is git-ignored — so a fresh clone has no `var/` at all and the very first
 * start dies on `SQLITE_CANTOPEN`, an error that says nothing about a missing folder.
 */
const ensureParentDirectory = (file: string): void => {
	if (file === ':memory:') {
		return;
	}

	mkdirSync(dirname(file), { recursive: true });
};

/**
 * TypeORM options for the configured engine.
 *
 * `synchronize` is false on both engines, always: a schema derived from the entities
 * at startup would silently drop a column the day one is renamed, and the rows with
 * it. The migrations are the only thing allowed to change the schema.
 */
export const dataSourceOptions = (): DataSourceOptions => {
	const config = configuration();
	const common = {
		entities: ENTITIES,
		migrations: MIGRATIONS,
		synchronize: false,
		/*
		 * Migrations run at startup, and for this product that is the right call.
		 *
		 * The alternative is telling somebody who just pulled a container to exec into
		 * it and run a command before it will serve anything — which nobody does, and
		 * which does not survive the first image update either. Measured before this
		 * line existed: a fresh container started, reported itself unhealthy, and died
		 * on `no such table: settings`. The documented quick start did not work.
		 *
		 * `synchronize` stays off, and that distinction is the whole point: the schema
		 * only ever changes through a migration somebody wrote and can read, never by
		 * TypeORM inferring one from the entities at boot.
		 */
		migrationsRun: config.database.migrateOnStart,
		logging: config.env === 'development' ? (['error', 'warn'] as const) : (['error'] as const),
	};

	if (config.database.type === 'postgres') {
		applyPostgresCompatibility();

		return {
			type: 'postgres',
			host: config.database.host,
			port: config.database.port,
			database: config.database.name,
			username: config.database.user,
			password: config.database.password,
			...common,
			logging: [...common.logging],
		};
	}

	// A relative path is resolved against the working directory, which is what an
	// operator writing `DB_FILE=var/gateway.db` in an env file expects. The image
	// passes an absolute path under its data volume and is unaffected. `:memory:` is
	// not a path at all — resolving it would turn the test database into a file.
	const file =
		config.database.file === ':memory:'
			? ':memory:'
			: resolve(process.cwd(), config.database.file);

	ensureParentDirectory(file);

	// Only on this engine, and before the first statement: PostgreSQL's driver is
	// already asynchronous, and this one is not asynchronous at all until it is told.
	applyAsynchronousReads();

	return {
		type: 'better-sqlite3',
		database: file,
		/*
		 * Write-ahead logging, and a writer somebody is willing to wait for.
		 *
		 * SQLite's default journal is `delete`, where a writer takes an exclusive lock on
		 * the whole file and every reader waits behind it. That is tolerable while one
		 * thread owns the connection and it is the state this product shipped in — but it
		 * makes a second connection actively harmful: a scan writing from a worker would
		 * answer `SQLITE_BUSY` to every read the interface makes, which trades a gateway
		 * that stalls for a gateway that errors.
		 *
		 * WAL gives one writer and any number of concurrent readers, which is the shape
		 * this product actually has: one scan writing, a person browsing. It is the thing
		 * that has to be true before any of the scan moves off this thread.
		 *
		 * Everything else this connection sets is in `pragmas.ts`, beside the two other
		 * connections that set the same things — including the ones that exist to stop a
		 * Raspberry Pi writing its SD card to death.
		 *
		 * The mode is read back rather than assumed. WAL needs shared memory beside the
		 * file and silently stays `delete` on filesystems that cannot provide it, NFS and
		 * some SMB mounts among them — exactly where a household's data volume might sit.
		 * Being told is the difference between knowing the deployment is safe for a second
		 * connection and believing it.
		 */
		prepareDatabase: (db: {
			pragma: (source: string) => unknown;
		}) => {
			if (file === ':memory:') {
				return;
			}

			db.pragma('journal_mode = WAL');

			for (const pragma of [...CONNECTION_PRAGMAS, ...WRITER_PRAGMAS]) {
				db.pragma(pragma);
			}
		},
		...common,
		logging: [...common.logging],
	};
};

/**
 * The instance the TypeORM CLI loads. The application itself gets its connection
 * from `TypeOrmModule.forRoot()`, which is handed the same options.
 */
export default new DataSource(dataSourceOptions());
