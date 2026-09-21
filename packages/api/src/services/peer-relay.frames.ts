import {
	RELAY_CHANNEL_MARKER,
	RELAY_FRAME_HEADER_BYTES,
	RELAY_MAX_FRAME_BYTES,
	RelayOpcode,
	type RelayOpcodeValue,
} from '@mcs/shared';

/**
 * Reading and writing the relay envelope. See `peer-relay.model.ts` for the shape and
 * for why relayed traffic shares the peer link's binary channel at all.
 *
 * Kept apart from the service that uses it because it is the one piece with no state
 * beyond a few bytes and no dependency on anything: it can be tested by handing it
 * bytes and reading what comes back, which is the only way to be sure a frame split
 * across two reads is reassembled rather than half-parsed.
 */

/** One decoded frame. The payload is a view of the reader's buffer, never the buffer. */
export interface RelayFrame {
	opcode: RelayOpcodeValue;
	session: number;
	payload: Buffer;
}

const EMPTY = Buffer.alloc(0);

export const encodeRelayFrame = (
	opcode: RelayOpcodeValue,
	session: number,
	payload: Buffer = EMPTY,
): Buffer => {
	const frame = Buffer.allocUnsafe(RELAY_FRAME_HEADER_BYTES + payload.length);

	frame.writeUInt32BE(RELAY_CHANNEL_MARKER, 0);
	frame.writeUInt8(opcode, 4);
	frame.writeUInt32BE(session, 5);
	frame.writeUInt32BE(payload.length, 9);
	payload.copy(frame, RELAY_FRAME_HEADER_BYTES);

	return frame;
};

/**
 * Is this binary message relayed traffic rather than a byte range?
 *
 * The one question the link has to answer before it decides which map to look the
 * identifier up in. Cheap on purpose: it is asked of every binary frame on every
 * link, including the ones carrying a film.
 */
export const isRelayFrame = (data: Buffer): boolean =>
	data.length >= 4 && data.readUInt32BE(0) === RELAY_CHANNEL_MARKER;

const KNOWN_OPCODES: readonly number[] = Object.values(RelayOpcode);

/**
 * Bytes in, whole frames out, holding on to whatever was left over.
 *
 * One per link and per direction. It is written against a byte stream rather than
 * against messages because the alternative — assuming every read is exactly one frame
 * — is the kind of assumption that holds until something coalesces two of them and
 * then fails as a corrupted film rather than as an error.
 *
 * A reader that has seen something it cannot make sense of stays failed, and the
 * caller closes the link: after a bad length there is no way to know where the next
 * frame starts, and guessing would feed a fragment of one message to the far end as
 * if it were another.
 */
export class RelayFrameReader {
	private _buffer: Buffer = EMPTY;
	private _failed = false;

	/** True once the stream stopped making sense. It never recovers. */
	public get failed(): boolean {
		return this._failed;
	}

	public push(chunk: Buffer): RelayFrame[] {
		if (this._failed) {
			return [];
		}

		this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

		const frames: RelayFrame[] = [];

		for (;;) {
			if (this._buffer.length < RELAY_FRAME_HEADER_BYTES) {
				return frames;
			}

			if (this._buffer.readUInt32BE(0) !== RELAY_CHANNEL_MARKER) {
				return this._fail();
			}

			const opcode = this._buffer.readUInt8(4);
			const session = this._buffer.readUInt32BE(5);
			const length = this._buffer.readUInt32BE(9);

			// Refused on the header, before the payload is waited for: a frame claiming
			// four gigabytes would otherwise have this reader accumulate until the
			// process died, which is the one failure a bound on frames is here to stop.
			if (length > RELAY_MAX_FRAME_BYTES || !KNOWN_OPCODES.includes(opcode)) {
				return this._fail();
			}

			const total = RELAY_FRAME_HEADER_BYTES + length;

			if (this._buffer.length < total) {
				return frames;
			}

			frames.push({
				opcode: opcode as RelayOpcodeValue,
				session,
				// Copied rather than sliced. A subarray shares memory with the buffer
				// below, which the next `concat` would leave alive as long as the frame
				// is — a payload held by a slow writer would then pin every byte that
				// happened to arrive with it.
				payload: Buffer.from(this._buffer.subarray(RELAY_FRAME_HEADER_BYTES, total)),
			});

			this._buffer = this._buffer.subarray(total);
		}
	}

	private _fail(): RelayFrame[] {
		this._failed = true;
		this._buffer = EMPTY;

		return [];
	}
}
