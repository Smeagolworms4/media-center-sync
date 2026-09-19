import { Readable } from 'node:stream';
import { PeerLinkMode, TransferTransport } from '@mcs/shared';
import type { PeerLinkService } from '../peer-link.service';
import { PeerTransport } from './peer.transport';
import type { TransferSourceRef } from './transport.interface';

function source(overrides: Partial<TransferSourceRef> = {}): TransferSourceRef {
	return {
		serviceId: 'remote-service',
		serviceName: 'Sam’s Jellyfin',
		peerId: 'peer-1',
		peerName: 'Sam',
		transport: TransferTransport.PEER_DIRECT,
		externalId: 'item-1',
		contentId: 'q1-abc',
		sizeHint: 1_000,
		...overrides,
	};
}

describe('PeerTransport', () => {
	let request: jest.Mock;
	let openStream: jest.Mock;
	let state: jest.Mock;
	let transport: PeerTransport;

	beforeEach(() => {
		request = jest.fn(async () => ({ size: 2_000, resumable: true }));
		openStream = jest.fn(async () => Readable.from([Buffer.from('bytes')]));
		state = jest.fn(() => ({
			peerId: 'peer-1',
			mode: PeerLinkMode.DIRECT,
			address: null,
			connected: true,
			since: '',
		}));

		transport = new PeerTransport({ request, openStream, state } as unknown as PeerLinkService);
	});

	describe('prepare', () => {
		it('asks the far end to describe what it holds', async () => {
			const capabilities = await transport.prepare(source());

			expect(request).toHaveBeenCalledWith('peer-1', 'media.describe', {
				serviceId: 'remote-service',
				externalId: 'item-1',
				contentId: 'q1-abc',
			});
			expect(capabilities).toMatchObject({
				resumable: true,
				totalBytes: 2_000,
				maxConnections: 4,
				pieceChecksums: null,
			});
		});

		it('opens fewer connections through a relay', async () => {
			// The rendezvous is doing us a favour, and four transfers each opening four
			// relayed sockets is how that favour stops being offered.
			state.mockReturnValue({ mode: PeerLinkMode.RELAY, connected: true });

			expect((await transport.prepare(source())).maxConnections).toBe(2);
		});

		it('carries the piece hashes the far end can produce', async () => {
			// They are the difference between repairing two megabytes and refetching
			// thirty gigabytes.
			request.mockResolvedValue({ size: 2_000, pieces: { '0': 'aaa', '1': 'bbb' } });

			const capabilities = await transport.prepare(source());

			expect(capabilities.pieceChecksums?.get(0)).toBe('aaa');
			expect(capabilities.pieceChecksums?.get(1)).toBe('bbb');
		});

		it('falls back to the size we already believed', async () => {
			request.mockResolvedValue({});

			expect((await transport.prepare(source({ sizeHint: 42 }))).totalBytes).toBe(42);
		});

		it('believes a far end that says it cannot resume', async () => {
			request.mockResolvedValue({ size: 1, resumable: false });

			expect((await transport.prepare(source())).resumable).toBe(false);
		});

		it('refuses a source with no peer behind it', async () => {
			await expect(transport.prepare(source({ peerId: null }))).rejects.toMatchObject({
				response: { key: 'error.peer.not_found' },
			});
		});
	});

	describe('fetch', () => {
		it('asks for the range over the link', async () => {
			const chunk = await transport.fetch(
				source(),
				{ start: 100, end: 199 },
				{ chunkIndex: 3 },
			);

			expect(openStream).toHaveBeenCalledWith('peer-1', 'media.range', {
				serviceId: 'remote-service',
				externalId: 'item-1',
				contentId: 'q1-abc',
				start: 100,
				end: 199,
				chunkIndex: 3,
			});
			// The far end runs our own protocol: there is no case where it sends the
			// whole file and pretends otherwise.
			expect(chunk.wholeFile).toBe(false);
			expect(chunk.length).toBe(100);
		});
	});
});
