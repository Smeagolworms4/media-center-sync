import { Column, Entity, PrimaryColumn } from 'typeorm';
import { Timestampable } from './timestampable.entity';

/**
 * Settings, one row per key.
 *
 * A key–value table rather than a single row with one column per setting: adding a
 * setting then costs a write, not a migration, and a gateway that pulls a newer
 * image simply finds a key it does not know yet and falls back to its default.
 */
@Entity('settings')
export class Setting extends Timestampable {
	@PrimaryColumn()
	public key!: string;

	/** JSON-encoded, because settings are not all strings. */
	@Column({ type: 'text' })
	public value!: string;
}
