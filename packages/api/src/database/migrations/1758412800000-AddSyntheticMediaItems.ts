import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * One column on `media_items`: whether the gateway invented the row.
 *
 * Correcting an episode into a season the service does not report has to create that
 * season, or the episode has nowhere to hang and the correction changes a number
 * without changing a place. The row that comes out is ours and no server will ever
 * list it, which is precisely what the stale pass at the end of a scan deletes — so
 * the pass has to be able to tell the two apart, and a column is the only thing a
 * `WHERE` clause can read.
 *
 * Additive, with a default, and never back-filled: every row a gateway running 0.1.0,
 * 0.1.1 or 0.2.0 already holds came from a service, which is exactly what `false`
 * says. `InitialSchema` is not touched, for the reason it states on its way out.
 *
 * Built from a `TableColumn` object so the driver renders each engine's dialect, and
 * the default is spelled per engine because SQLite stores booleans as `0` and `1`
 * while PostgreSQL wants `false` — a literal written in the other one's spelling is
 * accepted by neither.
 */
export class AddSyntheticMediaItems1758412800000 implements MigrationInterface {
	public readonly name = 'AddSyntheticMediaItems1758412800000';

	private _column(queryRunner: QueryRunner): TableColumn {
		return new TableColumn({
			name: 'synthetic',
			type: 'boolean',
			default: queryRunner.connection.options.type === 'postgres' ? 'false' : '0',
		});
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn('media_items', this._column(queryRunner));
	}

	/**
	 * Not `dropColumn` on SQLite, and that is the difference between a revert and a
	 * wipe — the same trap `AddServiceDirectory` documents.
	 *
	 * TypeORM's SQLite driver has no column drop of its own: it rebuilds the table,
	 * and dropping a table with foreign keys enforced deletes every row of it first,
	 * cascading into every child. `migration:run` switches enforcement off before it
	 * opens its transaction, so the same rebuild in `up` is harmless;
	 * `migration:revert` switches it off *inside* the transaction, where SQLite
	 * ignores the pragma. SQLite has dropped columns natively since 3.35 without
	 * rebuilding anything, and the statement is spelled the same on PostgreSQL — but
	 * PostgreSQL keeps `dropColumn`, which is the ordinary path there.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumn('media_items', this._column(queryRunner));

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		await queryRunner.query(
			`ALTER TABLE ${escape('media_items')} DROP COLUMN ${escape('synthetic')}`,
		);
	}
}
