import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * One column on `release_grabs`: where a download is expected to land.
 *
 * The queue had nothing to say for the whole length of a torrent. `targetPath` is only
 * written once the file has been filed, and `targetFolder` only when somebody chose a
 * folder themselves — so a download running for six hours showed a library name at best,
 * and usually nothing at all. "Where is this going to end up" is the question somebody
 * asks precisely while it is still running.
 *
 * A prediction, never a decision: the placement chain runs again when the bytes are
 * there, because the disk it answered against may have filled and a series may have
 * moved since. Nothing reads this column to place anything, which is why it is safe for
 * it to be a guess.
 *
 * Additive and nullable, with no back-fill: a row written before this existed was sent
 * against libraries whose free space and contents are no longer what they were, and
 * inventing an answer for it would be inventing where it *would have* gone. Null means
 * "nobody worked it out", which the entity states and the interface renders as saying
 * nothing rather than as a blank path.
 *
 * Not indexed: nothing searches on it and nothing groups by it. It is read one row at a
 * time, on rows already in hand.
 *
 * Built from a `TableColumn` object so the driver renders each engine's dialect, and
 * `varchar` because SQLite and PostgreSQL spell it the same way.
 */
export class AddGrabPlannedPath1758672000000 implements MigrationInterface {
	public readonly name = 'AddGrabPlannedPath1758672000000';

	private _column(): TableColumn {
		return new TableColumn({ name: 'plannedPath', type: 'varchar', isNullable: true });
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn('release_grabs', this._column());
	}

	/**
	 * Not `dropColumn` on SQLite, which is the difference between a revert and a wipe:
	 * TypeORM's SQLite driver rebuilds the table rather than dropping a column, and a
	 * table rebuilt with foreign keys enforced deletes every row first, cascading into
	 * every child. `migration:revert` switches enforcement off inside its transaction,
	 * where SQLite ignores the pragma. `AddTransferLot` documents the whole trap.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumn('release_grabs', this._column());

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		await queryRunner.query(
			`ALTER TABLE ${escape('release_grabs')} DROP COLUMN ${escape('plannedPath')}`,
		);
	}
}
