import { buildUrl, requestJson, requestStream } from './handler.http';

describe('handler.http', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	function stub(response: Partial<Response> & { body?: unknown }): jest.Mock {
		const mock = jest.fn(async () => response as unknown as Response) as unknown as jest.Mock;

		global.fetch = mock as unknown as typeof fetch;

		return mock;
	}

	describe('buildUrl', () => {
		it('joins without producing a double slash or eating one', () => {
			// People type the address both ways, and a 404 over a trailing slash looks
			// broken rather than picky.
			expect(buildUrl('http://jellyfin:8096/', '/System/Info')).toBe(
				'http://jellyfin:8096/System/Info',
			);
			expect(buildUrl('http://jellyfin:8096', 'System/Info')).toBe(
				'http://jellyfin:8096/System/Info',
			);
		});

		it('keeps a base mounted under a path', () => {
			expect(buildUrl('http://host/media/', '/Items')).toBe('http://host/media/Items');
		});

		it('appends only the query values that carry something', () => {
			expect(
				buildUrl('http://host', '/Items', {
					ParentId: 'abc',
					Recursive: true,
					Limit: 20,
					Empty: '',
					Missing: undefined,
					Nothing: null,
				}),
			).toBe('http://host/Items?ParentId=abc&Recursive=true&Limit=20');
		});
	});

	describe('requestJson', () => {
		it('parses the answer', async () => {
			stub({ ok: true, status: 200, headers: new Headers(), text: async () => '{"a":1}' });

			expect(await requestJson('http://host', '/x')).toEqual({ a: 1 });
		});

		it('degrades an empty body to an empty object', async () => {
			// A 204, which every caller here reads defensively anyway.
			stub({ ok: true, status: 204, headers: new Headers(), text: async () => '' });

			expect(await requestJson('http://host', '/x')).toEqual({});
		});

		it('degrades an answer that is not JSON at all', async () => {
			stub({ ok: true, status: 200, headers: new Headers(), text: async () => '<html>' });

			expect(await requestJson('http://host', '/x')).toEqual({});
		});

		it('turns a transport failure into an unreachable service', async () => {
			global.fetch = jest.fn(async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch;

			await expect(requestJson('http://host', '/x')).rejects.toMatchObject({
				response: { key: 'error.service.unreachable' },
			});
		});

		it.each([401, 403])('turns a %i into an unauthorized service', async (status) => {
			stub({ ok: false, status, headers: new Headers(), text: async () => '' });

			await expect(requestJson('http://host', '/x')).rejects.toMatchObject({
				response: { key: 'error.service.unauthorized' },
			});
		});

		it('treats any other failure as a server we cannot use', async () => {
			stub({ ok: false, status: 500, headers: new Headers(), text: async () => '' });

			await expect(requestJson('http://host', '/x')).rejects.toMatchObject({
				response: { key: 'error.service.unreachable', detail: 'HTTP 500' },
			});
		});

		it('sends a body as JSON when there is one', async () => {
			const fetchMock = stub({
				ok: true,
				status: 200,
				headers: new Headers(),
				text: async () => '{}',
			});

			await requestJson('http://host', '/x', { method: 'POST', body: { a: 1 } });

			const init = fetchMock.mock.calls[0][1] as RequestInit;

			expect(init.body).toBe('{"a":1}');
			expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
		});
	});

	describe('requestStream', () => {
		function streamResponse(status: number, headers: Record<string, string>) {
			return {
				ok: status >= 200 && status < 300,
				status,
				headers: new Headers(headers),
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([1, 2, 3]));
						controller.close();
					},
				}),
			};
		}

		it('asks for the range and believes a 206', async () => {
			const fetchMock = stub(
				streamResponse(206, {
					'content-length': '100',
					'content-range': 'bytes 0-99/204800',
				}) as unknown as Response,
			);

			const answer = await requestStream('http://host', '/file', {
				range: { start: 0, end: 99 },
			});

			expect(
				(fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers
					.Range,
			).toBe('bytes=0-99');
			expect(answer).toMatchObject({
				acceptsRanges: true,
				contentLength: 100,
				totalLength: 204_800,
			});
		});

		it('says the range was ignored when the server answers 200', async () => {
			// A server that replies 200 to a Range request is sending the whole file from
			// zero, and writing that at chunk seventeen's offset corrupts it silently.
			stub(streamResponse(200, { 'content-length': '204800' }) as unknown as Response);

			expect(
				(await requestStream('http://host', '/file', { range: { start: 0, end: 99 } }))
					.acceptsRanges,
			).toBe(false);
		});

		it('falls back to what the server advertises when no range was asked for', async () => {
			stub(streamResponse(200, { 'accept-ranges': 'bytes' }) as unknown as Response);

			expect((await requestStream('http://host', '/file')).acceptsRanges).toBe(true);

			stub(streamResponse(200, { 'accept-ranges': 'none' }) as unknown as Response);

			expect((await requestStream('http://host', '/file')).acceptsRanges).toBe(false);
		});

		it('gives back a readable stream of the bytes', async () => {
			stub(streamResponse(200, {}) as unknown as Response);

			const answer = await requestStream('http://host', '/file');
			const chunks: Buffer[] = [];

			for await (const chunk of answer.stream) {
				chunks.push(chunk as Buffer);
			}

			expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
		});

		it('maps a rejected token and an unreachable host the same way json does', async () => {
			stub({ ok: false, status: 401, headers: new Headers() } as unknown as Response);

			await expect(requestStream('http://host', '/file')).rejects.toMatchObject({
				response: { key: 'error.service.unauthorized' },
			});

			global.fetch = jest.fn(async () => {
				throw new Error('ETIMEDOUT');
			}) as unknown as typeof fetch;

			await expect(requestStream('http://host', '/file')).rejects.toMatchObject({
				response: { key: 'error.service.unreachable' },
			});
		});
	});
});
