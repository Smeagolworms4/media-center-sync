import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Local naming, local filing, and a name to recognise ourselves by.
 *
 * `libraries.alias` and `libraries.position` make a category something the gateway
 * owns rather than something it inherits: a friend's `Video2` can be called what it
 * is here, and the same media filed in two categories belongs to whichever comes
 * first — an answer that otherwise depended on the order rows came back in.
 *
 * `media_items.libraryOverrideId` is the same idea for one item. A media server files
 * by the folder it found something in and is sometimes wrong; correcting it there
 * means moving files, correcting it here is a column a rescan does not undo.
 *
 * `peers.nodeId` exists to stop announcements circling. A friend of a friend
 * propagates what it hears, so without a name to recognise itself by a gateway
 * receives its own catalogue back through a third party and answers it.
 *
 * Every column is nullable or defaulted: existing rows mean "no alias", "no override"
 * and "learned at the next handshake", all of which are true of them.
 */
export class CategoriesAndIdentity1758360000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumns('libraries', [
			new TableColumn({ name: 'alias', type: 'varchar', isNullable: true }),
			new TableColumn({ name: 'position', type: 'integer', isNullable: false, default: 100 }),
		]);

		await queryRunner.addColumn(
			'media_items',
			new TableColumn({ name: 'libraryOverrideId', type: 'varchar', isNullable: true }),
		);

		await queryRunner.addColumn(
			'peers',
			new TableColumn({ name: 'nodeId', type: 'varchar', isNullable: true }),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('peers', 'nodeId');
		await queryRunner.dropColumn('media_items', 'libraryOverrideId');
		await queryRunner.dropColumns('libraries', ['alias', 'position']);
	}
}
