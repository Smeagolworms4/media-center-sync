import { type MigrationInterface, type QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * One column on `transfers`: the lot a file belongs to.
 *
 * A lot is the thing somebody pressed download on — a film, a series, a season, an
 * episode. The planner already decided it, so as to pin every file of one lot under the
 * same root, but that decision only lived as long as the plan: nothing stored it, and
 * everything downstream had to group on `jobId` instead. That is a different question,
 * and the difference is what a household sees. A season pulled over three nights is one
 * lot and three runs, so the queue drew it as three unrelated blocks going to the same
 * folder; and a run whose scope named three shows is three lots, so the queue fused them
 * into one block nothing could take apart again.
 *
 * Additive, nullable, and never back-filled. It could not be: the lot is a property of
 * the scope a run was started with, and by the time a row is old enough to be missing
 * this column the subtree it was reached through may have been re-parented. Readers take
 * null to mean "this row is its own lot" — the contract is written on the entity, which
 * is where somebody reading the column will be. A default of the empty string would have
 * made every row a gateway has ever written one gigantic lot, which is a worse answer
 * than no grouping at all.
 *
 * Indexed because the lot is what the move reads by: redirecting a lot has to find every
 * file of it, the ones an earlier run already landed included, and without an index that
 * is a scan of every transfer the gateway has ever run.
 *
 * Built from `TableColumn` and `TableIndex` objects so the driver renders each engine's
 * dialect, and `varchar` because it is a type SQLite and PostgreSQL spell the same way.
 * The index name is the hash TypeORM's `DefaultNamingStrategy` derives from the table and
 * the column, for the reason `InitialSchema` gives: it is what `migration:generate`
 * compares against, and a friendlier name would make every later generated migration
 * start by dropping and recreating it.
 */
export class AddTransferLot1758585600000 implements MigrationInterface {
	public readonly name = 'AddTransferLot1758585600000';

	private _column(): TableColumn {
		return new TableColumn({ name: 'lot', type: 'varchar', isNullable: true });
	}

	private _index(): TableIndex {
		return new TableIndex({ name: 'IDX_99e1625eada98c35a1a81a1921', columnNames: ['lot'] });
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn('transfers', this._column());
		await queryRunner.createIndex('transfers', this._index());
	}

	/**
	 * The index goes first, and not merely for tidiness: SQLite refuses to drop a column
	 * an index still mentions, so the other order fails outright there.
	 *
	 * Not `dropColumn` on SQLite either, and that is the difference between a revert and
	 * a wipe — the same trap `AddServiceDirectory` and `AddSyntheticMediaItems` document.
	 * TypeORM's SQLite driver has no column drop of its own: it rebuilds the table, and
	 * dropping a table with foreign keys enforced deletes every row of it first, cascading
	 * into every child. `migration:run` switches enforcement off before it opens its
	 * transaction, so the same rebuild in `up` is harmless; `migration:revert` switches it
	 * off *inside* the transaction, where SQLite ignores the pragma. SQLite has dropped
	 * columns natively since 3.35 without rebuilding anything, and the statement is
	 * spelled the same on PostgreSQL — but PostgreSQL keeps `dropColumn`, which is the
	 * ordinary path there.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropIndex('transfers', this._index());

		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumn('transfers', this._column());

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		await queryRunner.query(`ALTER TABLE ${escape('transfers')} DROP COLUMN ${escape('lot')}`);
	}
}
