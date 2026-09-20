import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Where a gateway can say something happened while nobody was looking.
 *
 * A table rather than a handful of settings, and the reason is what people actually
 * have: a phone topic and a shared mailbox at the same time, two people who want
 * different events, and one of them silencing theirs for a week. None of that fits a
 * key/value row, and every bit of it is ordinary.
 *
 * `config` is `text` holding JSON, which is what TypeORM stores a `simple-json`
 * column as on both engines. It is deliberately opaque here: a column per channel
 * setting would mean a migration for every channel type added, and this whole
 * feature exists so that the third one is a class and nothing else.
 *
 * `lastError` and `lastSentAt` are the point of the row as much as the settings are.
 * A channel that fails silently is a channel nobody can trust, and without somewhere
 * to write the failure the only symptom is a notification that never arrives — which
 * is indistinguishable from nothing having happened.
 */
export class NotificationChannels1758430000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.createTable(
			new Table({
				name: 'notification_channels',
				columns: [
					{ name: 'id', type: 'varchar', length: '36', isPrimary: true },
					{ name: 'type', type: 'varchar', isNullable: false },
					{ name: 'name', type: 'varchar', isNullable: false },
					// On by default: somebody who has just added a channel meant it to
					// work, and a row that has to be switched on afterwards is a channel
					// that stays silent for a week before anybody notices the switch.
					{ name: 'enabled', type: 'boolean', isNullable: false, default: true },
					// An empty list means every event, as the contract states. Storing
					// the full list instead would freeze a channel's choice at the
					// events this version knows, and adding one later would leave every
					// existing channel quietly not subscribed to it.
					{ name: 'events', type: 'text', isNullable: false, default: "'[]'" },
					{ name: 'config', type: 'text', isNullable: false, default: "'{}'" },
					{ name: 'lastError', type: 'varchar', length: '1024', isNullable: true },
					{ name: 'lastSentAt', type: 'datetime', isNullable: true },
					{ name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
					{ name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
				],
			}),
			true,
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.dropTable('notification_channels', true);
	}
}
