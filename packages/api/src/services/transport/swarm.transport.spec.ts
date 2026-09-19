import { Readable } from 'node:stream';
import { PeerTrust, TransferTransport } from '@mcs/shared';
import type { ContentHolder } from '../peer-catalogue.service';
import { PeerLinkSwarmWire, SwarmTransport, type SwarmSession } from './swarm.transport';
import type { TransferSourceRef } from './transport.interface';

function holder(overrides: Partial<ContentHolder> = {}): ContentHolder {
	return {
		peerId: 'peer-1',
		peerName: 'Sam',
		serviceId: 'service-1',
		externalId: 'item-1',
		size: 8 * 1024 * 1024,
		trust: PeerTrust.FRIEND,
		viaPeerId: null,
		...overrides,
	};
}

function source(overrides: Partial<TransferSourceRef> = {}): TransferSourceRef {
	return {
		serviceId: 'service-1',
		serviceName: 'Sam’s gateway',
		peerId: 'peer-1',
		transport: TransferTransport.SWARM,
		externalId: 'item-1',
		contentId: 'q1-abc',
		sizeHint: 8 * 1024 * 1024,
		holders: [holder()],
		...overrides,
	};
}

describe('SwarmTransport', () => {
	let usable: jest.Mock;
	let bitfield: jest.Mock;
	let fetchPiece: jest.Mock;
	let transport: SwarmTransport;

	beforeEach(() => {
		usable = jest.fn(() => true);
		bitfield = jest.fn(async () => null);
		fetchPiece = jest.fn(async () => Readable.from([Buffer.from('piece')]));
		transport = new SwarmTransport({ usable, bitfield, fetchPiece } as unknown as PeerLinkSwarmWire);
	});

	describe('prepare', () => {
		it('builds a peer set and offers one connection per peer', async () => {
			const capabilities = await transport.prepare(
				source({ holders: [holder(), holder({ peerId: 'peer-2', peerName: 'Kim' })] }),
			);

			expect(capabilities).toMatchObject({
				resumable: true,
				totalBytes: 8 * 1024 * 1024,
				maxConnections: 2,
			});
		});

		it('refuses without a content identifier', async () => {
			// It is the only thing peers agree on without talking, and the only key the
			// peer set is built from.
			await expect(transport.prepare(source({ contentId: null }))).rejects.toMatchObject({
				response: { key: 'error.sync.no_source' },
			});
		});

		it('leaves out a peer that never advertised the swarm', async () => {
			// A feature is used because the far end said it has it, never because we
			// have it. A peer that would refuse every piece is not a source, and asking
			// it anyway costs a round trip per piece and a log full of refusals that
			// read like a network problem.
			usable.mockImplementation((peer: { peerId: string }) => peer.peerId !== 'peer-2');

			const capabilities = await transport.prepare(
				source({ holders: [holder(), holder({ peerId: 'peer-2', peerName: 'Kim' })] }),
			);

			expect(capabilities.maxConnections).toBe(1);
			expect(bitfield).toHaveBeenCalledTimes(1);
		});

		it('refuses when every holder speaks a protocol without the swarm', async () => {
			usable.mockReturnValue(false);

			await expect(transport.prepare(source())).rejects.toMatchObject({
				response: { key: 'error.sync.no_source' },
			});
		});

		it('refuses when nobody holds it', async () => {
			await expect(transport.prepare(source({ holders: [] }))).rejects.toMatchObject({
				response: { key: 'error.sync.no_source' },
			});
		});

		it('treats a peer that cannot answer a bitfield as holding everything', async () => {
			// It advertised the content identifier, which is a claim about the complete
			// file; assuming the opposite would exclude every peer on an older version.
			bitfield.mockResolvedValue(null);

			await expect(transport.prepare(source())).resolves.toMatchObject({ maxConnections: 1 });
		});
	});

	describe('fetch', () => {
		it('asks a peer that holds the piece', async () => {
			await transport.prepare(source());

			const chunk = await transport.fetch(
				source(),
				{ start: 0, end: 1023 },
				{ chunkIndex: 0 },
			);

			expect(chunk.wholeFile).toBe(false);
			expect(fetchPiece).toHaveBeenCalledWith(
				expect.objectContaining({ peerId: 'peer-1' }),
				'q1-abc',
				{ start: 0, end: 1023 },
				0,
			);
		});

		it('moves to another peer when the first one fails', async () => {
			// The swarm's whole advantage is that there is somebody else to ask.
			fetchPiece
				.mockRejectedValueOnce(new Error('peer dropped'))
				.mockResolvedValueOnce(Readable.from([Buffer.from('piece')]));

			await transport.prepare(
				source({ holders: [holder(), holder({ peerId: 'peer-2', peerName: 'Kim' })] }),
			);

			await expect(
				transport.fetch(source(), { start: 0, end: 1023 }, { chunkIndex: 0 }),
			).resolves.toBeDefined();
			expect(fetchPiece).toHaveBeenCalledTimes(2);
		});

		it('gives up once every peer has failed the piece', async () => {
			fetchPiece.mockRejectedValue(new Error('peer dropped'));

			await transport.prepare(source());

			await expect(
				transport.fetch(source(), { start: 0, end: 1023 }, { chunkIndex: 0 }),
			).rejects.toMatchObject({ response: { key: 'error.sync.no_source' } });
		});

		it('refuses to fetch for a session nobody prepared', async () => {
			await expect(
				transport.fetch(source({ contentId: 'q1-unprepared' }), { start: 0, end: 1 }),
			).rejects.toMatchObject({ response: { key: 'error.sync.no_source' } });
		});

		it('forgets the session when it is released', async () => {
			await transport.prepare(source());
			await transport.release(source());

			await expect(transport.fetch(source(), { start: 0, end: 1 })).rejects.toBeDefined();
		});
	});

	describe('rarestFirst', () => {
		function session(availability: Record<string, number[]>): SwarmSession {
			return {
				contentId: 'q1-abc',
				pieceLength: 1_024,
				pieceCount: 4,
				totalBytes: 4_096,
				delivered: new Set(),
				peers: new Map(
					Object.entries(availability).map(([peerId, pieces]) => [
						peerId,
						{
							holder: holder({ peerId }),
							available: new Set(pieces),
							inFlight: 0,
							failures: 0,
							rate: 0,
						},
					]),
				),
			};
		}

		it('wants the piece the fewest peers hold', () => {
			// Without this everybody downloads the common pieces, the rare ones live on
			// one machine, and that machine going offline strands everyone.
			const swarm = session({ a: [0, 1, 2], b: [0, 1], c: [0] });

			expect(transport.rarestFirst(swarm, [0, 1, 2])).toEqual([2, 1, 0]);
		});

		it('breaks a tie by piece order, so the file arrives front to back', () => {
			const swarm = session({ a: [0, 1, 2], b: [0, 1, 2] });

			expect(transport.rarestFirst(swarm, [2, 0, 1])).toEqual([0, 1, 2]);
		});

		it('puts a piece nobody holds last rather than first', () => {
			// It is not rare, it is absent, and asking for it first wastes the swarm's
			// time.
			const swarm = session({ a: [0, 1] });

			expect(transport.rarestFirst(swarm, [0, 1, 3])).toEqual([0, 1, 3]);
		});

		it('handles an empty want list', () => {
			expect(transport.rarestFirst(session({ a: [0] }), [])).toEqual([]);
		});
	});
});
