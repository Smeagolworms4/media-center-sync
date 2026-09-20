import { TableColumn, TableIndex, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Which step of the placement rule chose where a file went.
 *
 * The rule has seven steps and three of them mean nobody chose: the global
 * destination library, the fallback folder, and whatever happened to be writable. A
 * file that lands on one of those is not lost and its transfer did not fail, so
 * nothing anywhere says a word — the library simply grows a folder somebody did not
 * plan, and it is found months later. Recording the step is the only thing that makes
 * those rows findable, and the interface reads them through `UNCONFIGURED_PLACEMENTS`
 * rather than by comparing values one at a time.
 *
 * Nullable rather than defaulted, on both tables. A row written before this migration
 * was placed by a rule nobody recorded, and giving it a value would be inventing one:
 * a dashboard would then either list every historical transfer as a problem or claim
 * every one of them was fine. Null means "not known", and the screens skip it.
 *
 * `targetLibraryId` on the transfer is the other half of the same answer. The path
 * alone cannot be turned back into a library — two libraries can nest, and a fallback
 * folder belongs to none of them — so without it nothing can name where a file went or
 * offer to move it somewhere else. The sync job line already had the column.
 */
export class PlacementProvenance1758440000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'transfers',
			new TableColumn({ name: 'targetLibraryId', type: 'varchar', isNullable: true }),
		);
		await queryRunner.addColumn(
			'transfers',
			new TableColumn({ name: 'placedBy', type: 'varchar', isNullable: true }),
		);

		// The dashboard's only query is "which transfers landed on a step nobody
		// configured", over a table that grows by one row per pulled file forever. Left
		// unindexed it is a full scan on every page load of the home screen.
		await queryRunner.createIndex(
			'transfers',
			new TableIndex({ name: 'IDX_transfers_placedBy', columnNames: ['placedBy'] }),
		);

		await queryRunner.addColumn(
			'sync_job_items',
			new TableColumn({ name: 'placedBy', type: 'varchar', isNullable: true }),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('sync_job_items', 'placedBy');
		await queryRunner.dropIndex('transfers', 'IDX_transfers_placedBy');
		await queryRunner.dropColumn('transfers', 'placedBy');
		await queryRunner.dropColumn('transfers', 'targetLibraryId');
	}
}
