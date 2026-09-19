import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * What version a peer speaks, and what it said it can do.
 *
 * Both nullable-or-empty by default, and that is the honest reading of an existing
 * row: a peer recorded before this column existed has never completed a versioned
 * handshake, so we do not know its version. Defaulting it to the current one would
 * assert something nobody measured, and the first feature offered on the strength of
 * it would fail at the far end.
 */
export class PeerProtocol1758380000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'peers',
			new TableColumn({ name: 'protocol', type: 'int', isNullable: true }),
		);
		await queryRunner.addColumn(
			'peers',
			new TableColumn({
				name: 'capabilities',
				type: 'text',
				isNullable: false,
				default: "'[]'",
			}),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('peers', 'capabilities');
		await queryRunner.dropColumn('peers', 'protocol');
	}
}
