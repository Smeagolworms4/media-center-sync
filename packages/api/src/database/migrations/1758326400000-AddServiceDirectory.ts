import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * Three columns on `media_services`, for servers found through a directory — plex.tv.
 *
 * The first migration written after a release, and it follows the rule
 * `InitialSchema` states on its way out: that file is never touched again, because
 * gateways running 0.1.0 and 0.1.1 hold real rows in it. Everything here is additive
 * and nullable, so a row written by an older version reads as what it is — a service
 * somebody registered by address, which no directory knows — and nothing has to be
 * back-filled.
 *
 * - `serverIdentifier`: the server's permanent identity at its directory, which is
 *   what a re-resolution looks it up by when the stored address stops answering.
 * - `accountToken`: the directory account token that re-resolution asks with. Read
 *   only through `findWithSecrets`, like the other credential columns.
 * - `connectionRoute`: whether the stored address is local, remote or the relay.
 *
 * Built from `TableColumn` objects so the driver renders each engine's dialect, and
 * `varchar` because it is the one type both engines spell the same way.
 */
export class AddServiceDirectory1758326400000 implements MigrationInterface {
	public readonly name = 'AddServiceDirectory1758326400000';

	private _columns(): TableColumn[] {
		return [
			new TableColumn({ name: 'accountToken', type: 'varchar', isNullable: true }),
			new TableColumn({ name: 'serverIdentifier', type: 'varchar', isNullable: true }),
			new TableColumn({ name: 'connectionRoute', type: 'varchar', isNullable: true }),
		];
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumns('media_services', this._columns());
	}

	/**
	 * Not `dropColumns` on SQLite, and that is the difference between a revert and a
	 * wipe.
	 *
	 * TypeORM's SQLite driver has no column drop of its own: it rebuilds the table —
	 * creates a copy without the columns, copies the rows, drops the original. Dropping
	 * a table with foreign keys enforced first deletes every row of it, and that delete
	 * cascades: every library of every service goes, and every media item with them.
	 * `migration:run` switches enforcement off before it opens its transaction, so the
	 * same rebuild in `up` is harmless; `migration:revert` switches it off *inside* the
	 * transaction, where SQLite ignores the pragma. SQLite has dropped columns natively
	 * since 3.35, without rebuilding anything, and that statement is spelled the same on
	 * PostgreSQL — but PostgreSQL keeps `dropColumns`, which is the ordinary path there.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumns('media_services', this._columns());

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		for (const column of this._columns()) {
			await queryRunner.query(
				`ALTER TABLE ${escape('media_services')} DROP COLUMN ${escape(column.name)}`,
			);
		}
	}
}
