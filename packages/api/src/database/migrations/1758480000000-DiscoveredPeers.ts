import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * A peer met while pulling from a friend of a friend, which may be temporary.
 *
 * Pulling something a friend's friend holds no longer goes through the friend in the
 * middle: they hand out a signed introduction and the two ends open a link to each
 * other. That link needs a peer row — the session map, the share policies and every
 * peer-facing route are keyed by one — and most of those rows are not meant to last
 * beyond the transfer.
 *
 * The flag is on the row rather than kept in memory because what has to survive a
 * crash is the undoing. A gateway killed mid-transfer would otherwise come back with a
 * peer nobody invited, redialled at every restart, and nothing anywhere able to say
 * where it came from; with the column, the sweep at boot knows exactly which rows to
 * drop.
 *
 * Existing rows are false, which is the truth about them: every peer already stored
 * was invited, accepted or introduced back when being introduced meant becoming a
 * permanent peer. `down` drops the column, and with it the distinction — the rows that
 * were temporary become ordinary peers rather than disappearing, because deleting
 * somebody's peers on a rollback is not a thing a migration should do.
 */
export class DiscoveredPeers1758480000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'peers',
			new TableColumn({
				name: 'discovered',
				type: 'boolean',
				isNullable: false,
				default: false,
			}),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('peers', 'discovered');
	}
}
