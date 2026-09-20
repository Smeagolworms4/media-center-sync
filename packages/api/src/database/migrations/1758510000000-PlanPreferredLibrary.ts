import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * A plan's destination stops being a target and becomes a preference.
 *
 * A rename and nothing else: no row moves, no value changes, and every plan keeps the
 * library it was pointed at. What changes is what that library means, and the column
 * had to follow or the name would have gone on contradicting the behaviour.
 *
 * `targetLibraryId` read as "this plan writes here", and it used to: placement tried
 * it before anything else, including before the folder a series we already hold lives
 * in. That was the defect — pointing a plan at a shelf would file the fourth season of
 * a show into it while the first three stayed where they were, and no media server
 * shows that as one series. The preference now sits below the existing copy and above
 * the category, so it decides where genuinely new things go and never splits a show.
 * A column still called `target` would have been the first thing to mislead whoever
 * read the query.
 *
 * Renamed rather than dropped and recreated so the values survive on both engines.
 * TypeORM renders `ALTER TABLE … RENAME COLUMN` on PostgreSQL and rebuilds the table
 * on SQLite, which is why this is a `renameColumn` call and not raw SQL: the two
 * dialects do not agree on any spelling of it.
 *
 * `down` puts the old name back, and nothing else — a gateway rolled back to the
 * previous image reads the same value and goes back to consulting it first, which is
 * the behaviour that image expects.
 */
export class PlanPreferredLibrary1758510000000 implements MigrationInterface {
	/** The column as it is defined either way round, since only its name moves. */
	private _column(name: string): TableColumn {
		return new TableColumn({ name, type: 'varchar', isNullable: true });
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.renameColumn(
			'sync_plans',
			'targetLibraryId',
			this._column('preferredLibraryId'),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.renameColumn(
			'sync_plans',
			'preferredLibraryId',
			this._column('targetLibraryId'),
		);
	}
}
