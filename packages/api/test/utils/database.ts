import { DataSource } from 'typeorm';
import { ENTITIES } from '@/database';
import { MIGRATIONS } from '@/database/migrations';

/**
 * A throwaway database with the real schema.
 *
 * Built by running the migration rather than by `synchronize: true`, so a repository
 * test also proves the migration produces a schema the entities can be used against.
 * A schema derived from the entities would agree with them by construction and could
 * never catch the one mistake that matters here.
 */
export const createTestDataSource = async (): Promise<DataSource> => {
	const dataSource = new DataSource({
		type: 'better-sqlite3',
		database: ':memory:',
		entities: ENTITIES,
		migrations: MIGRATIONS,
		synchronize: false,
	});

	await dataSource.initialize();
	await dataSource.runMigrations();

	return dataSource;
};
