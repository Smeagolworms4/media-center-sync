import { Injectable, Logger } from '@nestjs/common';

export interface RendezvousRegistration {
	fingerprint: string;
	name: string;
	/** Address peers may try directly. Null when the port is not forwarded. */
	directAddress: string | null;
	/** Signature over the registration, so the rendezvous cannot invent entries. */
	signature: string;
	publicKey: string;
}

export interface RendezvousPeerRecord {
	fingerprint: string;
	name: string | null;
	address: string | null;
	publicKey: string | null;
	directReachable: boolean;
	lastSeenAt: string | null;
}

export interface RendezvousIntroduction {
	/** Where to try a direct connection, when there is somewhere. */
	address: string | null;
	/** One-shot token the far end will check, so an introduction cannot be replayed. */
	token: string | null;
	/** Relay endpoint to fall back to. */
	relayUrl: string | null;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The middle server that lets two gateways behind two routers find each other.
 *
 * What it is trusted with: knowing that a fingerprint is currently at an address,
 * and passing a connection request along. What it is emphatically not trusted with:
 * reading anything. Identity is a key pair held by each gateway, every introduction
 * is signed by the gateway it claims to come from, and a relayed link carries
 * traffic the rendezvous cannot interpret. A rendezvous that lies can stop two
 * peers from meeting and can point one at an address of its choosing — which is
 * why the far end's fingerprint is verified after connecting, not before — but it
 * cannot read a catalogue, authorise a transfer, or impersonate anybody.
 *
 * It is also optional. Two gateways on the same network link directly and never
 * register anywhere, which is the configuration this design exists to keep possible.
 */
@Injectable()
export class RendezvousClient {
	private readonly _logger = new Logger(RendezvousClient.name);

	/**
	 * Announce that we exist and where we are.
	 *
	 * Repeated periodically rather than once, because the address changes and because
	 * the rendezvous is entitled to forget a gateway that stopped talking — an
	 * address it keeps serving after the machine is gone costs everybody a timeout.
	 */
	public async register(
		rendezvousUrl: string,
		registration: RendezvousRegistration,
	): Promise<void> {
		await this._post(rendezvousUrl, '/register', registration).catch((error: unknown) => {
			// A rendezvous that is down must not stop the gateway: direct links keep
			// working, and relayed ones start working again when it comes back.
			this._logger.warn(`Rendezvous registration failed: ${String(error)}`);
		});
	}

	/** Where a fingerprint currently claims to be, if the rendezvous knows. */
	public async lookup(
		rendezvousUrl: string,
		fingerprint: string,
	): Promise<RendezvousPeerRecord | null> {
		return this._get<RendezvousPeerRecord>(
			rendezvousUrl,
			`/peers/${encodeURIComponent(fingerprint)}`,
		).catch(() => null);
	}

	/**
	 * Ask to be introduced.
	 *
	 * The rendezvous tells both ends about each other at the same moment, which is
	 * what lets two routers each see an outgoing packet and let the other's in. When
	 * that fails — and behind a symmetric NAT it always does — the answer carries a
	 * relay endpoint instead, and the link costs the rendezvous' bandwidth rather
	 * than failing.
	 */
	public async introduce(
		rendezvousUrl: string,
		fingerprint: string,
		signature: string,
	): Promise<RendezvousIntroduction> {
		const answer = await this._post<RendezvousIntroduction>(rendezvousUrl, '/introduce', {
			fingerprint,
			signature,
		}).catch(() => null);

		return (
			answer ?? {
				address: null,
				token: null,
				relayUrl: this.relayUrl(rendezvousUrl, fingerprint),
			}
		);
	}

	/**
	 * The relay endpoint for a fingerprint.
	 *
	 * Derived rather than asked for, so a gateway can fall back to relaying even when
	 * the introduction call itself failed — which is precisely the moment it needs to.
	 */
	public relayUrl(rendezvousUrl: string, fingerprint: string): string {
		const url = new URL(rendezvousUrl);

		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/relay/${encodeURIComponent(fingerprint)}`;

		return url.toString();
	}

	private async _get<T>(base: string, path: string): Promise<T> {
		const response = await fetch(this._url(base, path), {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new Error(`rendezvous answered ${response.status}`);
		}

		return (await response.json()) as T;
	}

	private async _post<T>(base: string, path: string, body: unknown): Promise<T> {
		const response = await fetch(this._url(base, path), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new Error(`rendezvous answered ${response.status}`);
		}

		const text = await response.text();

		return (text ? JSON.parse(text) : {}) as T;
	}

	private _url(base: string, path: string): string {
		return `${base.replace(/\/+$/, '')}${path}`;
	}
}
