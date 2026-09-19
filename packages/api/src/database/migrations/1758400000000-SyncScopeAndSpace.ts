import {
	Table,
	TableColumn,
	type MigrationInterface,
	type QueryRunner,
	type TableColumnOptions,
} from 'typeorm';

/**
 * What a sync covers, what it would fill, and what it did line by line.
 *
 * Three things that were one missing column each:
 *
 * `sync_plans.scope` replaces `rootItemId`. A single subtree was never enough to say
 * what a schedule does — "keep my Shows in step" is a merged category, "these three
 * shows" is three subtrees — and a plan that cannot state its scope is a plan nobody
 * dares enable, because the honest reading of it is "move an entire media library".
 * The old column is dropped rather than carried along: this is pre-release, and a
 * schema that keeps both shapes ends up with two answers to where a plan's scope lives
 * and code that consults whichever it remembers. The few rows anybody has are plans
 * that take a minute to retype.
 *
 * `sync_jobs.scope`, `targets` and `stoppedBy` are the same idea for a finished run.
 * The scope is copied rather than read back through the plan, which gets edited; the
 * targets carry the free space as it was measured before a byte moved, which is the
 * only moment that number is worth anything; and `stoppedBy` is the difference between
 * a run that did everything and one that hit a ceiling, which is otherwise
 * indistinguishable from the counters alone.
 *
 * `sync_job_items` makes a job openable. A progress bar that says "412 of 900" cannot
 * answer which item is stuck or where it is being written, and joining the transfers
 * would lose exactly the lines somebody opens the page for — a ceiling never creates a
 * transfer, and pruning the history deletes the ones it did.
 *
 * Every added column is defaulted or nullable, so existing rows mean "no scope stated"
 * and "nothing was measured", both of which are true of them.
 */
export class SyncScopeAndSpace1758400000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumns('sync_plans', [
			new TableColumn({ name: 'scope', type: 'text', isNullable: false, default: "'{}'" }),
			new TableColumn({ name: 'maxItemsPerRun', type: 'int', isNullable: true }),
			new TableColumn({ name: 'maxBytesPerRun', type: 'bigint', isNullable: true }),
		]);
		await queryRunner.dropColumn('sync_plans', 'rootItemId');

		await queryRunner.addColumns('sync_jobs', [
			new TableColumn({ name: 'scope', type: 'text', isNullable: false, default: "'{}'" }),
			new TableColumn({ name: 'targets', type: 'text', isNullable: false, default: "'[]'" }),
			new TableColumn({ name: 'stoppedBy', type: 'varchar', isNullable: true }),
		]);

		await queryRunner.createTable(this._jobItems(queryRunner), true);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropTable('sync_job_items', true);
		await queryRunner.dropColumns('sync_jobs', ['stoppedBy', 'targets', 'scope']);
		await queryRunner.addColumn(
			'sync_plans',
			new TableColumn({ name: 'rootItemId', type: 'varchar', isNullable: true }),
		);
		await queryRunner.dropColumns('sync_plans', ['maxBytesPerRun', 'maxItemsPerRun', 'scope']);
	}

	/**
	 * One line of a run.
	 *
	 * `bigint` for both byte counters, for the reason the transfers table already
	 * gives: a 4K episode goes past two gigabytes, and a counter that wraps at 2^31
	 * turns into a progress bar running backwards rather than into an error.
	 */
	private _jobItems(queryRunner: QueryRunner): Table {
		const dateTime = this._dateTime(queryRunner);
		const now = this._now(queryRunner);
		const stamps: TableColumnOptions[] = [
			{ name: 'createdAt', type: dateTime, isNullable: false, default: now },
			{ name: 'updatedAt', type: dateTime, isNullable: false, default: now },
		];

		return new Table({
			name: 'sync_job_items',
			columns: [
				...stamps,
				// Application-generated UUID in a `varchar`, as everywhere else here:
				// `uuid_generate_v4()` does not exist on SQLite, and a default that
				// only fires on one of the two engines leaves empty identifiers on the
				// other.
				{ name: 'id', type: 'varchar', isPrimary: true },
				{ name: 'jobId', type: 'varchar' },
				{ name: 'position', type: 'int', default: '0' },
				{ name: 'itemId', type: 'varchar' },
				{ name: 'title', type: 'varchar' },
				{ name: 'kind', type: 'varchar' },
				{ name: 'sourceServiceId', type: 'varchar' },
				{ name: 'sourceServiceName', type: 'varchar', default: "''" },
				{ name: 'targetLibraryId', type: 'varchar', isNullable: true },
				{ name: 'targetPath', type: 'varchar' },
				{ name: 'bytes', type: 'bigint', default: '0' },
				{ name: 'bytesDone', type: 'bigint', default: '0' },
				{ name: 'state', type: 'varchar', default: "'pending'" },
				{ name: 'transferId', type: 'varchar', isNullable: true },
				{ name: 'error', type: 'varchar', isNullable: true },
				{ name: 'startedAt', type: dateTime, isNullable: true },
				{ name: 'finishedAt', type: dateTime, isNullable: true },
			],
			// The hashes TypeORM derives from the table and the columns, as in the
			// initial schema: a friendlier name would make every later generated
			// migration start by dropping and recreating the index.
			indices: [
				{ name: 'IDX_6370278db8ebfcbdc495d0c8e2', columnNames: ['jobId'] },
				{ name: 'IDX_04ef300a7935dc54058d371c7c', columnNames: ['state'] },
				{ name: 'IDX_7587c24a8959e42ef880c1bf1f', columnNames: ['transferId'] },
			],
		});
	}

	/** `datetime` on SQLite, `timestamp` on PostgreSQL. The one type they disagree on. */
	private _dateTime(queryRunner: QueryRunner): string {
		return queryRunner.connection.options.type === 'postgres' ? 'timestamp' : 'datetime';
	}

	private _now(queryRunner: QueryRunner): string {
		return queryRunner.connection.options.type === 'postgres' ? 'now()' : "datetime('now')";
	}
}
