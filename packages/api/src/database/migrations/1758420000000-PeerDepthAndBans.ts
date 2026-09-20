import { Table, TableColumn, TableIndex, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * How far a peer is, how far they may introduce, and who is refused for good.
 *
 * Three things that were previously one boolean between them. Whether friends of
 * friends were allowed was a yes/no over the whole gateway, which could express "one
 * hop" or "as far as the network happens to reach" and meant the second in practice:
 * there was no number to stop at. `depth` records what an arriving peer actually is,
 * `maxDepth` lets one friend's circle be widened without widening everybody's, and
 * the ceiling itself moves to a setting.
 *
 * Existing peers get depth 1. That is true of every row that can exist today: without
 * a depth to compare against, nothing was ever adopted past the first hop.
 *
 * `banned_peers` is the durable half of ejecting somebody. Blocking sets a status on
 * a row we keep; removing deleted the row, and with it the only thing refusing them,
 * so the next request from the same key arrived as a fresh introduction. It is keyed
 * by fingerprint because that is the part that survives a rebuilt gateway, a new
 * address and a renamed node.
 */
export class PeerDepthAndBans1758420000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'peers',
			new TableColumn({ name: 'depth', type: 'int', isNullable: false, default: 1 }),
		);
		await queryRunner.addColumn(
			'peers',
			new TableColumn({ name: 'maxDepth', type: 'int', isNullable: true }),
		);

		await queryRunner.createTable(
			new Table({
				name: 'banned_peers',
				columns: [
					{ name: 'id', type: 'varchar', length: '36', isPrimary: true },
					{ name: 'fingerprint', type: 'varchar', isNullable: false },
					{ name: 'name', type: 'varchar', isNullable: true },
					{ name: 'reason', type: 'varchar', length: '500', isNullable: true },
					{ name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
					{ name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
				],
			}),
			true,
		);

		// Unique, because a fingerprint is either refused or it is not. Without it a
		// second ban on the same key would succeed and the list would show the same
		// person twice, with two different reasons and no way to tell which applied.
		await queryRunner.createIndex(
			'banned_peers',
			new TableIndex({
				name: 'IDX_banned_peers_fingerprint',
				columnNames: ['fingerprint'],
				isUnique: true,
			}),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropTable('banned_peers', true);
		await queryRunner.dropColumn('peers', 'maxDepth');
		await queryRunner.dropColumn('peers', 'depth');
	}
}
