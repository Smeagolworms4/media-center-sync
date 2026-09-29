import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * One column on `transfers`: the fact the error key cannot carry.
 *
 * `error` is a key and `errorKind` is a category. Between them they say what kind of
 * thing went wrong and nothing whatever about this one: a row reading "the destination
 * folder has disappeared" sends somebody to look at a folder without saying which, and
 * on a gateway with five libraries that is a search rather than a repair. The path was
 * in the gateway's log the whole time and nowhere a person would look.
 *
 * Free text and never translated, because what goes in it is a path, a length or a
 * server's own words, and those read the same in every language.
 *
 * Additive, nullable, no back-fill: a row that failed before this column existed has no
 * detail to recover — the log that held it has long since rotated — and inventing one
 * would be worse than the silence.
 *
 * Not indexed: nothing searches on it. It is read one row at a time, on a row already in
 * hand.
 *
 * Built from a `TableColumn` object so the driver renders each engine's dialect, and
 * `varchar` because SQLite and PostgreSQL spell it the same way.
 */
export class AddTransferErrorDetail1758844800000 implements MigrationInterface {
	public readonly name = 'AddTransferErrorDetail1758844800000';

	private _column(): TableColumn {
		return new TableColumn({ name: 'errorDetail', type: 'varchar', isNullable: true });
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn('transfers', this._column());
	}

	/**
	 * Not `dropColumn` on SQLite, which is the difference between a revert and a wipe:
	 * TypeORM's SQLite driver rebuilds the table rather than dropping a column, and a
	 * table rebuilt with foreign keys enforced deletes every row first. `AddTransferLot`
	 * documents the whole trap.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumn('transfers', this._column());

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		await queryRunner.query(
			`ALTER TABLE ${escape('transfers')} DROP COLUMN ${escape('errorDetail')}`,
		);
	}
}
