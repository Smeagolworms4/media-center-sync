import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Library } from './library.entity';
import { Timestampable } from './timestampable.entity';

/**
 * A library name that files itself into one of our categories.
 *
 * Anchored on a library and not on a category key, which is the decision this table
 * exists to record. A category has no row of its own: it is derived from the names
 * the libraries read as, so its key changes the moment somebody renames the library
 * it was named after. A list stored under `shows` would be orphaned by exactly the
 * rename it is supposed to survive. A library identifier survives a rename — the
 * alias moves, the row does not — and survives a rescan, because a scan matches rows
 * on `(serviceId, externalId)` and updates them in place rather than replacing them.
 *
 * The anchor is deleted with its library, on purpose: if the service holding our
 * `Shows` is unregistered, the category it defined is gone and keywords pointing at
 * it would file friends' shelves into a name nothing here answers to any more.
 */
@Entity('category_keywords')
export class CategoryKeyword extends Timestampable {
	@ApiProperty()
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	@ManyToOne(() => Library, { onDelete: 'CASCADE', nullable: false })
	public library!: Library;

	/** The library whose category this keyword files into. See the note above. */
	@ApiProperty()
	@Index()
	@Column({ type: 'uuid' })
	public libraryId!: string;

	/**
	 * What somebody typed or dropped, kept as they wrote it.
	 *
	 * Stored beside the folded form rather than instead of it, because `Émissions TV`
	 * is what they recognise on screen and `emissions-tv` is what they would have to
	 * decipher. Nothing ever matches on this column.
	 */
	@ApiProperty()
	@Column()
	public keyword!: string;

	/**
	 * The folded form every comparison runs on — `categoryKeyOf` in `@mcs/shared`.
	 *
	 * Unique across the table, and that is a rule rather than a tidiness: two
	 * categories claiming `tv` would file a shelf into whichever row came back first,
	 * and that answer would differ between two identical requests. The unique index
	 * makes a second claim fail loudly at the moment somebody makes it.
	 */
	@ApiProperty()
	@Index({ unique: true })
	@Column()
	public normalized!: string;
}
