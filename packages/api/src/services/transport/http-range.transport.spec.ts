import { Readable } from 'node:stream';
import { MediaServiceType, TransferTransport } from '@mcs/shared';
import type { HandlerRegistry } from '../handlers/handler.registry';
import type { MediaStream, ServiceConnection } from '../handlers/media-handler.interface';
import { HttpRangeTransport } from './http-range.transport';
import type { TransferSourceRef } from './transport.interface';

const connection: ServiceConnection = {
	id: 'service-1',
	type: MediaServiceType.JELLYFIN,
	baseUrl: 'http://jellyfin:8096',
	token: 'token',
	username: null,
	password: null,
};

function source(overrides: Partial<TransferSourceRef> = {}): TransferSourceRef {
	return {
		serviceId: 'service-1',
		serviceName: 'Jellyfin',
		peerId: null,
		transport: TransferTransport.HTTP_RANGE,
		connection,
		externalId: 'item-1',
		sizeHint: 1_000,
		...overrides,
	};
}

function answer(overrides: Partial<MediaStream> = {}): MediaStream {
	return {
		stream: Readable.from([Buffer.from('bytes')]),
		contentLength: 5,
		totalLength: 1_000,
		acceptsRanges: true,
		contentType: 'video/x-matroska',
		...overrides,
	};
}

describe('HttpRangeTransport', () => {
	let openStream: jest.Mock;
	let transport: HttpRangeTransport;

	beforeEach(() => {
		openStream = jest.fn(async () => answer());

		const handlers = { get: () => ({ openStream }) };

		transport = new HttpRangeTransport(handlers as unknown as HandlerRegistry);
	});

	describe('prepare', () => {
		it('proves the range works by asking for two bytes', async () => {
			// A server that advertises `Accept-Ranges` and then ignores the header on the
			// real request is common enough that only a real ranged request answers this.
			const capabilities = await transport.prepare(source());

			expect(openStream).toHaveBeenCalledWith(connection, { externalId: 'item-1' }, {
				start: 0,
				end: 1,
			});
			expect(capabilities).toMatchObject({
				resumable: true,
				totalBytes: 1_000,
				maxConnections: 4,
				pieceChecksums: null,
			});
		});

		it('drops to one connection against a source that ignores ranges', async () => {
			// Any parallelism against such a source writes the head of the file at four
			// different offsets.
			openStream.mockResolvedValue(answer({ acceptsRanges: false }));

			expect(await transport.prepare(source())).toMatchObject({
				resumable: false,
				maxConnections: 1,
			});
		});

		it('falls back to the size we were told when the server gives none', async () => {
			openStream.mockResolvedValue(answer({ totalLength: null }));

			expect((await transport.prepare(source({ sizeHint: 42 }))).totalBytes).toBe(42);
		});

		it('releases the probe socket instead of leaving it streaming', async () => {
			const probe = answer();
			const destroy = jest.spyOn(probe.stream, 'destroy');

			openStream.mockResolvedValue(probe);

			await transport.prepare(source());

			expect(destroy).toHaveBeenCalled();
		});

		it('refuses a source with no connection at all', async () => {
			await expect(transport.prepare(source({ connection: undefined }))).rejects.toMatchObject({
				response: { key: 'error.service.not_found' },
			});
		});
	});

	describe('fetch', () => {
		it('asks for the range and hands back the stream', async () => {
			const chunk = await transport.fetch(source(), { start: 100, end: 199 });

			expect(openStream).toHaveBeenCalledWith(
				connection,
				{ externalId: 'item-1' },
				{ start: 100, end: 199 },
			);
			expect(chunk.wholeFile).toBe(false);
			expect(chunk.length).toBe(5);
		});

		it('reports a whole-file answer rather than hiding it', async () => {
			// Hiding it would mean writing the file's head into the middle of itself.
			openStream.mockResolvedValue(answer({ acceptsRanges: false }));

			expect((await transport.fetch(source(), { start: 100, end: 199 })).wholeFile).toBe(true);
		});
	});
});
