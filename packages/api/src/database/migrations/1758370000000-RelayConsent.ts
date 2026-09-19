import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Agreement to pass on a library that is not ours.
 *
 * Sharing a library on one of our own services gives away our own bytes off our own
 * disk. Sharing one on a remote service — a friend's gateway, a Jellyfin we merely
 * have an account on — makes us the conduit: our bandwidth, and an access granted to
 * us rather than to the people we would be handing it to.
 *
 * It is a useful thing to do on purpose and never a thing to do by accident, so it is
 * stored as consent rather than inferred from the library. Defaulted to false, which
 * makes every policy that already exists mean what its author meant when they wrote
 * it: share what is mine.
 */
export class RelayConsent1758370000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'share_policies',
			new TableColumn({ name: 'relay', type: 'boolean', isNullable: false, default: false }),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('share_policies', 'relay');
	}
}
