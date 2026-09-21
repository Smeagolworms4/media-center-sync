import {
	RELAY_CHANNEL_MARKER,
	RELAY_FRAME_HEADER_BYTES,
	RELAY_MAX_FRAME_BYTES,
	RelayOpcode,
} from '@mcs/shared';
import { RelayFrameReader, encodeRelayFrame, isRelayFrame } from './peer-relay.frames';

describe('the relay envelope', () => {
	describe('telling relayed traffic apart', () => {
		it('recognises a relay frame by a request identifier that can never be one', () => {
			expect(isRelayFrame(encodeRelayFrame(RelayOpcode.TEXT, 1, Buffer.from('hi')))).toBe(true);
		});

		it('leaves an ordinary byte range alone', () => {
			// Which is the whole reason the marker is unreachable rather than merely
			// unlikely: identifiers are allocated from one, so a range frame can never
			// wear this hat by accident.
			const range = Buffer.alloc(10);

			range.writeUInt32BE(7, 0);

			expect(isRelayFrame(range)).toBe(false);
			expect(isRelayFrame(Buffer.from([1, 2]))).toBe(false);
		});
	});

	describe('reading frames', () => {
		let reader: RelayFrameReader;

		beforeEach(() => {
			reader = new RelayFrameReader();
		});

		it('reads back what was written', () => {
			const frames = reader.push(encodeRelayFrame(RelayOpcode.BINARY, 42, Buffer.from('bytes')));

			expect(frames).toHaveLength(1);
			expect(frames[0]).toMatchObject({ opcode: RelayOpcode.BINARY, session: 42 });
			expect(frames[0].payload.toString()).toBe('bytes');
		});

		it('reads a frame with no payload at all', () => {
			// `CLOSE` and `ACCEPT` are exactly this, and a reader that treated an empty
			// payload as "not here yet" would never deliver either of them.
			expect(reader.push(encodeRelayFrame(RelayOpcode.CLOSE, 3))).toEqual([
				{ opcode: RelayOpcode.CLOSE, session: 3, payload: Buffer.alloc(0) },
			]);
		});

		it('demultiplexes several sessions arriving in one read', () => {
			const frames = reader.push(
				Buffer.concat([
					encodeRelayFrame(RelayOpcode.TEXT, 1, Buffer.from('for one')),
					encodeRelayFrame(RelayOpcode.TEXT, 2, Buffer.from('for two')),
				]),
			);

			expect(frames.map((frame) => [frame.session, frame.payload.toString()])).toEqual([
				[1, 'for one'],
				[2, 'for two'],
			]);
		});

		it('reassembles a frame split across two reads', () => {
			// The reason the envelope carries its own length although a WebSocket message
			// already has one: a reader that assumed every read was a whole frame would
			// deliver half a message and call it complete.
			const frame = encodeRelayFrame(RelayOpcode.TEXT, 9, Buffer.from('a whole message'));

			expect(reader.push(frame.subarray(0, RELAY_FRAME_HEADER_BYTES + 4))).toEqual([]);

			const finished = reader.push(frame.subarray(RELAY_FRAME_HEADER_BYTES + 4));

			expect(finished).toHaveLength(1);
			expect(finished[0].payload.toString()).toBe('a whole message');
		});

		it('reassembles a frame split inside its own header', () => {
			const frame = encodeRelayFrame(RelayOpcode.TEXT, 9, Buffer.from('short'));

			expect(reader.push(frame.subarray(0, 6))).toEqual([]);
			expect(reader.push(frame.subarray(6))).toHaveLength(1);
		});

		it('keeps a second frame that arrived with the tail of the first', () => {
			const first = encodeRelayFrame(RelayOpcode.TEXT, 1, Buffer.from('first'));
			const second = encodeRelayFrame(RelayOpcode.TEXT, 2, Buffer.from('second'));
			const both = Buffer.concat([first, second]);

			expect(reader.push(both.subarray(0, 8))).toEqual([]);

			expect(
				reader.push(both.subarray(8)).map((frame) => frame.payload.toString()),
			).toEqual(['first', 'second']);
		});

		it('refuses a length no frame could have, before allocating for it', () => {
			// An unbounded reader is a gateway anybody can make run out of memory with
			// thirteen bytes.
			const header = Buffer.alloc(RELAY_FRAME_HEADER_BYTES);

			header.writeUInt32BE(RELAY_CHANNEL_MARKER, 0);
			header.writeUInt8(RelayOpcode.BINARY, 4);
			header.writeUInt32BE(1, 5);
			header.writeUInt32BE(RELAY_MAX_FRAME_BYTES + 1, 9);

			expect(reader.push(header)).toEqual([]);
			expect(reader.failed).toBe(true);
		});

		it('gives up for good on a stream it cannot make sense of', () => {
			// There is no way to find where the next frame starts after a bad one, and
			// guessing would hand the far end a fragment of one message as another.
			expect(reader.push(Buffer.alloc(RELAY_FRAME_HEADER_BYTES))).toEqual([]);
			expect(reader.failed).toBe(true);
			expect(reader.push(encodeRelayFrame(RelayOpcode.TEXT, 1, Buffer.from('ignored')))).toEqual(
				[],
			);
		});

		it('refuses an opcode from a version it does not know', () => {
			const frame = encodeRelayFrame(RelayOpcode.TEXT, 1, Buffer.alloc(0));

			frame.writeUInt8(99, 4);

			expect(reader.push(frame)).toEqual([]);
			expect(reader.failed).toBe(true);
		});

		it('hands out payloads that do not share memory with the next read', () => {
			// A payload held by a slow writer must not pin every byte that happened to
			// arrive with it, nor change under it when the buffer moves on.
			const frames = reader.push(encodeRelayFrame(RelayOpcode.TEXT, 1, Buffer.from('keep me')));

			reader.push(encodeRelayFrame(RelayOpcode.TEXT, 2, Buffer.from('later')));

			expect(frames[0].payload.toString()).toBe('keep me');
		});
	});
});
