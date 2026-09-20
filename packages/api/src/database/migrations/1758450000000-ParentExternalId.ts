import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * The parent an item names inside its own service, kept on the row.
 *
 * Until this column existed the only record of a parent was `parentId`, resolved at
 * the moment the child was written by looking the parent up among the rows already
 * stored. That made the tree a function of enumeration order, and no media server
 * offers an order that puts a parent first: Jellyfin pages by `SortName` because
 * index paging is only stable under a stable sort, and alphabetically `Season 1`
 * comes before `The Expanse`. The season was therefore written while its series did
 * not exist yet, landed with a null parent, and appeared at the root of the library
 * screen beside the show it belongs to. It was erratic for the same reason:
 * `Cowboy Bebop` sorts before its seasons and worked.
 *
 * Nothing could repair those rows afterwards, because the one fact that names the
 * missing parent — the external identifier the child reported — was thrown away
 * after the failed lookup. Keeping it is what lets the link be derived from the row
 * rather than from when the row arrived.
 *
 * Nullable and not backfilled. A row written before this migration genuinely carries
 * no such fact, and inventing one from the title would file episodes under the wrong
 * show. The first full scan after this release writes the column for every row it
 * sees and the reconciliation pass links them in the same run, so an existing install
 * heals itself at the next scan rather than through a data migration that would have
 * to guess.
 *
 * No index: every query that reads this column also pins `serviceId`, and the lookup
 * it drives is `(serviceId, externalId)` on the parent side, which the unique index
 * from the initial schema already covers.
 */
export class ParentExternalId1758450000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'media_items',
			new TableColumn({ name: 'parentExternalId', type: 'varchar', isNullable: true }),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('media_items', 'parentExternalId');
	}
}
