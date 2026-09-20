import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Where a service's own root is, for us.
 *
 * A media server reports `/media/Shows/…` and this gateway sees `/mnt/nas/Shows/…`.
 * Until now that had to be spelled out on every library, so a server with six
 * libraries was six paths to type — and a library whose two paths do not designate
 * the same directory accepts transfers the media server will never see, with nothing
 * anywhere reporting an error.
 *
 * Both null for every existing row, which is the honest reading of them: nobody has
 * stated a mapping, so nothing is derived and the per-library paths already set keep
 * working exactly as they did.
 */
export class ServiceRootMapping1758410000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'media_services',
			new TableColumn({ name: 'remoteRoot', type: 'varchar', length: '1024', isNullable: true }),
		);
		await queryRunner.addColumn(
			'media_services',
			new TableColumn({ name: 'localRoot', type: 'varchar', length: '1024', isNullable: true }),
		);
		// False for every existing row, which keeps every path already typed explicit
		// and therefore untouched by the mapping. Defaulting it the other way would
		// hand the first probe permission to overwrite all of them.
		await queryRunner.addColumn(
			'libraries',
			new TableColumn({
				name: 'localPathDerived',
				type: 'boolean',
				isNullable: false,
				default: false,
			}),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropColumn('libraries', 'localPathDerived');
		await queryRunner.dropColumn('media_services', 'localRoot');
		await queryRunner.dropColumn('media_services', 'remoteRoot');
	}
}
