import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { configuration } from '@/config';
import { MIGRATIONS } from './migrations';
import {
	Library,
	MediaItem,
	MediaMatch,
	MediaService,
	Peer,
	PeerInvite,
	Revalidation,
	Session,
	Setting,
	SharePolicy,
	SyncJob,
	SyncPlan,
	Transfer,
	TransferChunk,
	User,
} from '@/entities';
import { applyPostgresCompatibility } from './postgres-compat';

/**
 * Every persisted class, listed rather than globbed.
 *
 * `TypeOrmModule.forFeature()` needs the same list, and a glob would also pick up
 * `Timestampable`, which is a base class and not a table.
 */
export const ENTITIES = [
	Library,
	MediaItem,
	MediaMatch,
	MediaService,
	Peer,
	PeerInvite,
	Revalidation,
	Session,
	Setting,
	SharePolicy,
	SyncJob,
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
		migrationsRun: false,
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

	return {
		type: 'better-sqlite3',
		database: file,
		...common,
		logging: [...common.logging],
	};
};

/**
 * The instance the TypeORM CLI loads. The application itself gets its connection
 * from `TypeOrmModule.forRoot()`, which is handed the same options.
 */
export default new DataSource(dataSourceOptions());
