import {
	RevalidationAction,
	RevalidationOutcome,
	TransferErrorKind,
	type MediaFileInfo,
	type Revalidation,
} from '@mcs/shared';
import { Injectable, Logger } from '@nestjs/common';
import { HandlerRegistry } from './handlers/handler.registry';
import type { ServiceConnection } from './handlers/media-handler.interface';
import { PeerLinkService } from './peer-link.service';

/** How many times a silent far end is asked again before the transfer is given up. */
export const MAX_REVALIDATION_ATTEMPTS = 5;

export interface RevalidationContext {
	/** What made us ask. */
	cause: TransferErrorKind;
	/** Is there another source holding the version we asked for? */
	hasAlternativeSources: boolean;
	/** How many times this transfer has already asked. */
	attempt: number;
	maxAttempts?: number;
}

export interface RevalidationDecision {
	action: RevalidationAction;
	note: string;
}

export interface RevalidationTarget {
	transferId: string;
	sourceServiceId: string;
	sourceServiceName: string;
	/** Identifier of the item inside that service. */
	externalId: string;
	/** Set when the source is reached through a linked friend. */
	peerId?: string | null;
	/** Set when we reach the service over HTTP ourselves. */
	connection?: ServiceConnection;
	/** What we believed the file was, to compare against what they report now. */
	expected: MediaFileInfo | null;
}

/** Causes that are our own machine's fault; asking the far end answers nothing. */
const LOCAL_FAULTS = new Set<TransferErrorKind>([
	TransferErrorKind.DISK_FULL,
	TransferErrorKind.PERMISSION_DENIED,
	TransferErrorKind.TARGET_MISSING,
	TransferErrorKind.CANCELLED,
]);

/**
 * The whole decision, as one pure function.
 *
 * Pure and exported because this table is the protocol: every branch is a different
 * expensive mistake avoided, and the only way to be sure all of them are covered is
 * to test the table exhaustively rather than to reach each branch through a
 * transfer. Nothing here talks to anything; it reads an answer and a situation and
 * says what to do.
 */
export function decideRevalidationAction(
	outcome: RevalidationOutcome,
	context: RevalidationContext,
): RevalidationDecision {
	const maxAttempts = context.maxAttempts ?? MAX_REVALIDATION_ATTEMPTS;

	switch (outcome) {
		case RevalidationOutcome.CONFIRMED:
			// They still hold exactly what we asked for. Whatever went wrong was on our
			// side of the wire, so the split is between "our bytes are wrong" and "our
			// connection was", and only the first needs repairing.
			if (LOCAL_FAULTS.has(context.cause)) {
				return {
					action: RevalidationAction.REQUEUE,
					note: 'the source is intact; the failure was local and has to clear first',
				};
			}

			if (context.cause === TransferErrorKind.CHECKSUM_MISMATCH) {
				return {
					action: RevalidationAction.REPAIR_LOCAL,
					note: 'their copy is unchanged, so ours is the broken one',
				};
			}

			return {
				action: RevalidationAction.RESUME,
				note: 'the source is intact; the interruption was transient',
			};

		case RevalidationOutcome.MOVED:
			// Same content, new path: a library reorganisation, which happens the
			// moment anybody tidies a folder. Following it costs one field.
			return {
				action: RevalidationAction.FOLLOW_MOVE,
				note: 'same content at a new path',
			};

		case RevalidationOutcome.CHANGED:
			// Re-encoded overnight. What they hold now is a different version, and
			// resuming into it would interleave two encodings of the same episode.
			return context.hasAlternativeSources
				? {
						action: RevalidationAction.SWITCH_SOURCE,
						note: 'the source re-encoded its copy; another source still holds the version we started',
					}
				: {
						action: RevalidationAction.ABANDON,
						note: 'the source re-encoded its copy and nobody else holds the version we started',
					};

		case RevalidationOutcome.GONE:
			return context.hasAlternativeSources
				? {
						action: RevalidationAction.SWITCH_SOURCE,
						note: 'the source no longer holds it; another one does',
					}
				: {
						action: RevalidationAction.ABANDON,
						note: 'nobody holds it any more',
					};

		case RevalidationOutcome.UNREACHABLE:
			// Nothing is decided by silence. Waiting is right up to the point where
			// waiting forever becomes a transfer nobody ever looks at again.
			return context.attempt >= maxAttempts
				? {
						action: RevalidationAction.ABANDON,
						note: `no answer after ${context.attempt} attempts`,
					}
				: {
						action: RevalidationAction.REQUEUE,
						note: 'no answer yet; asking again later',
					};
	}
}

/**
 * Ask the far end to re-read one item and say what it actually holds now.
 *
 * A failed range is ambiguous from here. The file may have been moved by a library
 * cleanup, re-encoded overnight, deleted, or served badly by a flaky disk, and each
 * of those wants a different response — guessing costs either a pointless
 * re-download of thirty gigabytes or a perfectly good source dropped for nothing.
 * So we ask, and only then decide.
 *
 * The asking and the deciding are separate on purpose: the decision is a pure
 * function above, and this class is only the part that talks.
 */
@Injectable()
export class RevalidationService {
	private readonly _logger = new Logger(RevalidationService.name);

	public constructor(
		private readonly _handlers: HandlerRegistry,
		private readonly _links: PeerLinkService,
	) {}

	/**
	 * The whole exchange: ask, compare, decide.
	 *
	 * Returns the record without an identifier, because persisting it is the sync
	 * manager's business — this service must not decide that a revalidation is worth
	 * keeping, only what it found.
	 */
	public async revalidate(
		target: RevalidationTarget,
		context: RevalidationContext,
	): Promise<Omit<Revalidation, 'id'>> {
		const requestedAt = new Date().toISOString();
		const remoteFile = await this._ask(target);
		const outcome = this.classify(target.expected, remoteFile);
		const decision = decideRevalidationAction(outcome, context);

		this._logger.log(
			`Revalidated ${target.externalId} against ${target.sourceServiceName}: ${outcome} -> ${decision.action}`,
		);

		return {
			transferId: target.transferId,
			sourceServiceId: target.sourceServiceId,
			sourceServiceName: target.sourceServiceName,
			cause: context.cause,
			requestedAt,
			answeredAt: outcome === RevalidationOutcome.UNREACHABLE ? null : new Date().toISOString(),
			outcome,
			remoteFile: remoteFile ?? null,
			action: decision.action,
			note: decision.note,
		};
	}

	/**
	 * What the far end's answer means, compared with what we expected.
	 *
	 * The fingerprint decides, not the path: a file that moved has the same content
	 * identity at a different place, and a file that was re-encoded has the same path
	 * and a different identity. Comparing paths first would get both backwards.
	 *
	 * The sentinel for "no answer" is `undefined`, distinct from `null`, which is the
	 * far end saying it holds nothing. Collapsing the two would turn every timeout
	 * into an abandoned transfer.
	 */
	public classify(
		expected: MediaFileInfo | null,
		reported: MediaFileInfo | null | undefined,
	): RevalidationOutcome {
		if (reported === undefined) {
			return RevalidationOutcome.UNREACHABLE;
		}

		if (reported === null) {
			return RevalidationOutcome.GONE;
		}

		if (!expected) {
			// We never knew what it was, so anything they report is what it is. Treating
			// that as a change would restart a transfer for no reason.
			return RevalidationOutcome.CONFIRMED;
		}

		const sameIdentity = this._sameIdentity(expected, reported);

		if (!sameIdentity) {
			return RevalidationOutcome.CHANGED;
		}

		return expected.path === reported.path
			? RevalidationOutcome.CONFIRMED
			: RevalidationOutcome.MOVED;
	}

	private _sameIdentity(expected: MediaFileInfo, reported: MediaFileInfo): boolean {
		// Size first: it is always known, and a different size is a different file
		// whatever the hashes say about the parts that survived.
		if (expected.size > 0 && reported.size > 0 && expected.size !== reported.size) {
			return false;
		}

		if (expected.contentId && reported.contentId) {
			return expected.contentId === reported.contentId;
		}

		if (expected.quickHash && reported.quickHash) {
			return expected.quickHash === reported.quickHash;
		}

		if (expected.checksum && reported.checksum) {
			return expected.checksum === reported.checksum;
		}

		// Nothing to compare but the size, which already matched. Saying "changed"
		// here would restart transfers against every source that reports no hashes,
		// which is most of them.
		return true;
	}

	/**
	 * Undefined when nobody answered, null when they answered that it is gone.
	 *
	 * That distinction is the only reason this method exists separately, and losing
	 * it is the mistake this whole protocol is designed around.
	 */
	private async _ask(target: RevalidationTarget): Promise<MediaFileInfo | null | undefined> {
		try {
			if (target.peerId) {
				const answer = await this._links.request<{ file?: MediaFileInfo | null }>(
					target.peerId,
					'media.revalidate',
					{ serviceId: target.sourceServiceId, externalId: target.externalId },
				);

				return answer.file ?? null;
			}

			if (!target.connection) {
				return undefined;
			}

			const handler = this._handlers.get(target.connection.type);
			const item = await handler.getItem(target.connection, target.externalId);

			return item ? item.file : null;
		} catch (error) {
			this._logger.warn(
				`No answer from ${target.sourceServiceName} about ${target.externalId}: ${String(error)}`,
			);

			return undefined;
		}
	}
}
