import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ENTITIES } from '@/database/data-source';
import { InitialSchema1758240000000 } from '@/database/migrations/1758240000000-InitialSchema';

const run = async (): Promise<void> => {
	const ds = new DataSource({
		type: 'better-sqlite3',
		database: ':memory:',
		entities: ENTITIES,
		migrations: [InitialSchema1758240000000],
		synchronize: false,
	});
	await ds.initialize();
	await ds.runMigrations();
	const tables = await ds.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
	console.log('TABLES:', tables.map((t: { name: string }) => t.name).join(', '));
	const idx = await ds.query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name");
	console.log('INDEXES:', idx.length);
	// Insert a row through the ORM to prove the identifiers and defaults work.
	const user = await ds.getRepository('users').save({ username: 'admin', role: 'admin' });
	console.log('INSERTED', JSON.stringify(user));
	console.log('--- drift after migration ---');
	const log = await ds.driver.createSchemaBuilder().log();
	for (const q of log.upQueries) console.log('  ', q.query);
	console.log('drift queries:', log.upQueries.length);
	await ds.undoLastMigration();
	const after = await ds.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
	console.log('AFTER DOWN:', after.map((t: { name: string }) => t.name).join(', '));
	await ds.destroy();
};

void run();
