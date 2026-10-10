/**
 * What every connection to the SQLite file tells the driver about itself.
 *
 * In one place because there are now three connections — the gateway's, the read
 * pool's and the jobs worker's — and a pragma set on one of them is a setting the other
 * two do not have. They are per *connection*, not per file: only `journal_mode` is a
 * property of the file, which is why it is not in this list.
 *
 * The numbers here are about a household's hardware rather than about SQLite. This
 * product's own gateway runs on a Raspberry Pi whose database sits on an SD card, and
 * the owner's measurements over fifty-one minutes were 2.5 GB read and 1.4 GB written
 * for a catalogue of thirty-one thousand rows that nobody was scanning. An SD card has
 * a finite number of writes in it, so each of these is a line about not spending them.
 */
export const CONNECTION_PRAGMAS = [
	/*
	 * A writer somebody is willing to wait for.
	 *
	 * Without it a contended write fails instantly rather than waiting, so the rare
	 * overlap — a checkpoint, a migration — surfaces as an error to somebody clicking
	 * rather than as five milliseconds nobody perceives.
	 */
	'busy_timeout = 5000',
	/*
	 * Sixteen megabytes of pages, against SQLite's own default of two.
	 *
	 * Negative means kibibytes rather than pages, which is the only spelling that means
	 * the same thing whatever the page size. The catalogue read walks every row in scope
	 * — thirty-one thousand on the owner's — and at two megabytes the same pages were
	 * read from the card again on every pass. This is the cheapest answer there is to
	 * 2.5 GB of reads: hold the table instead of fetching it.
	 *
	 * Sixteen and not more because it is per connection and there are three of them, so
	 * this is forty-eight megabytes of ceiling on a gateway that already wants a
	 * gigabyte.
	 */
	'cache_size = -16000',
	/*
	 * Sort in memory, not on the card.
	 *
	 * SQLite's default is a *file* for the temporary B-trees an `ORDER BY` needs when it
	 * cannot be answered from an index — and the catalogue read sorts its whole scope
	 * before paging it. So the single most frequent read in this product was also
	 * writing, every time, to the one storage medium that wears out. Nothing here needs
	 * a temporary table to survive anything, which is what makes this free.
	 */
	'temp_store = MEMORY',
] as const;

/**
 * What only the connection that writes sets.
 *
 * `NORMAL` rather than WAL's default `FULL`: a commit no longer waits for the card to
 * confirm the write-ahead log. What that gives up is precise — the last few
 * transactions in the event the *machine* loses power or the kernel panics — and what
 * it buys is the fsync per commit, which on an SD card is the difference between
 * writing a page and rewriting an erase block. An application crash, an OOM kill, a
 * `docker stop`: all still safe, because the data is in the operating system's hands
 * before the commit returns. This product writes a media index that a rescan rebuilds,
 * not a ledger.
 */
export const WRITER_PRAGMAS = ['synchronous = NORMAL'] as const;
