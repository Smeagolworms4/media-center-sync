import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ENTITIES } from '@/database/data-source';

const run = async (): Promise<void> => {
	const ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: ENTITIES, synchronize: false });
	await ds.initialize();
	for (const meta of ds.entityMetadatas) {
		for (const fk of meta.foreignKeys) {
			console.log(meta.tableName, '|', fk.name, '|', fk.columns.map((c) => c.databaseName).join(','), '->', fk.referencedEntityMetadata.tableName, '(' + fk.referencedColumns.map((c) => c.databaseName).join(',') + ')', '| onDelete=' + fk.onDelete, '| onUpdate=' + fk.onUpdate);
		}
	}
	await ds.destroy();
};

void run();
