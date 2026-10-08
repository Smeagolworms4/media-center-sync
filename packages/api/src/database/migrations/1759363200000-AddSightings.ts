import { type MigrationInterface, type QueryRunner, TableColumn } from 'typeorm';

/**
 * Two columns on `media_items`: when something that fills a gap was last seen.
 *
 * The episode watch has always run the searches. It asked every tracker about every
 * followed show with a gap, every six hours, sent a notification naming how many
 * episodes could be fetched — and then dropped the answer. So the one screen built to
 * show what is new could say that a show was short three episodes and could never say
 * whether any of the three could be had, which is the whole of "pas juste notifier sur
 * overseer": a wall of twelve cards of which two are obtainable, indistinguishable
 * until somebody opens each one and searches again by hand.
 *
 * Two plain columns rather than a table of sightings, and that is a decision about what
 * the question is. "Is there anything for this, now" is a property of the media, read
 * for the whole filtered catalogue whenever the news screen draws; a history of searches
 * answers nobody's question and would make that read a join. Nor one column with a set
 * in it: the two are filtered on separately, because a copy on a friend's server and a
 * release on a tracker are not the same evening.
 *
 * Dates rather than flags, so a stale answer can be told from a fresh one. A pass looks
 * at a batch of shows, so a full cycle over a large watchlist takes days, and a sighting
 * is believed for a bounded while — see `SIGHTED_FRESH_FOR`.
 *
 * Additive, nullable, never back-filled: null means nothing is known, which is not the
 * same as nothing existing, and the columns fill in as the watch comes round.
 */
export class AddSightings1759363200000 implements MigrationInterface {
	public readonly name = 'AddSightings1759363200000';

	/**
	 * `datetime` on SQLite and `timestamp` on PostgreSQL, picked per connection.
	 *
	 * The one type name the driver does not translate for us, and the one way this
	 * migration can be written so that it applies on one engine and fails on the other
	 * — which is a failure nobody sees until a household switches to PostgreSQL. See the
	 * note at the top of `InitialSchema`, which spells out the same trap.
	 */
	private _columns(queryRunner: QueryRunner): TableColumn[] {
		const type = queryRunner.connection.options.type === 'postgres' ? 'timestamp' : 'datetime';

		return [
			new TableColumn({ name: 'releaseSeenAt', type, isNullable: true }),
			new TableColumn({ name: 'copySeenAt', type, isNullable: true }),
		];
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumns('media_items', this._columns(queryRunner));
	}

	/**
	 * Not `dropColumn` on SQLite, which is the difference between a revert and a wipe:
	 * TypeORM emulates it by recreating the table, and the trap is documented at length in
	 * `AddTransferLot`.
	 */
	public async down(queryRunner: QueryRunner): Promise<void> {
		if (queryRunner.connection.options.type === 'postgres') {
			await queryRunner.dropColumns('media_items', this._columns(queryRunner));

			return;
		}

		const escape = (name: string): string => queryRunner.connection.driver.escape(name);

		for (const column of this._columns(queryRunner)) {
			await queryRunner.query(
				`ALTER TABLE ${escape('media_items')} DROP COLUMN ${escape(column.name)}`,
			);
		}
	}
}
