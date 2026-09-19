import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Local naming, local filing, and a name to recognise ourselves by.
 *
 * `libraries.alias` and `libraries.position` make a category something the gateway
 * owns rather than something it inherits: a friend's `Video2` can be called what it
 * is here, and the same media filed in two categories belongs to whichever comes
 * first — an answer that otherwise depended on the order rows came back in.
 *
 * `media_items.overrides` and `media_items.reported` are the same idea for one item,
 * and for every field of it. A media server gets things wrong — a documentary filed
 * under Films, an anime numbered by absolute order, a show under a name nobody here
 * uses — and correcting it there means moving files and fighting the next scrape. The
 * columns keep the effective values so the correction reaches correlation and filing;
 * `overrides` is what a person asked for, so a rescan re-applies it rather than
 * overwriting it; `reported` is the service's last word, so the change can be shown
 * and undone.
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

		await queryRunner.addColumns('media_items', [
			new TableColumn({ name: 'overrides', type: 'text', isNullable: true }),
			new TableColumn({ name: 'reported', type: 'text', isNullable: true }),
		]);

		await queryRunner.addColumn(
			'peers',
			new TableColumn({ name: 'nodeId', type: 'varchar', isNullable: true }),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('peers', 'nodeId');
		await queryRunner.dropColumns('media_items', ['overrides', 'reported']);
		await queryRunner.dropColumns('libraries', ['alias', 'position']);
	}
}
