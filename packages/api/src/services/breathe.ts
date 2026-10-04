/**
 * How many units of work pass between two turns of the event loop.
 *
 * Fifty, measured against what one unit costs: small enough that a request waits a few
 * milliseconds at worst, large enough that the yield itself is noise beside the work it
 * interrupts.
 */
const UNITS_PER_BREATH = 50;

/**
 * Hand the event loop back, so the gateway keeps answering while a long pass runs.
 *
 * This is not belt and braces, it is the difference between a server and a dead socket.
 * **`await` does not yield to the event loop**: it drains the *microtask* queue, while
 * reading an incoming connection is a *macrotask*. A pass over a catalogue is a loop of
 * thousands of rows whose awaits mostly resolve at once — metadata already cached, and
 * `better-sqlite3`, which is synchronous by design — so the loop never reaches the poll
 * phase and no socket is ever read. The process is busy, not slow: health checks time
 * out and the container is marked unhealthy while the work is going perfectly well.
 *
 * `setImmediate` is a macrotask, so awaiting one does reach the poll phase and lets
 * every pending request be served before the next batch. It is not a worker thread and
 * does not pretend to be: the work still runs on this thread and one synchronous query
 * still blocks for its own duration. What it buys is that the *queue* of them is
 * interruptible, which is what the server needed.
 *
 * It lives here rather than beside one caller because the first version of it did, and
 * that was the mistake: the walk yielded and the passes that follow it — correlation,
 * refiling, the summaries — did not, so a scan went from blocking for twenty minutes to
 * blocking in bursts of ten seconds and the symptom looked fixed.
 */
export const breathe = (units: number): Promise<void> =>
	units % UNITS_PER_BREATH === 0
		? new Promise<void>((resolve) => setImmediate(resolve))
		: Promise.resolve();
