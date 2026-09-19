import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * What sits beside a media file: the `.nfo`, the poster, the subtitles.
 *
 * A nullable column rather than a default of `{}`, because "never inspected" and
 * "inspected and found nothing" are different answers and the interface acts on the
 * difference — one asks for a scan, the other offers to fetch the companions. A
 * default would erase that distinction on every existing row, silently and
 * irreversibly.
 *
 * `text`, like every other JSON column here: it is the only spelling SQLite and
 * PostgreSQL both accept through the same migration.
 */
export class MediaCompanions1758330000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'media_items',
			new TableColumn({ name: 'companions', type: 'text', isNullable: true }),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('media_items', 'companions');
	}
}
