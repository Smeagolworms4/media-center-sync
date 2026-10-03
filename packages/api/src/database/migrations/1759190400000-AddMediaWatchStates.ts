import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * One column on `media_items`: what the household has said about this media.
 *
 * `followed` and `requested` were libraries before this — "Requests" and "Watchlist" —
 * and that was the wrong shape for them. A shelf says where a media lives; these say what
 * somebody wants done about it. Written as shelves, a requested film stood beside the
 * films instead of among them, and a show held locally *and* followed was two cards of
 * one media that nothing would ever merge, because they were two libraries of two
 * services and correlation had no reason to look.
 *
 * On the row, they survive that: the request source is an ordinary source, its rows
 * correlate with the local copy exactly like a peer's would, and what is left over is a
 * statement on the merged media rather than a second copy of it.
 *
 * A set, not a value, and `simple-array` rather than two booleans for it. The two are
 * independent — a show can be asked for and followed, and most are — and a third thing
 * the source may say one day is a value here instead of another migration. The cost is
 * that it cannot be indexed usefully, which is fine: it is read by the two screens that
 * filter on it, against a table whose size is a household's library.
 *
 * Additive and nullable, never back-filled. Null means nothing has been said, which is
 * also every row written before this column existed and every row that will ever come
 * from a media server — only the request source fills it.
 */
export class AddMediaWatchStates1759190400000 implements MigrationInterface {
	public readonly name = 'AddMediaWatchStates1759190400000';

	/**
	 * `text`, where the entity says `simple-array`.
	 *
	 * The two are the same column: `simple-array` is TypeORM's word for "a list, stored as
	 * one comma-joined string", and the storage it picks is `text`. Written here as
	 * `simple-array` the statement reaches SQLite as `... simple-array`, which is not a
	 * type it has ever heard of — `near "-": syntax error`, on a migration that runs at
	 * start-up, so the gateway does not boot at all.
	 */
	private _column(): TableColumn {
		return new TableColumn({ name: 'watchStates', type: 'text', isNullable: true });
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
			`ALTER TABLE ${escape('media_items')} DROP COLUMN ${escape('watchStates')}`,
		);
	}
}
