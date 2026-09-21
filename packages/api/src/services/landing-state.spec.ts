import { DEFAULT_LANDING_GRACE_MS, landingGraceMs } from './landing-state';

/**
 * The test hook that shortens the wait before a landing reads `not_indexed`.
 *
 * What matters is the direction it fails in: anything that is not a clear positive
 * number of milliseconds must leave the twelve hours in force, because a production
 * gateway with a mistyped variable declaring every download lost within a second would
 * be far worse than a journey that cannot run.
 */
describe('landingGraceMs', () => {
	it('is twelve hours when nothing is set', () => {
		expect(landingGraceMs(undefined)).toBe(DEFAULT_LANDING_GRACE_MS);
		expect(DEFAULT_LANDING_GRACE_MS).toBe(12 * 60 * 60 * 1000);
	});

	it('takes a positive number of milliseconds', () => {
		expect(landingGraceMs('20000')).toBe(20_000);
	});

	it.each(['', '0', '-5', 'soon', '1.5'])('keeps the twelve hours for %p', (raw) => {
		expect(landingGraceMs(raw)).toBe(DEFAULT_LANDING_GRACE_MS);
	});
});
