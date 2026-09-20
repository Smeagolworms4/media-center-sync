import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * The keywords that file a discovered library into one of our categories.
 *
 * Why a table at all, and why this shape: a category is not a row. It is derived
 * from the names the libraries read as, which means its key moves the moment
 * somebody renames the library it was named after. Keying a keyword list on
 * `MediaCategory.key` would orphan the list on exactly the rename it exists to
 * survive — the peers' shelves would quietly unfold back into eleven categories and
 * nothing would report anything. So each keyword is anchored on `libraryId`, which
 * survives a rename (the alias moves, the row does not) and survives a rescan
 * (a scan matches rows on `(serviceId, externalId)` and updates them in place).
 *
 * `normalized` is unique across the whole table, not per library. Two categories
 * claiming `tv` would file a friend's shelf into whichever row the database handed
 * back first, and that answer would change between two identical requests; moving a
 * keyword from one category to another is a deliberate act with a route of its own.
 *
 * The foreign key cascades: unregistering the service that holds our `Shows` removes
 * the category it defined, and a keyword left pointing at it would file shelves into
 * a name nothing here answers to any more.
 *
 * Index and key names are the hashes TypeORM derives from the table and the columns,
 * so a later `migration:generate` compares equal instead of proposing to drop and
 * recreate them.
 *
 * `down` drops the table whole. Nothing is lost that cannot be said again: every row
 * is a sentence somebody wrote about names, and no media moved because of it.
 */
export class CategoryKeywords1758500000000 implements MigrationInterface {
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
				name: 'category_keywords',
				columns: [
					{ name: 'createdAt', type: dateTime, isNullable: false, default: now },
					{ name: 'updatedAt', type: dateTime, isNullable: false, default: now },
					// Application-generated UUID in a `varchar(36)`: `uuid_generate_v4()`
					// does not exist on SQLite, and a default that only fires on one of
					// the two engines is how rows end up with an empty identifier on the
					// other.
					{ name: 'id', type: 'varchar', length: '36', isPrimary: true },
					{ name: 'libraryId', type: 'varchar', length: '36' },
					// What somebody typed, kept as they wrote it. Nothing matches on it;
					// it is there so the screen shows `Émissions TV` and not
					// `emissions-tv`.
					{ name: 'keyword', type: 'varchar' },
					{ name: 'normalized', type: 'varchar' },
				],
				indices: [
					{ name: 'IDX_f35d93955a0febab9b448d907c', columnNames: ['libraryId'] },
					{
						name: 'IDX_cd83ed63f4b2f56aae9bf7f951',
						columnNames: ['normalized'],
						isUnique: true,
					},
				],
				foreignKeys: [
					{
						name: 'FK_f35d93955a0febab9b448d907c6',
						columnNames: ['libraryId'],
						referencedTableName: 'libraries',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE',
					},
				],
			}),
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropTable('category_keywords');
	}
}
