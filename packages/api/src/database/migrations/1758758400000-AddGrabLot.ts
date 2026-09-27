import { type MigrationInterface, type QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * One column on `release_grabs`: the lot a download belongs to.
 *
 * A lot is what somebody pressed download on, which is not what a tracker hands over:
 * three season packs asked for in one act are one lot and three downloads. Without it
 * the queue is three rows, each with its own progress bar and its own three buttons, to
 * be stopped, archived and redirected one at a time — which is the state somebody
 * describes as "it should be one transfer with the files inside".
 *
 * `transfers` has had the same column since `AddTransferLot`, for the same reason and
 * with the same shape, so that one screen can group both kinds the same way.
 *
 * Additive, nullable, never back-filled. Null means "this download is its own lot",
 * which is exactly what every row written before this column existed was: one press.
 * Readers are told that on the entity, which is where somebody reading the column will
 * be.
 *
 * Indexed because the lot is what a block is read by: acting on one means finding every
 * download of it, and without an index that is a scan of every grab the gateway has ever
 * made.
 *
 * Built from `TableColumn` and `TableIndex` objects so the driver renders each engine's
 * dialect, and `varchar` because SQLite and PostgreSQL spell it the same way. The index
 * name is the hash TypeORM's `DefaultNamingStrategy` derives from the table and the
 * column, for the reason `InitialSchema` gives: it is what `migration:generate` compares
 * against, and a friendlier name would make every later generated migration start by
 * dropping and recreating it.
 */
export class AddGrabLot1758758400000 implements MigrationInterface {
	public readonly name = 'AddGrabLot1758758400000';

	private _column(): TableColumn {
		return new TableColumn({ name: 'lot', type: 'varchar', isNullable: true });
	}

	private _index(): TableIndex {
		return new TableIndex({ name: 'IDX_2a5a2e6cfdc0a9cd4e1b7f4d31', columnNames: ['lot'] });
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn('release_grabs', this._column());
		await queryRunner.createIndex('release_grabs', this._index());
	}

	/**
	 * The index goes first: SQLite refuses to drop a column an index still mentions, so
	 * the other order fails outright there. And not `dropColumn` on SQLite either, which
	 * is the difference between a revert and a wipe — `AddTransferLot` documents the whole
	 * trap.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropIndex('release_grabs', this._index());

		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumn('release_grabs', this._column());

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		await queryRunner.query(`ALTER TABLE ${escape('release_grabs')} DROP COLUMN ${escape('lot')}`);
	}
}
