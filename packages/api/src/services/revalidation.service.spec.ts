import {
	ErrorKey,
	MediaServiceType,
	RevalidationAction,
	RevalidationOutcome,
	TransferErrorKind,
	type MediaFileInfo,
} from '@mcs/shared';
import { NotFoundException } from '@nestjs/common';
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

describe('RevalidationService.revalidate', () => {
	const connection = {
		id: 'service-1',
		type: MediaServiceType.JELLYFIN,
		baseUrl: 'http://jellyfin:8096',
		token: null,
		username: null,
		password: null,
	};

	function build(handlerItem: unknown, peerAnswer?: unknown) {
		// Symmetric with `request`: an Error is thrown rather than returned, so a test
		// can express "the service refused to answer" as well as "it answered this".
		const getItem = jest.fn(async () => {
			if (handlerItem instanceof Error) {
				throw handlerItem;
			}

			return handlerItem;
		});
		const request = jest.fn(async () => {
			if (peerAnswer instanceof Error) {
				throw peerAnswer;
			}

			return peerAnswer;
		});

		return {
			getItem,
			request,
			service: new RevalidationService(
				{ get: () => ({ getItem }) } as unknown as HandlerRegistry,
				{ request } as unknown as PeerLinkService,
			),
		};
	}

	function target(overrides: Record<string, unknown> = {}) {
		return {
			transferId: 't1',
			sourceServiceId: 'service-1',
			sourceServiceName: 'Jellyfin',
			externalId: 'item-1',
			connection,
			expected: file(),
			...overrides,
		};
	}

	it('asks a service we reach ourselves, and resumes on a confirmation', async () => {
		const { service, getItem } = build({ file: file() });

		const record = await service.revalidate(target(), context());

		expect(getItem).toHaveBeenCalledWith(connection, 'item-1');
		expect(record).toMatchObject({
			outcome: RevalidationOutcome.CONFIRMED,
			action: RevalidationAction.RESUME,
			sourceServiceName: 'Jellyfin',
			cause: TransferErrorKind.NETWORK,
		});
		expect(record.answeredAt).not.toBeNull();
	});

	it('asks the far end over the link when the source belongs to a peer', async () => {
		const { service, request } = build(null, { file: file({ path: '/new/path.mkv' }) });

		const record = await service.revalidate(
			target({ peerId: 'peer-1' }),
			context({ cause: TransferErrorKind.SOURCE_GONE }),
		);

		expect(request).toHaveBeenCalledWith('peer-1', 'media.revalidate', {
			serviceId: 'service-1',
			externalId: 'item-1',
		});
		expect(record).toMatchObject({
			outcome: RevalidationOutcome.MOVED,
			action: RevalidationAction.FOLLOW_MOVE,
		});
		expect(record.remoteFile?.path).toBe('/new/path.mkv');
	});

	it('calls a peer that holds nothing gone', async () => {
		const { service } = build(null, { file: null });

		expect(
			await service.revalidate(target({ peerId: 'peer-1' }), context()),
		).toMatchObject({ outcome: RevalidationOutcome.GONE, action: RevalidationAction.ABANDON });
	});

	it('calls it gone when the service itself answers that it no longer holds the item', async () => {
		/*
		 * The distinction this whole class exists for, at the one place it is decided.
		 *
		 * A 404 from a media server is a decisive answer and has to end the transfer.
		 * Before the HTTP layer told a 404 apart from a dead socket, it arrived here
		 * as an exception, was read as silence, and a source deleted months ago was
		 * still being retried.
		 */
		const { service } = build(new NotFoundException({ key: ErrorKey.SERVICE_RESOURCE_NOT_FOUND }));

		expect(await service.revalidate(target(), context())).toMatchObject({
			outcome: RevalidationOutcome.GONE,
			action: RevalidationAction.ABANDON,
		});
	});

	it('leaves a service that could not be reached undecided rather than gone', async () => {
		// The expensive mistake in the other direction: abandoning a good source
		// because its server was rebooting.
		const { service } = build(new Error('ECONNREFUSED'));
		const record = await service.revalidate(target(), context());

		expect(record.outcome).toBe(RevalidationOutcome.UNREACHABLE);
		expect(record.action).not.toBe(RevalidationAction.ABANDON);
		expect(record.answeredAt).toBeNull();
	});

	it('calls a far end that will not answer unreachable, and leaves it undecided', async () => {
		const { service } = build(null, new Error('link down'));

		const record = await service.revalidate(target({ peerId: 'peer-1' }), context());

		expect(record).toMatchObject({
			outcome: RevalidationOutcome.UNREACHABLE,
			action: RevalidationAction.REQUEUE,
			answeredAt: null,
			remoteFile: null,
		});
	});

	it('is unreachable when there is no way to ask at all', async () => {
		const { service } = build(null);

		expect(
			await service.revalidate(target({ connection: undefined }), context()),
		).toMatchObject({ outcome: RevalidationOutcome.UNREACHABLE });
	});

	it('reports a source that no longer holds the item', async () => {
		const { service } = build(null);

		expect(await service.revalidate(target(), context())).toMatchObject({
			outcome: RevalidationOutcome.GONE,
		});
	});
});
