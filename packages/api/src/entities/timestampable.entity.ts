import { ApiProperty } from '@nestjs/swagger';
import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * Creation and update stamps, on every table.
 *
 * `datetime` rather than `timestamptz`: the same migration has to run on SQLite and
 * on PostgreSQL, and only the types both understand can be used. Everything is
 * stored in UTC and rendered in the browser's zone.
 */
export abstract class Timestampable {
	@ApiProperty()
	@CreateDateColumn({ type: 'datetime' })
	public createdAt!: Date;

	@ApiProperty()
	@UpdateDateColumn({ type: 'datetime' })
	public updatedAt!: Date;
}
