import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * What the gateway put on the disk, before any media server knows about it.
 *
 * The gap this closes: a transfer finishes, `FileMoveService` reports the file moved
 * into the library folder, and nothing anywhere records that. The media server has not
 * scanned yet, so our index still holds exactly one row for that media — the remote
 * copy we pulled from — and that row reads `missing`. Every screen then offers to
 * download a file that is already there, and people take the offer.
 *
 * A table rather than a map in memory, and that is the decision worth stating. The
 * window is minutes when a server watches its folders and hours when it scans on a
 * schedule; restarting the container inside that window is an ordinary thing to do,
 * and an in-memory record would be gone afterwards with the file still sitting in the
 * folder — the original bug, back, and now only reproducible by restarting.
 *
 * `itemId` is unique: a second pull of the same source replaces the first, because two
 * rows would be two answers to "has this been indexed yet". The other three indices
 * are the three lookups this table has — colouring a listing by library, recognising a
 * landing by its content identity after a media server renamed the file, and sweeping
 * the ones whose patience has run out.
 *
 * Index names are the hashes TypeORM derives from the table and the columns, so that a
 * later `migration:generate` compares equal instead of proposing to drop and recreate
 * every one of them.
 *
 * `down` drops the table whole. There is nothing to preserve: every row is a statement
 * about a file that a scan will rediscover on its own.
 */
export class MediaLandings1758490000000 implements MigrationInterface {
	private _isPostgres(queryRunner: QueryRunner): boolean {
		return queryRunner.connection.options.type === 'postgres';
	}

	/** `datetime` on SQLite, `timestamp` on PostgreSQL. Neither accepts the other. */
	private _dateTime(queryRunner: QueryRunner): string {
		return this._isPostgres(queryRunner) ? 'timestamp' : 'datetime';
	}

	/** The expression that stamps a row on insert, in the connected dialect. */
	private _now(queryRunner: QueryRunner): string {
		return this._isPostgres(queryRunner) ? 'now()' : "datetime('now')";
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		const dateTime = this._dateTime(queryRunner);
		const now = this._now(queryRunner);

		await queryRunner.createTable(
			new Table({
				name: 'media_landings',
				columns: [
					{ name: 'createdAt', type: dateTime, isNullable: false, default: now },
					{ name: 'updatedAt', type: dateTime, isNullable: false, default: now },
					// Application-generated UUID in a `varchar(36)`: `uuid_generate_v4()`
					// does not exist on SQLite, and a default that only fires on one of the
					// two engines is how rows end up with an empty identifier on the other.
					{ name: 'id', type: 'varchar', length: '36', isPrimary: true },
					{ name: 'itemId', type: 'varchar', length: '36' },
					{ name: 'transferId', type: 'varchar', length: '36', isNullable: true },
					{ name: 'libraryId', type: 'varchar', length: '36', isNullable: true },
					{ name: 'path', type: 'varchar' },
					// `bigint`, for the reason the transfer counters are: a 4K episode goes
					// past what a 32-bit counter holds, and the overflow shows up as a
					// negative size rather than as an error anybody notices.
					{ name: 'bytes', type: 'bigint', default: '0' },
					{ name: 'contentId', type: 'varchar', isNullable: true },
					{ name: 'state', type: 'varchar', default: "'waiting'" },
					{ name: 'expiresAt', type: dateTime, isNullable: false },
					{ name: 'rescanOutcome', type: 'varchar', isNullable: true },
				],
				indices: [
					{
						name: 'IDX_483934ce0278537dae66271372',
						columnNames: ['itemId'],
						isUnique: true,
					},
					{ name: 'IDX_f8fbe6a8ce313bdb923a5d8c78', columnNames: ['libraryId'] },
					{ name: 'IDX_0ba127e4b6dd06868d6998f435', columnNames: ['contentId'] },
					{ name: 'IDX_8c35469aa65814c082c790f965', columnNames: ['state'] },
				],
			}),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropTable('media_landings');
	}
}
