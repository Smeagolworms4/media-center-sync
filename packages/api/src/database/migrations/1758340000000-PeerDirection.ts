import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Which side asked for a link.
 *
 * Linking no longer happens only through an invitation code. A peer can now be added
 * by fingerprint, which means a gateway can receive a request it did not initiate —
 * and an interface that shows both as simply "pending" gives somebody no way to tell
 * a request waiting on their friend from one waiting on them.
 *
 * Nullable, and null for every existing row: the peers linked before this column
 * existed are settled, and settled links have no direction to record.
 */
export class PeerDirection1758340000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'peers',
			new TableColumn({ name: 'direction', type: 'varchar', isNullable: true }),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('peers', 'direction');
	}
}
