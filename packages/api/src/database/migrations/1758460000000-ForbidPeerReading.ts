import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Blocking a peer becomes forbidding them from reading, and the two are not the same.
 *
 * Blocking set `peers.status` to `blocked` and closed the live link in both
 * directions, which is the defect it is worth recording: punishing somebody also cut
 * off our own access to *their* library, so the action cost more than anybody wanted
 * to pay and the removal got used instead. Forbidding reading keeps the peer, keeps
 * the link open, and serves them nothing of ours — one flag, read in
 * `ShareManager.visiblePolicies`, which every peer-facing route already goes through.
 *
 * **A row that still says `blocked` becomes a linked peer forbidden from reading.**
 * That is the closest true statement about it: somebody decided this peer must see
 * nothing of ours, and that decision survives; they were neither removed nor banned,
 * so they are still a peer. `linked` rather than `unreachable` because the status now
 * describes the relationship and the reconnect loop dials every linked peer — leaving
 * these rows on `unreachable` would have them dialled all the same while every screen
 * in between described a peer nobody had actually failed to reach.
 *
 * `down` cannot restore a distinction the new shape does not carry — a peer merely
 * forbidden from reading was never blocked — so it puts every forbidden peer back on
 * `blocked`, the only status the old code had for "this one sees nothing".
 */
export class ForbidPeerReading1758460000000 implements MigrationInterface {
	/**
	 * How a boolean literal is spelled. SQLite stores them as `0` and `1`, PostgreSQL
	 * as `false` and `true`, and a statement written in the other engine's spelling is
	 * accepted by neither.
	 */
	private _true(queryRunner: QueryRunner): string {
		return queryRunner.connection.options.type === 'postgres' ? 'true' : '1';
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.addColumn(
			'peers',
			new TableColumn({
				name: 'readingForbidden',
				type: 'boolean',
				isNullable: false,
				default: false,
			}),
		);

		await queryRunner.query(
			`UPDATE peers SET "readingForbidden" = ${this._true(queryRunner)}, ` +
				"status = 'linked' WHERE status = 'blocked'",
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`UPDATE peers SET status = 'blocked' WHERE "readingForbidden" = ${this._true(queryRunner)}`,
		);
		await queryRunner.dropColumn('peers', 'readingForbidden');
	}
}
