import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * How long to wait before the first retry.
 *
 * Short, because most drops are a router or a container restarting and the friend is
 * back within seconds. Not zero: a link that failed during the handshake fails the
 * same way immediately after, and an instant retry is a loop rather than a retry.
 */
export const RECONNECT_FIRST_DELAY_MS = 5_000;

/**
 * The cap, and the reason the backoff is capped rather than merely exponential.
 *
 * Uncapped doubling means a friend whose gateway is off for the night is retried
 * after four hours, then eight — so their coming back at nine in the morning is
 * noticed some time in the afternoon. Fifteen minutes is short enough that a
 * gateway back online is picked up over a cup of tea, and long enough that a friend
 * switched off for a week costs us ninety-six pointless dials a day rather than
 * seventeen thousand.
 */
export const RECONNECT_MAX_DELAY_MS = 15 * 60_000;

/**
 * How long to wait before attempt number `attempt`, counting from one.
 *
 * Exported and pure so the schedule can be asserted without a clock or a socket: the
 * sequence is the whole behaviour, and a test that could only observe it through
 * timers would be testing `setTimeout`.
 *
 * Deliberately without jitter. Jitter exists to stop a thousand clients stampeding
 * one server; the set here is a handful of friends, so it would buy nothing and cost
 * a schedule nobody can read off a log or predict in a test.
 */
export const reconnectDelay = (attempt: number): number =>
	Math.min(
		RECONNECT_FIRST_DELAY_MS * 2 ** Math.max(0, attempt - 1),
		RECONNECT_MAX_DELAY_MS,
	);

/** What came of dialling a peer, as the retry schedule needs to hear it. */
export enum PeerDialOutcome {
	/** The link is up. Forget the attempts and wait for the next drop. */
	LINKED = 'linked',
	/** Nobody answered. Try again later, further away each time. */
	UNREACHABLE = 'unreachable',
	/**
	 * They answered and said no — a banned key, a peer who rejected us, a protocol
	 * version neither end can speak. Never dialled again on a timer.
	 *
	 * Redialling a refusal is how a gateway gets itself banned for good at the far
	 * end: from over there, a machine that keeps knocking after being told no is
	 * indistinguishable from one trying to get in.
	 */
	REFUSED = 'refused',
}

/** Dial one peer and say what came of it. Registered by whoever owns that decision. */
export type PeerDial = (peerId: string) => Promise<PeerDialOutcome>;

/**
 * Dials peers again after a drop, with a capped exponential backoff.
 *
 * It exists because nothing did. `connect` was called from the button and from a
 * command, so a container restart — which is every image update — left every friend
 * unreachable until a human clicked, and `isLinked` gates both the catalogue and the
 * swarm: a freshly restarted gateway silently had no remote sources at all.
 *
 * It holds timers and counts attempts, and decides nothing else. Whether a peer is
 * still linked, still welcome, and whether the failure was a refusal is answered by
 * the manager through the callback, because those are business questions and this
 * class has no business reading a peer row.
 */
@Injectable()
export class PeerReconnectService implements OnModuleDestroy {
	private readonly _logger = new Logger(PeerReconnectService.name);

	private readonly _timers = new Map<string, NodeJS.Timeout>();
	private readonly _attempts = new Map<string, number>();

	private _dial: PeerDial | null = null;

	/**
	 * Register the one thing that knows how to dial.
	 *
	 * One rather than a list, for the same reason the link service takes one drop
	 * listener: two of them would dial the same peer twice and halve a backoff chosen
	 * to protect somebody else's gateway.
	 */
	public onDial(dial: PeerDial): void {
		this._dial = dial;
	}

	/**
	 * Try this peer again, after the delay its attempt count has earned.
	 *
	 * Replacing rather than adding, because the drop that prompted this may be the
	 * second one reported for the same socket, and two timers for one peer is a
	 * schedule running twice as fast as the one that was written down.
	 */
	public schedule(peerId: string): void {
		const attempt = (this._attempts.get(peerId) ?? 0) + 1;

		this._attempts.set(peerId, attempt);
		this._arm(peerId, reconnectDelay(attempt));
	}

	/**
	 * Dial now, and keep the backoff running if it still fails.
	 *
	 * This is what the button in the interface means since the link redials itself:
	 * not "connect" — that happens anyway — but "try now rather than wait for the next
	 * attempt". The pending timer is dropped first, or the manual attempt and the
	 * scheduled one would race and both be reported.
	 */
	public async now(peerId: string): Promise<PeerDialOutcome> {
		this._clear(peerId);

		return this._attempt(peerId);
	}

	/**
	 * Stop trying, and forget what has been tried.
	 *
	 * Called when a peer is removed or banned. A timer left armed for a deleted row
	 * fires into a `PEER_NOT_FOUND` every fifteen minutes for as long as the process
	 * lives.
	 */
	public cancel(peerId: string): void {
		this._clear(peerId);
		this._attempts.delete(peerId);
	}

	/** How many attempts have failed in a row, for a log line or a test. */
	public attempts(peerId: string): number {
		return this._attempts.get(peerId) ?? 0;
	}

	public onModuleDestroy(): void {
		for (const peerId of [...this._timers.keys()]) {
			this._clear(peerId);
		}

		this._attempts.clear();
	}

	private _arm(peerId: string, delay: number): void {
		this._clear(peerId);

		const timer = setTimeout(() => {
			this._timers.delete(peerId);
			void this._attempt(peerId);
		}, delay);

		// `unref` so a peer that is off for the night cannot hold the process open
		// through a shutdown: a pending reconnection is never a reason to keep running.
		timer.unref?.();

		this._timers.set(peerId, timer);
	}

	private async _attempt(peerId: string): Promise<PeerDialOutcome> {
		if (this._dial === null) {
			// Nothing registered means nothing can dial, and pretending otherwise would
			// leave the caller believing a retry is scheduled.
			return PeerDialOutcome.REFUSED;
		}

		let outcome: PeerDialOutcome;

		try {
			outcome = await this._dial(peerId);
		} catch (error) {
			// A dial that threw where it should have answered is a bug above, not a
			// reason to give up on a friend for the rest of the process's life.
			this._logger.warn(`Reconnection to peer ${peerId} failed oddly: ${String(error)}`);
			outcome = PeerDialOutcome.UNREACHABLE;
		}

		if (outcome === PeerDialOutcome.LINKED) {
			this._attempts.delete(peerId);

			return outcome;
		}

		if (outcome === PeerDialOutcome.REFUSED) {
			// Deliberately not rescheduled. Somebody pressing the button gets one more
			// attempt, because that is a person deciding; a timer doing it is the
			// gateway insisting after being told no.
			this.cancel(peerId);

			return outcome;
		}

		this.schedule(peerId);

		return outcome;
	}

	private _clear(peerId: string): void {
		const timer = this._timers.get(peerId);

		if (timer !== undefined) {
			clearTimeout(timer);
			this._timers.delete(peerId);
		}
	}
}
