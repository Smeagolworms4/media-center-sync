import { type MigrationInterface, type QueryRunner, Table } from 'typeorm';

/**
 * One table: what was grabbed from an indexer, and what became of it.
 *
 * A torrent client knows it is downloading `Spartacus.S03E08.1080p-GRP` and has never
 * heard of the media it is for. Nothing in the product could file the file when it
 * arrives without somewhere to keep the link between a hash in qBittorrent and a row in
 * our catalogue — and that link has to survive a restart of either, which rules out
 * holding it in memory.
 *
 * Built from a `Table` object rather than raw SQL so the driver renders each engine's
 * dialect, and the column types stay inside what both understand: `varchar`, `bigint`
 * and the engine's own datetime. The identifier is an application-generated UUID in a
 * `varchar`, because `uuid_generate_v4()` does not exist on SQLite.
 */
export class AddReleaseGrabs1758499200000 implements MigrationInterface {
	public readonly name = 'AddReleaseGrabs1758499200000';

	private _dateTime(queryRunner: QueryRunner): string {
		return queryRunner.connection.options.type === 'postgres' ? 'timestamp' : 'datetime';
	}

	private _now(queryRunner: QueryRunner): string {
		return queryRunner.connection.options.type === 'postgres'
			? 'now()'
			: 'CURRENT_TIMESTAMP';
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		const dateTime = this._dateTime(queryRunner);
		const now = this._now(queryRunner);

		await queryRunner.createTable(
			new Table({
				name: 'release_grabs',
				columns: [
					{ name: 'createdAt', type: dateTime, isNullable: false, default: now },
					{ name: 'updatedAt', type: dateTime, isNullable: false, default: now },
					{ name: 'id', type: 'varchar', isPrimary: true },
					{ name: 'itemId', type: 'varchar' },
					{ name: 'title', type: 'varchar' },
					{ name: 'indexer', type: 'varchar' },
					{ name: 'state', type: 'varchar' },
					{ name: 'clientId', type: 'varchar', isNullable: true },
					{ name: 'bytesDone', type: 'bigint', default: 0 },
					{ name: 'bytesTotal', type: 'bigint', default: 0 },
					{ name: 'sourcePath', type: 'varchar', isNullable: true },
					{ name: 'targetPath', type: 'varchar', isNullable: true },
					// Spelled per engine: SQLite stores booleans as 0 and 1 while PostgreSQL
					// wants `false`, and a literal in the other one's spelling is accepted
					// by neither.
					{
						name: 'partial',
						type: 'boolean',
						default: queryRunner.connection.options.type === 'postgres' ? 'false' : 0,
					},
					{ name: 'targetLibraryId', type: 'varchar', isNullable: true },
					{ name: 'targetFolder', type: 'varchar', isNullable: true },
					{ name: 'error', type: 'varchar', isNullable: true },
					// `simple-json`, which is `text` on both engines.
					{ name: 'placements', type: 'text', isNullable: true },
				],
				indices: [
					// The three questions asked of this table: what is grabbed for this
					// media, what is still moving, and which row is this hash.
					{ name: 'IDX_release_grabs_item', columnNames: ['itemId'] },
					{ name: 'IDX_release_grabs_state', columnNames: ['state'] },
					{ name: 'IDX_release_grabs_client', columnNames: ['clientId'] },
				],
			}),
			true,
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropTable('release_grabs', true);
	}
}
