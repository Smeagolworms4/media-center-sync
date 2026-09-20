/**
 * Browsing the directories the gateway itself can see.
 *
 * Every local path in this product — a service's `localRoot`, a library's
 * `localPath`, the fixed placement path, the fallback target — is a directory as the
 * gateway reaches it, and typing one by hand is where the worst failure starts: a
 * path that does not designate the directory the media server reads accepts transfers
 * the server never sees, and nothing anywhere reports an error. This is the assist
 * that lets somebody point at a directory instead of spelling it.
 *
 * Read-only by design. Nothing here creates, renames or deletes anything.
 */

/** One directory inside the listed one. */
export interface DirectoryEntry {
	/** The directory's own name, never a path — the interface renders this. */
	name: string;
	/** The absolute path, resolved, which is what gets written into a field. */
	path: string;
	readable: boolean;
	/**
	 * Whether the gateway can write into it.
	 *
	 * Carried per entry because offering an unwritable directory as a target is worse
	 * than offering no browser at all: the field would then hold a path that looks
	 * chosen rather than typed, and the transfer that lands nowhere is the same
	 * silent failure with more confidence behind it.
	 */
	writable: boolean;
}

/** One directory, its parent, and what is directly under it. */
export interface DirectoryListing {
	/** The listed directory, after resolution — symlinks followed, `..` collapsed. */
	path: string;
	/**
	 * The directory above, or null when going up would leave the allowed roots.
	 *
	 * Null is what stops the interface from offering a step it would be refused for,
	 * rather than letting somebody discover the boundary by receiving an error.
	 */
	parent: string | null;
	readable: boolean;
	writable: boolean;
	entries: DirectoryEntry[];
	/**
	 * True when the directory holds more than `limit` directories and the rest were
	 * dropped.
	 *
	 * Said out loud because a silently shortened list is indistinguishable from a
	 * complete one, and somebody would look for a directory that is there and conclude
	 * it is not.
	 */
	truncated: boolean;
	/** How many entries the gateway was willing to return. */
	limit: number;
	/** The roots a browse may not leave, offered as the starting points. */
	roots: string[];
}
