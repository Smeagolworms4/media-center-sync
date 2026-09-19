import {
	RevalidationAction,
	RevalidationOutcome,
	TransferErrorKind,
	type MediaFileInfo,
} from '@mcs/shared';
import { HandlerRegistry } from './handlers/handler.registry';
import { PeerLinkService } from './peer-link.service';
import {
	MAX_REVALIDATION_ATTEMPTS,
	RevalidationService,
	decideRevalidationAction,
	type RevalidationContext,
} from './revalidation.service';

function context(overrides: Partial<RevalidationContext> = {}): RevalidationContext {
	return {
		cause: TransferErrorKind.NETWORK,
		hasAlternativeSources: false,
		attempt: 1,
		...overrides,
	};
}

function file(overrides: Partial<MediaFileInfo> = {}): MediaFileInfo {
	return {
		path: '/media/Show/S01E01.mkv',
		size: 1_000,
		container: 'mkv',
		videoCodec: 'x265',
		audioCodec: 'eac3',
		width: 1920,
		height: 1080,
		durationMs: 1_000,
		bitrate: 1_000,
		quickHash: 'abc',
		contentId: 'q1-abc',
		checksum: null,
		...overrides,
	};
}

describe('decideRevalidationAction', () => {
	// The whole table, one expectation per cell, because every branch here is a
	// different expensive mistake and a gap is invisible until it costs somebody a
	// thirty-gigabyte re-download.
	describe('confirmed', () => {
		it('repairs our own copy after a checksum mismatch', () => {
			expect(
				decideRevalidationAction(
					RevalidationOutcome.CONFIRMED,
					context({ cause: TransferErrorKind.CHECKSUM_MISMATCH }),
				).action,
			).toBe(RevalidationAction.REPAIR_LOCAL);
		});

		it.each([
			TransferErrorKind.SOURCE_GONE,
			TransferErrorKind.SOURCE_UNAUTHORIZED,
			TransferErrorKind.NETWORK,
			TransferErrorKind.UNKNOWN,
		])('resumes after a transient %s', (cause) => {
			expect(
				decideRevalidationAction(RevalidationOutcome.CONFIRMED, context({ cause })).action,
			).toBe(RevalidationAction.RESUME);
		});

		it.each([
			TransferErrorKind.DISK_FULL,
			TransferErrorKind.PERMISSION_DENIED,
			TransferErrorKind.TARGET_MISSING,
			TransferErrorKind.CANCELLED,
		])('requeues when the failure was ours: %s', (cause) => {
			// The source is fine; nothing about it needs deciding until our own problem
			// clears, and repairing would just fill the disk again.
			expect(
				decideRevalidationAction(RevalidationOutcome.CONFIRMED, context({ cause })).action,
			).toBe(RevalidationAction.REQUEUE);
		});
	});

	describe('moved', () => {
		it.each(Object.values(TransferErrorKind))('follows the move whatever caused it (%s)', (cause) => {
			expect(
				decideRevalidationAction(RevalidationOutcome.MOVED, context({ cause })).action,
			).toBe(RevalidationAction.FOLLOW_MOVE);
		});
	});

	describe('changed', () => {
		it('switches source when somebody else still has the version we started', () => {
			expect(
				decideRevalidationAction(
					RevalidationOutcome.CHANGED,
					context({ hasAlternativeSources: true }),
				).action,
			).toBe(RevalidationAction.SWITCH_SOURCE);
		});

		it('abandons when nobody else has it', () => {
			expect(
				decideRevalidationAction(
					RevalidationOutcome.CHANGED,
					context({ hasAlternativeSources: false }),
				).action,
			).toBe(RevalidationAction.ABANDON);
		});
	});

	describe('gone', () => {
		it('switches source when there is one', () => {
			expect(
				decideRevalidationAction(
					RevalidationOutcome.GONE,
					context({ hasAlternativeSources: true }),
				).action,
			).toBe(RevalidationAction.SWITCH_SOURCE);
		});

		it('abandons when there is not', () => {
			expect(
				decideRevalidationAction(
					RevalidationOutcome.GONE,
					context({ hasAlternativeSources: false }),
				).action,
			).toBe(RevalidationAction.ABANDON);
		});
	});

	describe('unreachable', () => {
		it('waits and asks again while there is patience left', () => {
			expect(
				decideRevalidationAction(RevalidationOutcome.UNREACHABLE, context({ attempt: 1 })).action,
			).toBe(RevalidationAction.REQUEUE);
		});

		it('gives up once the far end has been silent long enough', () => {
			expect(
				decideRevalidationAction(
					RevalidationOutcome.UNREACHABLE,
					context({ attempt: MAX_REVALIDATION_ATTEMPTS }),
				).action,
			).toBe(RevalidationAction.ABANDON);
		});

		it('honours a caller that wants more or fewer attempts', () => {
			expect(
				decideRevalidationAction(
					RevalidationOutcome.UNREACHABLE,
					context({ attempt: 2, maxAttempts: 2 }),
				).action,
			).toBe(RevalidationAction.ABANDON);
		});
	});

	it('always explains itself', () => {
		for (const outcome of Object.values(RevalidationOutcome)) {
			const decision = decideRevalidationAction(outcome, context());

			expect(decision.note.length).toBeGreaterThan(0);
			expect(Object.values(RevalidationAction)).toContain(decision.action);
		}
	});
});

describe('RevalidationService.classify', () => {
	const service = new RevalidationService(
		{} as unknown as HandlerRegistry,
		{} as unknown as PeerLinkService,
	);

	it('calls silence unreachable, not gone', () => {
		// Collapsing the two would turn every timeout into an abandoned transfer.
		expect(service.classify(file(), undefined)).toBe(RevalidationOutcome.UNREACHABLE);
	});

	it('calls an explicit nothing gone', () => {
		expect(service.classify(file(), null)).toBe(RevalidationOutcome.GONE);
	});

	it('confirms an identical file at the same path', () => {
		expect(service.classify(file(), file())).toBe(RevalidationOutcome.CONFIRMED);
	});

	it('calls the same content at a new path a move', () => {
		expect(service.classify(file(), file({ path: '/media/Shows/Show/S01E01.mkv' }))).toBe(
			RevalidationOutcome.MOVED,
		);
	});

	it('calls a different size a change even at the same path', () => {
		expect(service.classify(file(), file({ size: 2_000 }))).toBe(RevalidationOutcome.CHANGED);
	});

	it('calls a different fingerprint a change', () => {
		expect(service.classify(file(), file({ contentId: 'q1-other', quickHash: 'other' }))).toBe(
			RevalidationOutcome.CHANGED,
		);
	});

	it('does not invent a change when neither side has a hash', () => {
		const bare = file({ quickHash: null, contentId: null, checksum: null });

		expect(service.classify(bare, { ...bare })).toBe(RevalidationOutcome.CONFIRMED);
	});

	it('confirms whatever is reported when we never knew what it was', () => {
		expect(service.classify(null, file())).toBe(RevalidationOutcome.CONFIRMED);
	});
});
