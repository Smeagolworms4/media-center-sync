import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * A library is either shared or it is not.
 *
 * `metadataOnly` let a peer see the titles and refused them the files. It reads as a
 * middle ground and is not one: seeing something you cannot have is not a feature, and
 * anybody who does not want to serve a library simply does not share it. Keeping the
 * setting meant every screen, every filter and every serving path carried a case that
 * existed to disappoint somebody.
 *
 * Dropping a column is irreversible in the sense that matters — the flags are gone —
 * so `down` recreates it defaulted to false, which is what every row meant in practice.
 */
export class DropCatalogueOnly1758350000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('share_policies', 'metadataOnly');
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'share_policies',
			new TableColumn({
				name: 'metadataOnly',
				type: 'boolean',
				isNullable: false,
				default: false,
			}),
		);
	}
}
