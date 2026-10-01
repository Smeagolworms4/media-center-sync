import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * One column on `release_grabs`: the quality a release's own name claims.
 *
 * The queue said nothing about what was arriving. A download of twelve gigabytes could be
 * a 2160p remux or a 720p re-encode and the row read the same either way, so the only way
 * to know what was coming was to remember which line had been pressed — which nobody does
 * twenty minutes later.
 *
 * **Claimed, never measured.** Everything else in this product that carries a quality was
 * read off the file by `QualityService`, and that distinction is load-bearing: it is why a
 * peer's copy outranks a tracker line of the same stated resolution. A name is evidence of
 * nothing — it is what a release group typed — so this is a separate column with a
 * separate meaning, and it never feeds a quality summary. The interface labels it as the
 * name's claim.
 *
 * Additive, nullable, never back-filled. Null means the name said nothing readable, which
 * is also every row written before this column existed.
 *
 * Not indexed: nothing filters on it, and a column read only when a row is drawn does not
 * earn an index.
 */
export class AddGrabQuality1759017600000 implements MigrationInterface {
	public readonly name = 'AddGrabQuality1759017600000';

	private _column(): TableColumn {
		return new TableColumn({ name: 'quality', type: 'varchar', isNullable: true });
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn('release_grabs', this._column());
	}

	/**
	 * Not `dropColumn` on SQLite, which is the difference between a revert and a wipe:
	 * TypeORM emulates it by recreating the table, and the trap is documented at length in
	 * `AddTransferLot`.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumn('release_grabs', this._column());

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		await queryRunner.query(
			`ALTER TABLE ${escape('release_grabs')} DROP COLUMN ${escape('quality')}`,
		);
	}
}
