import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { GrabState, type GrabPlacement } from '@mcs/shared';
import { Timestampable } from './timestampable.entity';

/**
 * One release handed to a download client, and what became of it.
 *
 * Stored rather than read back from the client, and that is the whole reason this table
 * exists: a torrent client knows it is downloading `Spartacus.S03E08.1080p-GRP` and has
 * never heard of the media it is for. Nothing else in the product could then file the
 * file when it arrives — the link between a hash in qBittorrent and a row in our
 * catalogue lives here and nowhere else, and it has to survive a restart of either.
 *
 * It also survives the client forgetting: somebody who clears their torrent list still
 * has a record of what was grabbed and whether it was ever placed, which is the
 * difference between "that download failed" and "I have no idea what happened to it".
 */
@Entity('release_grabs')
export class ReleaseGrab extends Timestampable {
	@PrimaryGeneratedColumn('uuid')
	public id!: string;

	/** The media this is for. What the file is filed as, once it has arrived. */
	@Index()
	@Column({ type: 'uuid' })
	public itemId!: string;

	/** The release name, which is what somebody recognises in the client's own list. */
	@Column({ type: 'varchar' })
	public title!: string;

	@Column({ type: 'varchar' })
	public indexer!: string;

	@Index()
	@Column({ type: 'varchar' })
	public state!: GrabState;

	/**
	 * The client's own identifier — an info hash for a torrent.
	 *
	 * Nullable because a grab exists before the client has accepted it, and a row with
	 * no hash is exactly the state worth being able to see: it says the client was
	 * asked and said nothing useful back.
	 */
	@Index()
	@Column({ type: 'varchar', nullable: true })
	public clientId!: string | null;

	@Column({ type: 'bigint', default: 0 })
	public bytesDone!: number;

	@Column({ type: 'bigint', default: 0 })
	public bytesTotal!: number;

	/**
	 * Where the client wrote it, as *this gateway* sees the path.
	 *
	 * Translated on the way in rather than stored in the client's spelling: the client
	 * says `/downloads/Show.S01E01` and the gateway reaches the same directory at
	 * `/share/torrents/Show.S01E01`. Storing theirs would mean every later reader has to
	 * remember to translate, and the one that forgets finds nothing and reports nothing.
	 */
	@Column({ type: 'varchar', nullable: true })
	public sourcePath!: string | null;

	/** Where it ended up in the library, once it has been filed. */
	@Column({ type: 'varchar', nullable: true })
	public targetPath!: string | null;

	/**
	 * Where somebody said it should land, if anybody did.
	 *
	 * Null is the ordinary case and means the placement chain decides, exactly as it
	 * does for a pull: a series we already hold keeps its folder, then the category,
	 * then the default. A value here is the same statement a redirected transfer makes.
	 */
	@Column({ type: 'varchar', nullable: true })
	public targetLibraryId!: string | null;

	@Column({ type: 'varchar', nullable: true })
	public targetFolder!: string | null;

	/**
	 * Whether only part of this release was asked for.
	 *
	 * A column and not a deduction. It was inferred from "every placement has no file
	 * name yet", which is also exactly what a whole-release grab looks like on its first
	 * pass — so the gateway chose files on torrents it had never paused, and on a film
	 * it selected whichever file parsed to no episode first. A sample, a proof image or
	 * an `.nfo` all parse to no episode, so the download completed on junk and the film
	 * was deselected.
	 */
	@Column({ type: 'boolean', default: false })
	public partial!: boolean;

	@Column({ type: 'varchar', nullable: true })
	public error!: string | null;

	/**
	 * The episodes this grab was taken for, and where each one landed.
	 *
	 * A pack brings several files and each is filed against its own episode, so one
	 * `targetPath` could not say where anything went. It is also what the file selection
	 * is rebuilt from when the client finally produces a file list — which happens after
	 * the grab, in a later pass, possibly after a restart.
	 *
	 * `simple-json`, so the column is `text` on both engines.
	 */
	@Column({ type: 'simple-json', nullable: true })
	public placements!: GrabPlacement[] | null;
}
