import { RendezvousClient, type RendezvousRegistration } from './rendezvous.client';

const RENDEZVOUS = 'https://meet.example.org/';

function registration(): RendezvousRegistration {
	return {
		fingerprint: 'abc123',
		name: 'Home',
		directAddress: '203.0.113.7:7443',
		signature: 'signed',
		publicKey: 'key',
	};
}

describe('RendezvousClient', () => {
	const client = new RendezvousClient();
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	function stub(status: number, body: unknown = {}): jest.Mock {
		const mock = jest.fn(async () => ({
			ok: status >= 200 && status < 300,
			status,
			headers: new Headers(),
			json: async () => body,
			text: async () => JSON.stringify(body),
		})) as unknown as jest.Mock;

		global.fetch = mock as unknown as typeof fetch;

		return mock;
	}

	describe('register', () => {
		it('announces where we are', async () => {
			const fetchMock = stub(200);

			await client.register(RENDEZVOUS, registration());

			expect(String(fetchMock.mock.calls[0][0])).toBe('https://meet.example.org/register');
			expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
		});

		it('does not take the gateway down with it', async () => {
			// Direct links keep working, and relayed ones start working again when it
			// comes back.
			global.fetch = jest.fn(async () => {
				throw new Error('offline');
			}) as unknown as typeof fetch;

			await expect(client.register(RENDEZVOUS, registration())).resolves.toBeUndefined();
		});
	});

	describe('lookup', () => {
		it('returns the record the rendezvous holds', async () => {
			stub(200, { fingerprint: 'abc123', address: '203.0.113.7:7443', directReachable: true });

			expect(await client.lookup(RENDEZVOUS, 'abc123')).toMatchObject({
				address: '203.0.113.7:7443',
			});
		});

		it('answers null for a fingerprint it does not know', async () => {
			stub(404);

			expect(await client.lookup(RENDEZVOUS, 'nobody')).toBeNull();
		});

		it('escapes the fingerprint in the path', async () => {
			const fetchMock = stub(200, {});

			await client.lookup(RENDEZVOUS, 'a/b');

			expect(String(fetchMock.mock.calls[0][0])).toBe('https://meet.example.org/peers/a%2Fb');
		});
	});

	describe('introduce', () => {
		it('passes the introduction on', async () => {
			stub(200, { address: '203.0.113.7:7443', token: 'one-shot', relayUrl: null });

			expect(await client.introduce(RENDEZVOUS, 'abc123', 'signature')).toMatchObject({
				address: '203.0.113.7:7443',
				token: 'one-shot',
			});
		});

		it('falls back to a relay when the introduction itself fails', async () => {
			// Which is precisely the moment a relay is needed.
			stub(500);

			expect(await client.introduce(RENDEZVOUS, 'abc123', 'signature')).toEqual({
				address: null,
				token: null,
				relayUrl: 'wss://meet.example.org/relay/abc123',
			});
		});
	});

	describe('relayUrl', () => {
		it('derives the websocket endpoint from the rendezvous address', () => {
			expect(client.relayUrl('https://meet.example.org', 'abc123')).toBe(
				'wss://meet.example.org/relay/abc123',
			);
		});

		it('stays unencrypted when the rendezvous is', () => {
			expect(client.relayUrl('http://localhost:9000', 'abc123')).toBe(
				'ws://localhost:9000/relay/abc123',
			);
		});

		it('keeps a rendezvous mounted under a path', () => {
			expect(client.relayUrl('https://example.org/mcs/', 'abc123')).toBe(
				'wss://example.org/mcs/relay/abc123',
			);
		});
	});
});
