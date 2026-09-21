import {
	type MigrationInterface,
	type QueryRunner,
	Table,
	type TableColumnOptions,
} from 'typeorm';

/**
 * The whole schema, in one migration that has to run on SQLite and on PostgreSQL.
 *
 * This file replaces the nineteen migrations that used to follow it. The product had
 * never been released — two gateways existed, both the author's — and those nineteen
 * were the archaeology of a database nobody had ever installed: one added a column a
 * later one dropped, one converted a `scope` column into two and then removed it, one
 * undid a field added two migrations earlier. Fifteen hundred lines describing a
 * history with no survivors. Collapsing them costs the ability to upgrade an existing
 * database, and that is the deliberate trade: **any database created before this
 * migration must be dropped and recreated**, because nothing here migrates it. The
 * catalogues rebuild themselves from a scan, so what is actually lost is the peer
 * links, the sync plans and the accounts — a few minutes of retyping on each of the
 * two machines that had them.
 *
 * It has been used once more since, deliberately, and the cost is the same one: the
 * service's single root pair (`remoteRoot`, `localRoot`) became a list,
 * `rootMappings`, because one pair cannot describe a server whose films and shows are
 * on two disks. The owner asked for that change to be folded in here rather than
 * written as a second migration, since the product is still at its initial version —
 * but an image had already been published from `main` that day, so **any database
 * created from that image, or from this file before that change, must be dropped and
 * recreated as well**. Nothing here converts the old two columns; a database that has
 * them is refused by every query that reads a service, not quietly misread.
 *
 * That option closes on the day the first release goes out. From then on a schema
 * change is a new migration in this directory and this file is never touched again:
 * somebody, somewhere, has rows in it.
 *
 * Both engines are supported on purpose — SQLite because a household gateway should
 * not require a database server to operate, PostgreSQL because some people already
 * run one — and the same migration has to produce the same schema on either. That
 * rules out raw SQL: the two dialects disagree on quoting, on autoincrement, on
 * boolean literals and on half the type names, so a hand-written `CREATE TABLE`
 * would have to be written twice and would drift the first time only one of them was
 * touched. Going through `queryRunner.createTable(new Table(...))` hands that job to
 * the driver, which renders the dialect it is connected to.
 *
 * What the driver does not translate is the type names themselves: they are passed
 * through verbatim. Only the ones both engines understand are used here — `varchar`,
 * `text`, `integer`, `float`, `bigint`, `boolean` — plus `text` for the `simple-json`
 * columns, which is what TypeORM stores them as on both. The single exception is the
 * timestamp: SQLite spells it `datetime` and PostgreSQL `timestamp`, so it is picked
 * per connection below. `integer` rather than `int`, and that is not cosmetic: the
 * SQLite driver normalises an entity's `int` to `integer` before comparing, so a
 * column declared `int` here reads back as a difference and every later
 * `migration:generate` starts by rebuilding the table to change nothing.
 *
 * Identifiers are `varchar` holding a UUID produced by the application, never the
 * engine's own generator: `uuid_generate_v4()` does not exist on SQLite, and a
 * default that only fires on one of the two engines is how rows end up with an empty
 * identifier on the other. No length either — `varchar(36)` would be the honest width
 * of a UUID, but TypeORM normalises a `uuid` column to an unbounded `varchar`, so the
 * length is read back as a difference and costs the same spurious rebuild as `int`.
 *
 * Index, unique and foreign key names are the hashes TypeORM's `DefaultNamingStrategy`
 * derives from the table and columns. They look unreadable, and they are what
 * `migration:generate` compares against — renaming them to something friendlier would
 * make every later generated migration start by dropping and recreating them all.
 * Two of the migrations collapsed here had done exactly that, with names like
 * `IDX_banned_peers_fingerprint`, and the generator had been proposing to replace
 * them ever since.
 */
export class InitialSchema1758240000000 implements MigrationInterface {
	public readonly name = 'InitialSchema1758240000000';

	private _isPostgres(queryRunner: QueryRunner): boolean {
		return queryRunner.connection.options.type === 'postgres';
	}

	/** `datetime` on SQLite, `timestamp` on PostgreSQL. See the note above. */
	private _dateTime(queryRunner: QueryRunner): string {
		return this._isPostgres(queryRunner) ? 'timestamp' : 'datetime';
	}

	/** The expression that stamps a row on insert, in the connected dialect. */
	private _now(queryRunner: QueryRunner): string {
		return this._isPostgres(queryRunner) ? 'now()' : "datetime('now')";
	}

	/**
	 * How a boolean literal is spelled. SQLite stores them as `0` and `1`, PostgreSQL
	 * as `false` and `true`, and a default written in the other engine's spelling is
	 * accepted by neither.
	 */
	private _booleans(queryRunner: QueryRunner): [string, string] {
		return this._isPostgres(queryRunner) ? ['false', 'true'] : ['0', '1'];
	}

	private _id(): TableColumnOptions {
		return { name: 'id', type: 'varchar', isPrimary: true };
	}

	private _timestamps(queryRunner: QueryRunner): TableColumnOptions[] {
		const type = this._dateTime(queryRunner);
		const now = this._now(queryRunner);

		return [
			{ name: 'createdAt', type, isNullable: false, default: now },
			{ name: 'updatedAt', type, isNullable: false, default: now },
		];
	}

	/**
	 * Every table, in an order where a foreign key never points at something that
	 * does not exist yet. `down` walks the same list backwards.
	 */
	private _tables(queryRunner: QueryRunner): Table[] {
		const dateTime = this._dateTime(queryRunner);
		const stamps = this._timestamps(queryRunner);
		const [no, yes] = this._booleans(queryRunner);

		return [
			new Table({
				name: 'peers',
				columns: [
					...stamps,
					this._id(),
					{ name: 'name', type: 'varchar' },
					{ name: 'fingerprint', type: 'varchar' },
					{ name: 'nodeId', type: 'varchar', isNullable: true },
					{ name: 'protocol', type: 'integer', isNullable: true },
					{ name: 'capabilities', type: 'text', default: "'[]'" },
					{ name: 'publicKey', type: 'text', isNullable: true },
					{ name: 'status', type: 'varchar', default: "'pending'" },
					{ name: 'direction', type: 'varchar', isNullable: true },
					{ name: 'trust', type: 'varchar', default: "'friend'" },
					{ name: 'depth', type: 'integer', default: '1' },
					{ name: 'maxDepth', type: 'integer', isNullable: true },
					{ name: 'readingForbidden', type: 'boolean', default: no },
					{ name: 'discovered', type: 'boolean', default: no },
					{ name: 'linkMode', type: 'varchar', isNullable: true },
					{ name: 'address', type: 'varchar', isNullable: true },
					{ name: 'viaPeerId', type: 'varchar', isNullable: true },
					{ name: 'lastSeenAt', type: dateTime, isNullable: true },
				],
				indices: [
					{
						name: 'IDX_ced0b4fa1b3baa9edb8cf400a7',
						columnNames: ['fingerprint'],
						isUnique: true,
					},
				],
			}),

			// Keyed by fingerprint and not by peer, so that a ban outlives the row of
			// the peer it was pronounced against. No foreign key for the same reason.
			new Table({
				name: 'banned_peers',
				columns: [
					...stamps,
					this._id(),
					{ name: 'fingerprint', type: 'varchar' },
					{ name: 'name', type: 'varchar', isNullable: true },
					{ name: 'reason', type: 'varchar', length: '500', isNullable: true },
				],
				indices: [
					{
						name: 'IDX_dc6e1cd34eebecc4aee9b75d39',
						columnNames: ['fingerprint'],
						isUnique: true,
					},
				],
			}),

			new Table({
				name: 'media_services',
				columns: [
					...stamps,
					this._id(),
					{ name: 'name', type: 'varchar' },
					{ name: 'type', type: 'varchar' },
					{ name: 'shared', type: 'boolean', default: yes },
					{ name: 'filesMounted', type: 'boolean', default: no },
					{ name: 'baseUrl', type: 'varchar' },
					{ name: 'token', type: 'varchar', isNullable: true },
					{ name: 'username', type: 'varchar', isNullable: true },
					{ name: 'password', type: 'varchar', isNullable: true },
					{ name: 'status', type: 'varchar', default: "'unknown'" },
					{ name: 'version', type: 'varchar', isNullable: true },
					{ name: 'rootMappings', type: 'text', default: "'[]'" },
					{ name: 'authProvider', type: 'boolean', default: no },
					{ name: 'priority', type: 'integer', default: '100' },
					{ name: 'peerId', type: 'varchar', isNullable: true },
					{ name: 'lastProbeAt', type: dateTime, isNullable: true },
					{ name: 'lastScanAt', type: dateTime, isNullable: true },
				],
				indices: [
					{ name: 'IDX_fb133c530792b1f61570908684', columnNames: ['peerId'] },
					{
						name: 'IDX_3006d0cbd2e1b77b1d3ca0c630',
						columnNames: ['baseUrl', 'peerId'],
						isUnique: true,
					},
				],
				foreignKeys: [
					{
						name: 'FK_fb133c530792b1f615709086841',
						columnNames: ['peerId'],
						referencedTableName: 'peers',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE',
					},
				],
			}),

			new Table({
				name: 'libraries',
				columns: [
					...stamps,
					this._id(),
					{ name: 'serviceId', type: 'varchar' },
					{ name: 'externalId', type: 'varchar' },
					{ name: 'name', type: 'varchar' },
					{ name: 'alias', type: 'varchar', isNullable: true },
					{ name: 'position', type: 'integer', default: '100' },
					{ name: 'kind', type: 'varchar', default: "'other'" },
					{ name: 'paths', type: 'text', default: "'[]'" },
					{ name: 'localPath', type: 'varchar', isNullable: true },
					{ name: 'localPathDerived', type: 'boolean', default: no },
					{ name: 'writable', type: 'boolean', default: no },
					{ name: 'isDefaultTarget', type: 'boolean', default: no },
					{ name: 'lastScanAt', type: dateTime, isNullable: true },
					{ name: 'scanCursor', type: 'varchar', isNullable: true },
					{ name: 'lastRefreshAt', type: dateTime, isNullable: true },
					{ name: 'itemCount', type: 'integer', default: '0' },
				],
				indices: [
					{ name: 'IDX_52be93a3ca227dc3421cd71e51', columnNames: ['serviceId'] },
					{
						name: 'IDX_c3aceb6f4c93bf328fcfa57fe8',
						columnNames: ['serviceId', 'externalId'],
						isUnique: true,
					},
				],
				foreignKeys: [
					{
						name: 'FK_52be93a3ca227dc3421cd71e517',
						columnNames: ['serviceId'],
						referencedTableName: 'media_services',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE',
					},
				],
			}),

			new Table({
				name: 'category_keywords',
				columns: [
					...stamps,
					this._id(),
					{ name: 'libraryId', type: 'varchar' },
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

			new Table({
				name: 'media_items',
				columns: [
					...stamps,
					this._id(),
					{ name: 'serviceId', type: 'varchar' },
					{ name: 'libraryId', type: 'varchar' },
					{ name: 'externalId', type: 'varchar' },
					{ name: 'parentId', type: 'varchar', isNullable: true },
					{ name: 'parentExternalId', type: 'varchar', isNullable: true },
					{ name: 'kind', type: 'varchar' },
					{ name: 'title', type: 'varchar' },
					{ name: 'normalizedTitle', type: 'varchar' },
					{ name: 'year', type: 'integer', isNullable: true },
					{ name: 'seasonNumber', type: 'integer', isNullable: true },
					{ name: 'episodeNumber', type: 'integer', isNullable: true },
					{ name: 'externalIds', type: 'text', default: "'{}'" },
					{ name: 'overview', type: 'text', isNullable: true },
					{ name: 'artworkUrl', type: 'varchar', isNullable: true },
					{ name: 'file', type: 'text', isNullable: true },
					{ name: 'quality', type: 'text', isNullable: true },
					{ name: 'companions', type: 'text', isNullable: true },
					{ name: 'overrides', type: 'text', isNullable: true },
					{ name: 'reported', type: 'text', isNullable: true },
					{ name: 'ignored', type: 'boolean', default: no },
					{ name: 'syncState', type: 'varchar', default: "'unknown'" },
					{ name: 'addedAt', type: dateTime, isNullable: true },
					{ name: 'childCount', type: 'integer', default: '0' },
				],
				indices: [
					{ name: 'IDX_7587085e7d5963ba869b93ee2d', columnNames: ['serviceId'] },
					{ name: 'IDX_a9ec6417e1504e7a561ab369be', columnNames: ['libraryId'] },
					{ name: 'IDX_2016ca077c461461930f742535', columnNames: ['parentId'] },
					// The correlation index. Every strategy that looks for the same
					// episode somewhere else starts from this triple, and without it a
					// library of any size turns each comparison into a table scan.
					{
						name: 'IDX_820299505e44f151a0e652f684',
						columnNames: ['normalizedTitle', 'seasonNumber', 'episodeNumber'],
					},
					{
						name: 'IDX_83fd691a462fc06c60c311e861',
						columnNames: ['serviceId', 'externalId'],
						isUnique: true,
					},
				],
				foreignKeys: [
					{
						name: 'FK_7587085e7d5963ba869b93ee2df',
						columnNames: ['serviceId'],
						referencedTableName: 'media_services',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE',
					},
					{
						name: 'FK_a9ec6417e1504e7a561ab369be8',
						columnNames: ['libraryId'],
						referencedTableName: 'libraries',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE',
					},
				],
			}),

			new Table({
				name: 'media_landings',
				columns: [
					...stamps,
					this._id(),
					{ name: 'itemId', type: 'varchar' },
					{ name: 'transferId', type: 'varchar', isNullable: true },
					{ name: 'libraryId', type: 'varchar', isNullable: true },
					{ name: 'path', type: 'varchar' },
					{ name: 'bytes', type: 'bigint', default: '0' },
					{ name: 'contentId', type: 'varchar', isNullable: true },
					{ name: 'state', type: 'varchar', default: "'waiting'" },
					{ name: 'expiresAt', type: dateTime },
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

			new Table({
				name: 'media_matches',
				columns: [
					...stamps,
					this._id(),
					{ name: 'localItemId', type: 'varchar', isNullable: true },
					{ name: 'remoteItemId', type: 'varchar' },
					{ name: 'remoteServiceId', type: 'varchar' },
					{ name: 'remotePeerId', type: 'varchar', isNullable: true },
					{ name: 'strategy', type: 'varchar' },
					{ name: 'confidence', type: 'float', default: '0' },
					{ name: 'state', type: 'varchar', default: "'unknown'" },
					{ name: 'reason', type: 'varchar', isNullable: true },
					{ name: 'confirmedAt', type: dateTime, isNullable: true },
				],
				indices: [
					{ name: 'IDX_4fa7b69b536af59727b41fdc1e', columnNames: ['localItemId'] },
					{ name: 'IDX_473ce98282dd72f3020da5c1c5', columnNames: ['remoteItemId'] },
					{
						name: 'IDX_a10c8010bfdc5d0287d77585f4',
						columnNames: ['remoteServiceId'],
					},
					{
						name: 'IDX_046e03dec377db3ebbe065c370',
						columnNames: ['localItemId', 'remoteItemId'],
						isUnique: true,
					},
				],
			}),

			new Table({
				name: 'notification_channels',
				columns: [
					...stamps,
					this._id(),
					{ name: 'type', type: 'varchar' },
					{ name: 'name', type: 'varchar' },
					{ name: 'enabled', type: 'boolean', default: yes },
					{ name: 'events', type: 'text', default: "'[]'" },
					{ name: 'config', type: 'text', default: "'{}'" },
					{ name: 'lastError', type: 'varchar', length: '1024', isNullable: true },
					{ name: 'lastSentAt', type: dateTime, isNullable: true },
				],
			}),

			new Table({
				name: 'peer_invites',
				columns: [
					...stamps,
					this._id(),
					{ name: 'code', type: 'varchar' },
					{ name: 'secretHash', type: 'varchar' },
					{ name: 'expiresAt', type: dateTime },
					{ name: 'usedAt', type: dateTime, isNullable: true },
					{ name: 'peerId', type: 'varchar', isNullable: true },
				],
				indices: [
					{
						name: 'IDX_6dc4118bea17b0e33d11de6738',
						columnNames: ['code'],
						isUnique: true,
					},
				],
			}),

			new Table({
				name: 'revalidations',
				columns: [
					...stamps,
					this._id(),
					{ name: 'transferId', type: 'varchar' },
					{ name: 'sourceServiceId', type: 'varchar' },
					{ name: 'cause', type: 'varchar' },
					{ name: 'requestedAt', type: dateTime },
					{ name: 'answeredAt', type: dateTime, isNullable: true },
					{ name: 'outcome', type: 'varchar', isNullable: true },
					{ name: 'remoteFile', type: 'text', isNullable: true },
					{ name: 'action', type: 'varchar', isNullable: true },
					{ name: 'note', type: 'varchar', isNullable: true },
				],
				indices: [
					{ name: 'IDX_c3e681d1dc7cc48ab6e5f05ab2', columnNames: ['transferId'] },
				],
			}),

			new Table({
				name: 'users',
				columns: [
					...stamps,
					this._id(),
					{ name: 'username', type: 'varchar' },
					{ name: 'displayName', type: 'varchar', isNullable: true },
					{ name: 'email', type: 'varchar', isNullable: true },
					{ name: 'role', type: 'varchar', default: "'user'" },
					{ name: 'provider', type: 'varchar', default: "'internal'" },
					{ name: 'providerUserId', type: 'varchar', isNullable: true },
					{ name: 'avatarUrl', type: 'varchar', isNullable: true },
					{ name: 'passwordHash', type: 'varchar', isNullable: true },
					{ name: 'lastSeenAt', type: dateTime, isNullable: true },
				],
				uniques: [
					{ name: 'UQ_fe0bb3f6520ee0469504521e710', columnNames: ['username'] },
				],
				indices: [
					// Partial, because the pair only identifies an account when it comes
					// from a provider. Every internal account has a null
					// `providerUserId`, and a plain unique index would let exactly one
					// of them exist.
					{
						name: 'IDX_f169c7db87c3a6168aaa74f449',
						columnNames: ['provider', 'providerUserId'],
						isUnique: true,
						where: '"providerUserId" IS NOT NULL',
					},
				],
			}),

			new Table({
				name: 'sessions',
				columns: [
					...stamps,
					this._id(),
					{ name: 'userId', type: 'varchar' },
					{ name: 'refreshTokenHash', type: 'varchar' },
					{ name: 'expiresAt', type: dateTime },
					{ name: 'userAgent', type: 'varchar', isNullable: true },
					{ name: 'address', type: 'varchar', isNullable: true },
					{ name: 'revokedAt', type: dateTime, isNullable: true },
				],
				indices: [
					{ name: 'IDX_57de40bc620f456c7311aa3a1e', columnNames: ['userId'] },
					{
						name: 'IDX_b08788ca45cbd90f0bd96c2f07',
						columnNames: ['refreshTokenHash'],
						isUnique: true,
					},
				],
				foreignKeys: [
					{
						name: 'FK_57de40bc620f456c7311aa3a1e6',
						columnNames: ['userId'],
						referencedTableName: 'users',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE',
					},
				],
			}),

			// Key/value rather than a column per setting, which is what lets a gateway
			// running an older image find a key it does not know and use its default
			// instead of failing to start.
			new Table({
				name: 'settings',
				columns: [
					...stamps,
					{ name: 'key', type: 'varchar', isPrimary: true },
					{ name: 'value', type: 'text' },
				],
			}),

			new Table({
				name: 'share_policies',
				columns: [
					...stamps,
					this._id(),
					{ name: 'libraryId', type: 'varchar' },
					{ name: 'visibility', type: 'varchar', default: "'private'" },
					{ name: 'allowedPeerIds', type: 'text', default: "'[]'" },
					{ name: 'deniedPeerIds', type: 'text', default: "'[]'" },
					{ name: 'rateLimit', type: 'bigint', default: '0' },
				],
				indices: [
					{
						name: 'IDX_ab3d3f1d4e6cbb8819ee2b8688',
						columnNames: ['libraryId'],
						isUnique: true,
					},
				],
			}),

			new Table({
				name: 'sync_plans',
				columns: [
					...stamps,
					this._id(),
					{ name: 'name', type: 'varchar' },
					{ name: 'enabled', type: 'boolean', default: yes },
					{ name: 'trigger', type: 'varchar', default: "'manual'" },
					{ name: 'schedule', type: 'varchar', isNullable: true },
					{ name: 'sourceServiceIds', type: 'text', default: "'[]'" },
					{ name: 'preferredLibraryId', type: 'varchar', isNullable: true },
					{ name: 'scope', type: 'text', default: "'{}'" },
					{ name: 'filter', type: 'text', default: "'{}'" },
					{ name: 'maxItemsPerRun', type: 'integer', isNullable: true },
					{ name: 'maxBytesPerRun', type: 'bigint', isNullable: true },
					{ name: 'lastRunAt', type: dateTime, isNullable: true },
					{ name: 'nextRunAt', type: dateTime, isNullable: true },
				],
			}),

			new Table({
				name: 'sync_jobs',
				columns: [
					...stamps,
					this._id(),
					{ name: 'planId', type: 'varchar', isNullable: true },
					{ name: 'state', type: 'varchar', default: "'pending'" },
					{ name: 'trigger', type: 'varchar', default: "'manual'" },
					{ name: 'startedAt', type: dateTime, isNullable: true },
					{ name: 'finishedAt', type: dateTime, isNullable: true },
					{ name: 'itemsPlanned', type: 'integer', default: '0' },
					{ name: 'itemsDone', type: 'integer', default: '0' },
					{ name: 'itemsFailed', type: 'integer', default: '0' },
					{ name: 'bytesPlanned', type: 'bigint', default: '0' },
					{ name: 'bytesDone', type: 'bigint', default: '0' },
					{ name: 'scope', type: 'text', default: "'{}'" },
					{ name: 'targets', type: 'text', default: "'[]'" },
					{ name: 'stoppedBy', type: 'varchar', isNullable: true },
					{ name: 'error', type: 'varchar', isNullable: true },
				],
				indices: [
					{ name: 'IDX_1420e73d6f8d9fc0f24dec1e8c', columnNames: ['planId'] },
					{ name: 'IDX_bac91af47c1a6b3d3d4d9deb65', columnNames: ['state'] },
				],
			}),

			new Table({
				name: 'sync_job_items',
				columns: [
					...stamps,
					this._id(),
					{ name: 'jobId', type: 'varchar' },
					{ name: 'position', type: 'integer', default: '0' },
					{ name: 'itemId', type: 'varchar' },
					{ name: 'title', type: 'varchar' },
					{ name: 'kind', type: 'varchar' },
					{ name: 'sourceServiceId', type: 'varchar' },
					{ name: 'sourceServiceName', type: 'varchar', default: "''" },
					{ name: 'targetLibraryId', type: 'varchar', isNullable: true },
					{ name: 'targetPath', type: 'varchar' },
					{ name: 'placedBy', type: 'varchar', isNullable: true },
					{ name: 'bytes', type: 'bigint', default: '0' },
					{ name: 'bytesDone', type: 'bigint', default: '0' },
					{ name: 'state', type: 'varchar', default: "'pending'" },
					{ name: 'transferId', type: 'varchar', isNullable: true },
					{ name: 'error', type: 'varchar', isNullable: true },
					{ name: 'startedAt', type: dateTime, isNullable: true },
					{ name: 'finishedAt', type: dateTime, isNullable: true },
				],
				indices: [
					{ name: 'IDX_6370278db8ebfcbdc495d0c8e2', columnNames: ['jobId'] },
					{ name: 'IDX_04ef300a7935dc54058d371c7c', columnNames: ['state'] },
					{ name: 'IDX_7587c24a8959e42ef880c1bf1f', columnNames: ['transferId'] },
				],
			}),

			new Table({
				name: 'transfers',
				columns: [
					...stamps,
					this._id(),
					{ name: 'jobId', type: 'varchar', isNullable: true },
					{ name: 'itemId', type: 'varchar' },
					{ name: 'contentId', type: 'varchar', isNullable: true },
					{ name: 'title', type: 'varchar' },
					{ name: 'state', type: 'varchar', default: "'queued'" },
					{ name: 'targetPath', type: 'varchar' },
					{ name: 'targetLibraryId', type: 'varchar', isNullable: true },
					{ name: 'placedBy', type: 'varchar', isNullable: true },
					{ name: 'workPath', type: 'varchar' },
					// `bigint` rather than `integer`: a season of 4K episodes goes past
					// two gigabytes per file, and a counter that wraps at 2^31 turns
					// into a negative progress bar rather than an error anybody notices.
					{ name: 'bytesTotal', type: 'bigint', default: '0' },
					{ name: 'bytesDone', type: 'bigint', default: '0' },
					{ name: 'chunkSize', type: 'integer', default: '0' },
					{ name: 'chunksTotal', type: 'integer', default: '0' },
					{ name: 'chunksRepaired', type: 'integer', default: '0' },
					{ name: 'error', type: 'varchar', isNullable: true },
					{ name: 'errorKind', type: 'varchar', isNullable: true },
					{ name: 'lastVerifiedAt', type: dateTime, isNullable: true },
					{ name: 'startedAt', type: dateTime, isNullable: true },
					{ name: 'finishedAt', type: dateTime, isNullable: true },
				],
				indices: [
					{ name: 'IDX_3484444ef283e98e74093239eb', columnNames: ['jobId'] },
					{ name: 'IDX_d4efe2f7e8dd8676c071081f43', columnNames: ['itemId'] },
					{ name: 'IDX_ddea8c0ec057f199c3a73a3a4c', columnNames: ['contentId'] },
					{ name: 'IDX_6a5d5f384b8359bafbed40931f', columnNames: ['state'] },
					{ name: 'IDX_4e3c7f9867f761e8f44ca1faed', columnNames: ['placedBy'] },
				],
			}),

			// No creation or update stamp: a chunk is written once per attempt and read
			// by index, and a row per chunk of every transfer is the one table where
			// two extra columns are worth counting.
			new Table({
				name: 'transfer_chunks',
				columns: [
					this._id(),
					{ name: 'transferId', type: 'varchar' },
					{ name: 'index', type: 'integer' },
					{ name: 'start', type: 'bigint' },
					{ name: 'end', type: 'bigint' },
					{ name: 'state', type: 'varchar', default: "'pending'" },
					{ name: 'bytesDone', type: 'bigint', default: '0' },
					{ name: 'sourceServiceId', type: 'varchar', isNullable: true },
					{ name: 'attempts', type: 'integer', default: '0' },
					{ name: 'checksum', type: 'varchar', isNullable: true },
				],
				indices: [
					{ name: 'IDX_86fc863f4b89521400855c7624', columnNames: ['transferId'] },
					{
						name: 'IDX_d694cedb3ff8ca21425e0cd7ce',
						columnNames: ['transferId', 'index'],
						isUnique: true,
					},
				],
			}),
		];
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		for (const table of this._tables(queryRunner)) {
			await queryRunner.createTable(table, true);
		}
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Reversed, so that a table is never dropped while another still points at it.
		for (const table of this._tables(queryRunner).reverse()) {
			await queryRunner.dropTable(table.name, true);
		}
	}
}
