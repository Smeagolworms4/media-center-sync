import {
	PeerDialOutcome,
	PeerReconnectService,
	RECONNECT_FIRST_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
	reconnectDelay,
} from './peer-reconnect.service';

/**
 * The reconnection, without a clock and without a socket.
 *
 * The schedule is a pure function, so the sequence and its cap are asserted
 * directly — a test that could only observe them through timers would be testing
 * `setTimeout`. What the timers are used for is the other half: that a refusal is
 * never rearmed, and that a link coming back forgets the attempts behind it.
 */
describe('reconnectDelay', () => {
	it('doubles from the first delay', () => {
		expect(reconnectDelay(1)).toBe(RECONNECT_FIRST_DELAY_MS);
		expect(reconnectDelay(2)).toBe(RECONNECT_FIRST_DELAY_MS * 2);
		expect(reconnectDelay(3)).toBe(RECONNECT_FIRST_DELAY_MS * 4);
		expect(reconnectDelay(4)).toBe(RECONNECT_FIRST_DELAY_MS * 8);
	});

	it('is the whole schedule, in order, up to and past the cap', () => {
		// Written out because the sequence *is* the behaviour: five seconds to a
		// quarter of an hour, and never further. Uncapped doubling would retry a
		// friend who is off for the night after four hours, then eight, so their
		// coming back at nine in the morning is noticed some time in the afternoon.
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20].map(reconnectDelay)).toEqual([
			5_000,
			10_000,
			20_000,
			40_000,
			80_000,
			160_000,
			320_000,
			640_000,
			900_000,
			900_000,
			900_000,
		]);
	});

	it('never exceeds the cap, however many attempts have failed', () => {
		// 2 ** 1000 is Infinity in floating point. A cap expressed as a minimum holds
		// anyway; one expressed as a modulo or a clamp on the exponent would not.
		expect(reconnectDelay(1_000)).toBe(RECONNECT_MAX_DELAY_MS);
	});

	it('treats a first attempt and a zeroth the same, rather than firing instantly', () => {
		// A link that failed during the handshake fails the same way immediately
		// after, and a zero delay is a loop rather than a retry.
		expect(reconnectDelay(0)).toBe(RECONNECT_FIRST_DELAY_MS);
	});
});

describe('PeerReconnectService', () => {
	let service: PeerReconnectService;

	beforeEach(() => {
		jest.useFakeTimers();
		service = new PeerReconnectService();
	});

	afterEach(() => {
		service.onModuleDestroy();
		jest.useRealTimers();
	});

	it('waits the first delay before trying at all', async () => {
		const dial = jest.fn().mockResolvedValue(PeerDialOutcome.LINKED);

		service.onDial(dial);
		service.schedule('peer-1');

		jest.advanceTimersByTime(RECONNECT_FIRST_DELAY_MS - 1);
		expect(dial).not.toHaveBeenCalled();

		jest.advanceTimersByTime(1);
		await Promise.resolve();
		expect(dial).toHaveBeenCalledWith('peer-1');
	});

	it('walks the schedule while nobody answers', async () => {
		const dial = jest.fn().mockResolvedValue(PeerDialOutcome.UNREACHABLE);

		service.onDial(dial);
		service.schedule('peer-1');

		for (const delay of [reconnectDelay(1), reconnectDelay(2), reconnectDelay(3)]) {
			jest.advanceTimersByTime(delay);
			// Two turns: the timer resolves the dial, and the dial's own promise has to
			// settle before the next timer is armed.
			await Promise.resolve();
			await Promise.resolve();
		}

		expect(dial).toHaveBeenCalledTimes(3);
		expect(service.attempts('peer-1')).toBe(4);
	});

	it('never dials again after a refusal', async () => {
		// The rule this exists for: from the far end, a gateway that keeps knocking
		// after being told no is indistinguishable from one trying to get in, and that
		// is how you get banned there for good.
		const dial = jest.fn().mockResolvedValue(PeerDialOutcome.REFUSED);

		service.onDial(dial);
		service.schedule('peer-1');

		jest.advanceTimersByTime(reconnectDelay(1));
		await Promise.resolve();
		await Promise.resolve();

		expect(dial).toHaveBeenCalledTimes(1);

		jest.advanceTimersByTime(RECONNECT_MAX_DELAY_MS * 10);
		await Promise.resolve();

		expect(dial).toHaveBeenCalledTimes(1);
		expect(service.attempts('peer-1')).toBe(0);
	});

	it('forgets the attempts once a link is back, so the next drop starts short again', async () => {
		const dial = jest
			.fn()
			.mockResolvedValueOnce(PeerDialOutcome.UNREACHABLE)
			.mockResolvedValueOnce(PeerDialOutcome.UNREACHABLE)
			.mockResolvedValue(PeerDialOutcome.LINKED);

		service.onDial(dial);
		service.schedule('peer-1');

		for (const delay of [reconnectDelay(1), reconnectDelay(2), reconnectDelay(3)]) {
			jest.advanceTimersByTime(delay);
			await Promise.resolve();
			await Promise.resolve();
		}

		expect(service.attempts('peer-1')).toBe(0);

		service.schedule('peer-1');
		jest.advanceTimersByTime(RECONNECT_FIRST_DELAY_MS);
		await Promise.resolve();

		expect(dial).toHaveBeenCalledTimes(4);
	});

	it('keeps one timer per peer, however many drops are reported for one socket', async () => {
		// `ws` can report a failure twice. Two timers for one peer is a schedule
		// running at half the delay that was chosen to protect somebody's gateway.
		const dial = jest.fn().mockResolvedValue(PeerDialOutcome.UNREACHABLE);

		service.onDial(dial);
		service.schedule('peer-1');
		service.schedule('peer-1');

		jest.advanceTimersByTime(reconnectDelay(2));
		await Promise.resolve();
		await Promise.resolve();

		expect(dial).toHaveBeenCalledTimes(1);
	});

	it('dials at once when somebody asks, and keeps the backoff running', async () => {
		// What the button means now: not "connect" — that happens anyway — but "try
		// now rather than wait for the next attempt".
		const dial = jest.fn().mockResolvedValue(PeerDialOutcome.UNREACHABLE);

		service.onDial(dial);
		service.schedule('peer-1');

		await expect(service.now('peer-1')).resolves.toBe(PeerDialOutcome.UNREACHABLE);
		expect(dial).toHaveBeenCalledTimes(1);

		jest.advanceTimersByTime(reconnectDelay(2));
		await Promise.resolve();
		await Promise.resolve();

		expect(dial).toHaveBeenCalledTimes(2);
	});

	it('stops trying a peer that has been cancelled', async () => {
		const dial = jest.fn().mockResolvedValue(PeerDialOutcome.UNREACHABLE);

		service.onDial(dial);
		service.schedule('peer-1');
		service.cancel('peer-1');

		jest.advanceTimersByTime(RECONNECT_MAX_DELAY_MS);
		await Promise.resolve();

		expect(dial).not.toHaveBeenCalled();
		expect(service.attempts('peer-1')).toBe(0);
	});

	it('keeps trying a peer whose dial threw where it should have answered', async () => {
		// A bug above is not a reason to give up on a friend for the rest of the
		// process's life.
		const dial = jest.fn().mockRejectedValue(new Error('boom'));

		service.onDial(dial);

		await expect(service.now('peer-1')).resolves.toBe(PeerDialOutcome.UNREACHABLE);
		expect(service.attempts('peer-1')).toBe(1);
	});

	it('drops every timer when the module goes down', async () => {
		const dial = jest.fn().mockResolvedValue(PeerDialOutcome.UNREACHABLE);

		service.onDial(dial);
		service.schedule('peer-1');
		service.schedule('peer-2');
		service.onModuleDestroy();

		jest.advanceTimersByTime(RECONNECT_MAX_DELAY_MS);
		await Promise.resolve();

		expect(dial).not.toHaveBeenCalled();
	});
});
