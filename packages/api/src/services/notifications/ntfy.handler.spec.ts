import { NotificationEvent, type NotificationMessage } from '@mcs/shared';
import { BadRequestException } from '@nestjs/common';
import type { NotificationContext } from './notification-handler.interface';
import { NtfyHandler } from './ntfy.handler';

const message: NotificationMessage = {
	event: NotificationEvent.PLACEMENT_UNCONFIGURED,
	title: 'Twelve files landed where nobody chose',
	body: 'Nothing named a destination for Animés.',
	link: '/settings',
};

const context: NotificationContext = {
	baseUrl: 'https://gateway.example',
	instanceName: 'Loft',
};

/** The far end, never reached. A real server here would be a test with a network. */
const stubFetch = (
	answer: { ok?: boolean; status?: number; statusText?: string; text?: string } = {},
): jest.Mock => {
	const stub = jest.fn().mockResolvedValue({
		ok: answer.ok ?? true,
		status: answer.status ?? 200,
		statusText: answer.statusText ?? 'OK',
		text: () => Promise.resolve(answer.text ?? ''),
	});

	globalThis.fetch = stub as unknown as typeof fetch;

	return stub;
};

/** The options object of the one call, as `fetch` received it. */
const callOf = (stub: jest.Mock): { url: string; init: RequestInit & { headers: Record<string, string> } } => {
	const [url, init] = stub.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];

	return { url, init };
};

describe('NtfyHandler', () => {
	const handler = new NtfyHandler();
	const original = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = original;
	});

	describe('settings it refuses, and the field it names', () => {
		/**
		 * The field is the whole answer.
		 *
		 * `config` is opaque everywhere else on purpose, so the handler is the only
		 * thing that can say which of the boxes on screen is the empty one — a refusal
		 * naming nothing leaves somebody staring at a form and guessing.
		 */
		it.each([
			['url', { topic: 'home' }],
			['topic', { url: 'https://ntfy.sh' }],
			['url', { url: '   ', topic: 'home' }],
			['topic', { url: 'https://ntfy.sh', topic: '' }],
		])('names %s', (field, config) => {
			expect.assertions(2);

			try {
				handler.validate(config);
			} catch (error) {
				expect(error).toBeInstanceOf(BadRequestException);
				expect((error as BadRequestException).getResponse()).toMatchObject({ field });
			}
		});

		it('accepts a channel with no token, because that is the ordinary case', () => {
			expect(() => handler.validate({ url: 'https://ntfy.sh', topic: 'home' })).not.toThrow();
		});

		it('refuses a token that is not a string rather than sending it as one', () => {
			expect(() =>
				handler.validate({ url: 'https://ntfy.sh', topic: 'home', token: 42 }),
			).toThrow(BadRequestException);
		});
	});

	describe('what leaves the gateway', () => {
		it('posts to the topic under the server, with the body as the message', async () => {
			const stub = stubFetch();

			await handler.send({ url: 'https://ntfy.sh', topic: 'loft' }, message, context);

			const { url, init } = callOf(stub);

			expect(url).toBe('https://ntfy.sh/loft');
			expect(init.method).toBe('POST');
			expect(init.body).toBe(message.body);
		});

		it('strips a trailing slash rather than publishing to a double one', async () => {
			// `https://ntfy.sh//loft` is a 404 that says nothing about the extra
			// character, and people paste the slash as often as not.
			const stub = stubFetch();

			await handler.send({ url: 'https://ntfy.sh/', topic: 'loft' }, message, context);

			expect(callOf(stub).url).toBe('https://ntfy.sh/loft');
		});

		it('names the gateway in the title when one is set', async () => {
			const stub = stubFetch();

			await handler.send({ url: 'https://ntfy.sh', topic: 'loft' }, message, context);

			expect(callOf(stub).init.headers.Title).toBe(`[Loft] ${message.title}`);
		});

		it('sends a non-ASCII title encoded rather than failing at the socket', async () => {
			// Undici refuses a header carrying a byte above 0xFF with a TypeError that
			// names neither the header nor the character, and every title here comes
			// from somebody else's media metadata.
			const stub = stubFetch();

			await handler.send(
				{ url: 'https://ntfy.sh', topic: 'loft' },
				{ ...message, title: 'Animés épisode 3' },
				{ baseUrl: null, instanceName: null },
			);

			expect(callOf(stub).init.headers.Title).toBe('=?UTF-8?B?QW5pbcOpcyDDqXBpc29kZSAz?=');
		});

		it('turns the relative link into one a phone can open', async () => {
			const stub = stubFetch();

			await handler.send({ url: 'https://ntfy.sh', topic: 'loft' }, message, context);

			expect(callOf(stub).init.headers.Click).toBe('https://gateway.example/settings');
		});

		it('sends no link at all when the gateway has no public address', async () => {
			// A link built on localhost is correct on exactly one machine and wrong on
			// every phone the message reaches.
			const stub = stubFetch();

			await handler.send({ url: 'https://ntfy.sh', topic: 'loft' }, message, {
				baseUrl: null,
				instanceName: null,
			});

			expect(callOf(stub).init.headers.Click).toBeUndefined();
		});

		it('carries the bearer token only when one is configured', async () => {
			const withToken = stubFetch();

			await handler.send(
				{ url: 'https://ntfy.sh', topic: 'loft', token: 'tk_secret' },
				message,
				context,
			);

			expect(callOf(withToken).init.headers.Authorization).toBe('Bearer tk_secret');

			const without = stubFetch();

			await handler.send({ url: 'https://ntfy.sh', topic: 'loft' }, message, context);

			expect(callOf(without).init.headers.Authorization).toBeUndefined();
		});
	});

	describe('when the far end says no', () => {
		it('throws with the server’s own words, because those are the diagnosis', async () => {
			const stub = stubFetch({
				ok: false,
				status: 403,
				statusText: 'Forbidden',
				text: 'invalid access token',
			});

			await expect(
				handler.send({ url: 'https://ntfy.sh', topic: 'loft' }, message, context),
			).rejects.toThrow('403 Forbidden: invalid access token');

			expect(stub).toHaveBeenCalledTimes(1);
		});
	});

	describe('what may be shown', () => {
		it('drops the token and keeps everything the form has to prefill', () => {
			// Dropped rather than blanked: a field that exists and happens to be empty
			// is one refactor away from being filled in again.
			expect(handler.redact({ url: 'https://ntfy.sh', topic: 'loft', token: 'tk_secret' })).toEqual({
				url: 'https://ntfy.sh',
				topic: 'loft',
			});
		});
	});
});
