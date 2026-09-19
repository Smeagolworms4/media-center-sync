import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * An item that does not count.
 *
 * Specials, recaps, a convention panel a scraper filed as `S00E14`: things a media
 * server lists as episodes and nobody considers part of the show. Left in the count
 * they make a complete season read as incomplete for ever, and a number that is never
 * zero is a number people stop reading.
 *
 * A column of its own although the instruction lives in the `overrides` blob, because
 * this one is read by aggregates — a season's missing count, what a sync plans — and
 * reaching into JSON to decide whether each of thousands of rows counts turns a
 * grouped query into a scan.
 *
 * False for every existing row, which is the honest reading of them: nobody has said
 * otherwise yet.
 */
export class IgnoredItems1758390000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'media_items',
			new TableColumn({
				name: 'ignored',
				type: 'boolean',
				isNullable: false,
				default: false,
			}),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('media_items', 'ignored');
	}
}
