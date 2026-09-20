import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign as signBytes,
	verify as verifyBytes,
} from 'node:crypto';
import { INTRODUCTION_TTL_MS, IntroductionRefusal } from '@mcs/shared';
import { PeerIntroductionService } from './peer-introduction.service';
import type { PeerLinkService } from './peer-link.service';

/**
 * A gateway's key pair, with the two operations the token service asks of it.
 *
 * Real Ed25519 rather than a stub that answers true: the one thing worth knowing
 * about an introduction is that a signature over the bytes that travelled verifies,
 * and a stub would pin the stub. Nothing here opens a socket or touches a disk — the
 * link service is stood in for, because all this needs of it is a key.
 */
const gateway = (fingerprint: string) => {
	const pair = generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});

	return {
		publicKey: pair.publicKey,
		links: {
			fingerprint,
			sign: (payload: string): string =>
				signBytes(null, Buffer.from(payload), createPrivateKey(pair.privateKey)).toString(
					'base64',
				),
			verify: (publicKeyPem: string, payload: string, signature: string): boolean => {
				try {
					return verifyBytes(
						null,
						Buffer.from(payload),
						createPublicKey(publicKeyPem),
						Buffer.from(signature, 'base64'),
					);
				} catch {
					return false;
				}
			},
		} as unknown as PeerLinkService,
	};
};

const INTRODUCER = 'b'.repeat(64);
const SUBJECT = 'a'.repeat(64);
const HOLDER = 'c'.repeat(64);

describe('PeerIntroductionService', () => {
	const middle = gateway(INTRODUCER);
	const service = new PeerIntroductionService(middle.links);

	describe('issuing', () => {
		it('names who may present it, which gateway it opens, and how far apart they are', () => {
			const { token, claim } = service.issue(SUBJECT, HOLDER, 2);

			expect(service.read(token)).toEqual(claim);
			expect(claim).toMatchObject({
				introducer: INTRODUCER,
				subject: SUBJECT,
				holder: HOLDER,
				depth: 2,
			});
		});

		it('gives it a life measured in minutes, not in months', () => {
			// Long enough for one dial — direct, then an introduction, then relayed — and
			// short enough that it is never a credential worth storing.
			const { claim } = service.issue(SUBJECT, HOLDER, 2);

			expect(claim.expiresAt - claim.issuedAt).toBe(INTRODUCTION_TTL_MS);
		});

		it('never names a media, because that is the one thing the introducer must not hold', () => {
			const { claim } = service.issue(SUBJECT, HOLDER, 2);

			expect(Object.keys(claim).sort()).toEqual(
				['depth', 'expiresAt', 'holder', 'introducer', 'issuedAt', 'subject', 'v'],
			);
		});
	});

	describe('checking', () => {
		it('accepts a token against the key of the gateway that signed it', () => {
			const { token, claim } = service.issue(SUBJECT, HOLDER, 2);

			expect(service.verify(token, middle.publicKey)).toEqual({ ok: true, claim });
		});

		it('refuses a token signed by somebody else', () => {
			// The holder checks against the key it already holds for its own peer. A
			// token that vouched for itself would make the introducer's identity a field
			// anybody could fill in.
			const stranger = gateway('d'.repeat(64));
			const { token } = new PeerIntroductionService(stranger.links).issue(SUBJECT, HOLDER, 2);

			expect(service.verify(token, middle.publicKey)).toEqual({
				ok: false,
				refusal: IntroductionRefusal.UNVERIFIED,
			});
		});

		it('refuses a payload that was edited after it was signed', () => {
			// The signature covers the encoded segment rather than a re-serialisation of
			// the parsed object, which is what makes this detectable at all: two JSON
			// encoders disagree about key order, and re-serialising is how a tampered
			// token passes a check on a payload nobody sent.
			const { token } = service.issue(SUBJECT, HOLDER, 2);
			const [payload, signature] = token.split('.');
			const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
				depth: number;
			};

			claim.depth = 1;

			const tampered = `${Buffer.from(JSON.stringify(claim)).toString('base64url')}.${signature}`;

			expect(service.verify(tampered, middle.publicKey)).toEqual({
				ok: false,
				refusal: IntroductionRefusal.UNVERIFIED,
			});
		});

		it('refuses one that has run out, allowing for two clocks in two households', () => {
			const { token } = service.issue(SUBJECT, HOLDER, 2);
			const wellPast = Date.now() + INTRODUCTION_TTL_MS + 10 * 60_000;

			expect(service.verify(token, middle.publicKey, wellPast)).toEqual({
				ok: false,
				refusal: IntroductionRefusal.EXPIRED,
			});
		});

		it('still accepts one from a gateway whose clock is a few minutes out', () => {
			// A refusal here would be indistinguishable from a forged token, and would
			// send somebody looking at their keys for a problem that is a wrong clock.
			const { token } = service.issue(SUBJECT, HOLDER, 2);

			expect(service.verify(token, middle.publicKey, Date.now() - 3 * 60_000).ok).toBe(true);
			expect(service.verify(token, middle.publicKey, Date.now() + 3 * 60_000).ok).toBe(true);
		});

		it('refuses one minted with a longer life than this gateway grants', () => {
			// Signed perfectly well, by a real peer, and still refused: the life is not
			// the issuer's to extend, or a friend could mint themselves a year of access
			// by editing one field before signing it.
			const issuedAt = Date.now();
			const payload = Buffer.from(
				JSON.stringify({
					v: 1,
					introducer: INTRODUCER,
					subject: SUBJECT,
					holder: HOLDER,
					depth: 2,
					issuedAt,
					expiresAt: issuedAt + 365 * 24 * 3_600_000,
				}),
			).toString('base64url');
			const token = `${payload}.${Buffer.from(middle.links.sign(payload), 'base64').toString('base64url')}`;

			expect(service.verify(token, middle.publicKey)).toEqual({
				ok: false,
				refusal: IntroductionRefusal.EXPIRED,
			});
		});

		it('reads anything that is not a token at all as malformed', () => {
			expect(service.read('')).toBeNull();
			expect(service.read('not-a-token')).toBeNull();
			expect(service.verify('nonsense', middle.publicKey)).toEqual({
				ok: false,
				refusal: IntroductionRefusal.MALFORMED,
			});
		});
	});
});
