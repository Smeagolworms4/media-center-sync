import { Injectable } from '@nestjs/common';
import type { Settings } from '@mcs/shared';

/**
 * A token bucket, shared by everything that moves bytes in one direction.
 *
 * The only way several connections respect one number is if they all draw from the
 * same bucket, so this is a single object rather than a limit handed to each worker.
 */
export class TokenBucket {
	private _tokens = 0;
	private _last = Date.now();

	public constructor(private _bytesPerSecond = 0) {}

	public get limit(): number {
		return this._bytesPerSecond;
	}

	public set limit(bytesPerSecond: number) {
		this._bytesPerSecond = Math.max(0, bytesPerSecond);
	}

	/**
	 * Pay for a chunk, waiting until the bucket can afford it.
	 *
	 * The limit is re-read every turn rather than once on entry, and both readings
	 * matter. Lifting the cap has to release whoever is already waiting — somebody who
	 * throttles a transfer, watches it crawl and then removes the limit would otherwise
	 * wait out the old allowance with nothing saying why. And the ceiling is never
	 * below the payment being made: capped at one second's allowance, a limit smaller
	 * than one buffer could never be reached, and the transfer would not slow down, it
	 * would stop forever.
	 */
	public async take(bytes: number): Promise<void> {
		for (;;) {
			if (this._bytesPerSecond <= 0) {
				return;
			}

			const now = Date.now();

			this._tokens = Math.min(
				Math.max(this._bytesPerSecond, bytes),
				this._tokens + ((now - this._last) / 1000) * this._bytesPerSecond,
			);
			this._last = now;

			if (this._tokens >= bytes) {
				this._tokens -= bytes;

				return;
			}

			const missing = bytes - this._tokens;
			const waitMs = Math.max(5, (missing / this._bytesPerSecond) * 1000);

			await new Promise((resolve) => {
				setTimeout(resolve, Math.min(waitMs, 250));
			});
		}
	}
}

/**
 * What the gateway is allowed to send out, across everything at once.
 *
 * Download has its cap inside the transfer engine, where the workers that spend it
 * live. Upload has nowhere equivalent: bytes leave through the peer endpoint, one
 * request at a time, with no queue and no engine. A setting that exists and throttles
 * nothing is worse than no setting, so the bucket lives here and the serving path
 * draws from it.
 *
 * Both caps are in bytes per second and zero means no cap, matching what the settings
 * screen shows and what every torrent client has taught people to expect.
 */
@Injectable()
export class BandwidthService {
	public readonly upload = new TokenBucket();

	public apply(settings: Settings): void {
		this.upload.limit = settings.uploadRateLimit;
	}

	/**
	 * Throttle a stream of outgoing bytes.
	 *
	 * Called per chunk rather than per response: a peer pulling a forty-gigabyte file
	 * would otherwise pay once, at the start, and then send the whole thing at line
	 * rate.
	 */
	public async send(bytes: number): Promise<void> {
		await this.upload.take(bytes);
	}
}
