import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * One overloaded column becomes a decision and a fact, and the relay consent goes.
 *
 * `media_services.scope` held `local` or `remote` and was read for three unrelated
 * answers: whether the gateway can write into the service's folders, whether it may be
 * a destination, and whether its libraries follow the gateway's sharing default. Those
 * words name a position on a network, so somebody registering the Jellyfin on their own
 * LAN at the other end of the house answered `remote` and found, three screens later,
 * their libraries private and the server refused as a target — with nothing connecting
 * either consequence to the word they had picked.
 *
 * So it splits:
 *
 * - **`shared`** is the decision, and the only half anybody declares. On means the
 *   gateway's `defaultShareVisibility` reaches this service's libraries; off means
 *   private. `scope = 'local'` becomes true and `remote` becomes false, which is
 *   exactly what those rows meant before this migration — a service registered `local`
 *   followed the default and a `remote` one did not.
 * - **`filesMounted`** is the fact, derived from the mounts and never typed. True when
 *   the service states a `localRoot`, or when any of its libraries carries a
 *   `localPath` of its own — the two ways a mapping gets declared. That is deliberately
 *   *not* `scope = 'local'`: a service registered `local` with nothing mapped could
 *   never write a file, and carrying that claim forward would keep offering it as a
 *   destination for transfers that fail at placement.
 *
 * **`share_policies.relay` is dropped**, and with it the refusal that gated it. It
 * existed to make relaying a library we do not hold an explicit per-library agreement,
 * while the thing it guarded — serving those bytes by reading the media server over
 * HTTP — already worked and needed no local file. The service switch above is now that
 * agreement, said once, in the one place somebody is already deciding about the
 * service. Its only other effect was a `SHARE_RELAY_NOT_AGREED` refusal pointing at a
 * control that was never built.
 *
 * `down` puts `scope` back from `shared`, because that is the pair that meant the same
 * thing; the mount fact has no old column to go back into and is simply dropped. The
 * relay column comes back defaulted false, which is what every row held before anybody
 * could have agreed to anything.
 */
export class ServiceSharingAndMount1758470000000 implements MigrationInterface {
	/**
	 * How a boolean literal is spelled. SQLite stores them as `0` and `1`, PostgreSQL
	 * as `false` and `true`, and a statement written in the other engine's spelling is
	 * accepted by neither.
	 */
	private _bool(queryRunner: QueryRunner, value: boolean): string {
		if (queryRunner.connection.options.type === 'postgres') {
			return value ? 'true' : 'false';
		}

		return value ? '1' : '0';
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'media_services',
			new TableColumn({ name: 'shared', type: 'boolean', isNullable: false, default: true }),
		);
		await queryRunner.addColumn(
			'media_services',
			new TableColumn({
				name: 'filesMounted',
				type: 'boolean',
				isNullable: false,
				default: false,
			}),
		);

		await queryRunner.query(
			`UPDATE media_services SET shared = ${this._bool(queryRunner, false)} ` +
				"WHERE scope <> 'local'",
		);

		await queryRunner.query(
			`UPDATE media_services SET "filesMounted" = ${this._bool(queryRunner, true)} `
				+ 'WHERE ("localRoot" IS NOT NULL AND "localRoot" <> \'\') OR id IN ('
				+ 'SELECT "serviceId" FROM libraries '
				+ 'WHERE "localPath" IS NOT NULL AND "localPath" <> \'\')',
		);

		await queryRunner.dropColumn('media_services', 'scope');
		await queryRunner.dropColumn('share_policies', 'relay');
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'share_policies',
			new TableColumn({ name: 'relay', type: 'boolean', isNullable: false, default: false }),
		);
		await queryRunner.addColumn(
			'media_services',
			new TableColumn({
				name: 'scope',
				type: 'varchar',
				isNullable: false,
				default: "'remote'",
			}),
		);

		await queryRunner.query(
			`UPDATE media_services SET scope = 'local' WHERE shared = ${this._bool(queryRunner, true)}`,
		);

		await queryRunner.dropColumn('media_services', 'filesMounted');
		await queryRunner.dropColumn('media_services', 'shared');
	}
}
