import { BandwidthService, TokenBucket } from './bandwidth.service';

describe('TokenBucket', () => {
	it('lets everything through when there is no cap', async () => {
		const bucket = new TokenBucket(0);
		const started = Date.now();

		await bucket.take(10_000_000);

		expect(Date.now() - started).toBeLessThan(50);
	});

	it('does not deadlock on a limit smaller than the payment', async () => {
		// The failure this pins down is not slowness, it is a stop: with the ceiling
		// capped at one second's allowance, a limit below one read buffer could never
		// be reached and the transfer waited for ever.
		//
		// The numbers are a ratio, not a scale — one and a half seconds of allowance,
		// so the test proves termination without spending a minute doing it.
		const bucket = new TokenBucket(2_000_000);
		const started = Date.now();

		await expect(bucket.take(3_000_000)).resolves.toBeUndefined();

		// And it really waited: resolving instantly would mean the cap was ignored.
		expect(Date.now() - started).toBeGreaterThan(500);
	});

	it('releases a payment already waiting when the cap is lifted', async () => {
		// Somebody who throttles a transfer, watches it crawl and then removes the
		// limit expects it to resume. Reading the limit once on entry made them wait
		// out the old allowance with nothing saying why.
		const bucket = new TokenBucket(1);
		const paid = bucket.take(1_000_000);

		setTimeout(() => {
			bucket.limit = 0;
		}, 20);

		await expect(paid).resolves.toBeUndefined();
	});

	it('refuses a negative limit rather than inverting the arithmetic', () => {
		const bucket = new TokenBucket(0);

		bucket.limit = -5;

		expect(bucket.limit).toBe(0);
	});
});

describe('BandwidthService', () => {
	it('takes its upload cap from the settings', () => {
		const bandwidth = new BandwidthService();

		bandwidth.apply({ uploadRateLimit: 2_048 } as never);

		expect(bandwidth.upload.limit).toBe(2_048);
	});

	it('charges what it sends', async () => {
		const bandwidth = new BandwidthService();

		bandwidth.apply({ uploadRateLimit: 0 } as never);

		await expect(bandwidth.send(4_096)).resolves.toBeUndefined();
	});
});
