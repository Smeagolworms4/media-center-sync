import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * One column on `media_items`: the last episode of a file that holds several.
 *
 * A gap is not found by counting. Nothing enumerates "season 1 should run 1 to 13";
 * the gap detection lists what a season holds, asks the metadata provider what it
 * should hold, and mints a row for every number in the second list that is absent
 * from the first. That works until one file is two episodes: `S01E01-E02` reports a
 * single number, so the second one looks absent, a row is created for it, and the
 * household is offered a download of an episode already on its disk. Four shows in
 * one library were doing exactly this.
 *
 * The alternative was to leave the schema alone and expand the range wherever the
 * question is asked, by re-parsing the file name each time. That is the same parse
 * repeated in four places with four chances to disagree, and it cannot work at all
 * for the servers that report the range in their API and not in the path — which is
 * the common case, since Jellyfin and Plex both know it and only the path is
 * ambiguous.
 *
 * Additive and nullable, never back-filled: null means one episode, not unknown. The
 * rows written before this column existed keep the meaning they already had, and the
 * ranges reappear on the next scan, where they are read from the server rather than
 * guessed from history.
 */
export class AddEpisodeNumberEnd1759276800000 implements MigrationInterface {
	public readonly name = 'AddEpisodeNumberEnd1759276800000';

	private _column(): TableColumn {
		return new TableColumn({ name: 'episodeNumberEnd', type: 'int', isNullable: true });
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn('media_items', this._column());
	}

	/**
	 * Not `dropColumn` on SQLite, which is the difference between a revert and a wipe:
	 * TypeORM emulates it by recreating the table, and the trap is documented at length in
	 * `AddTransferLot`.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumn('media_items', this._column());

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		await queryRunner.query(
			`ALTER TABLE ${escape('media_items')} DROP COLUMN ${escape('episodeNumberEnd')}`,
		);
	}
}
