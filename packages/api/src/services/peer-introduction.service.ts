import {
	INTRODUCTION_CLOCK_SKEW_MS,
	INTRODUCTION_TTL_MS,
	INTRODUCTION_VERSION,
	IntroductionRefusal,
	type PeerIntroductionClaim,
} from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { PeerLinkService } from './peer-link.service';

/**
 * What comes back from reading a token: the claim, or why it is worth nothing.
 *
 * A union rather than null plus a log line, because the caller has two different jobs
 * with the answer — admit the link, and say in its own log which of six things went
 * wrong — and a boolean cannot carry the second.
 */
export type IntroductionCheck =
	| { ok: true; claim: PeerIntroductionClaim }
	| { ok: false; refusal: IntroductionRefusal };

/**
 * Minting and checking the token that introduces two gateways.
 *
 * A service rather than a manager because it decides nothing: whether somebody may be
 * introduced, and whether an introducer is a peer of ours at all, are questions about
 * trust and live one layer up. This turns a claim into a signed string and back, and
 * refuses anything that is not cryptographically and temporally sound.
 *
 * The encoding is two base64url segments separated by a dot — payload and signature —
 * which is a JWS compact serialisation with the header left out. A header would only
 * carry an algorithm, and offering a choice of algorithm in a token is how a verifier
 * ends up honouring `alg: none`. There is one algorithm here: the Ed25519 key every
 * gateway already has.
 */
@Injectable()
export class PeerIntroductionService {
	public constructor(private readonly _links: PeerLinkService) {}

	/**
	 * Sign an introduction, as the gateway in the middle.
	 *
	 * The life is fixed rather than configurable. It is long enough for one dial —
	 * direct, then an introduction, then relayed — and a setting for it would be a knob
	 * whose only useful direction is shorter, on a value nobody can reason about
	 * without knowing the dial budget. See `INTRODUCTION_TTL_MS`.
	 */
	public issue(subject: string, holder: string, depth: number): { token: string; claim: PeerIntroductionClaim } {
		const issuedAt = Date.now();
		const claim: PeerIntroductionClaim = {
			v: INTRODUCTION_VERSION,
			introducer: this._links.fingerprint,
			subject,
			holder,
			depth,
			issuedAt,
			expiresAt: issuedAt + INTRODUCTION_TTL_MS,
		};
		const payload = this._encode(claim);

		return { token: `${payload}.${this._toBase64Url(this._links.sign(payload))}`, claim };
	}

	/**
	 * What a token says, without believing any of it.
	 *
	 * The holder needs this before it can verify: the claim names the introducer, and
	 * the introducer is what says which public key to check the signature against. A
	 * caller that acted on this without calling `verify` afterwards would be trusting a
	 * string somebody sent it, which is why the two are separate methods with names
	 * that cannot be confused.
	 */
	public read(token: string): PeerIntroductionClaim | null {
		const [payload] = token.split('.');

		if (payload === undefined || payload === '') {
			return null;
		}

		try {
			const claim = JSON.parse(
				Buffer.from(payload, 'base64url').toString('utf8'),
			) as Partial<PeerIntroductionClaim>;

			if (
				claim.v !== INTRODUCTION_VERSION ||
				typeof claim.introducer !== 'string' ||
				typeof claim.subject !== 'string' ||
				typeof claim.holder !== 'string' ||
				typeof claim.depth !== 'number' ||
				typeof claim.issuedAt !== 'number' ||
				typeof claim.expiresAt !== 'number'
			) {
				return null;
			}

			return claim as PeerIntroductionClaim;
		} catch {
			// Anything that is not a token at all lands here — a truncated header, a
			// value somebody pasted, an empty string. All of them mean the same thing.
			return null;
		}
	}

	/**
	 * Is this token really the introducer's, and is it still worth anything?
	 *
	 * Three checks, and all three are needed. The signature has to verify against the
	 * key we hold for that introducer — not against a key the token carries, which
	 * would be a token vouching for itself. The payload has to be the one that was
	 * signed, which falls out of verifying the encoded segment rather than a
	 * re-serialisation of the parsed object: two JSON encoders disagree about key order
	 * and about how a number is spelled, and re-serialising is how a tampered token
	 * passes a signature check on a payload nobody sent.
	 *
	 * And it has to be inside its life, allowing for two clocks that belong to two
	 * households. The window is the token's own plus the skew each way; a token whose
	 * issuer claimed a longer life than this gateway is willing to honour is refused on
	 * its stated life, so nobody can mint themselves a year of access by editing a
	 * field before signing it.
	 */
	public verify(token: string, introducerPublicKey: string, now = Date.now()): IntroductionCheck {
		const claim = this.read(token);
		const [payload, signature] = token.split('.');

		if (claim === null || payload === undefined || !signature) {
			return { ok: false, refusal: IntroductionRefusal.MALFORMED };
		}

		if (!this._links.verify(introducerPublicKey, payload, this._fromBase64Url(signature))) {
			return { ok: false, refusal: IntroductionRefusal.UNVERIFIED };
		}

		if (claim.expiresAt - claim.issuedAt > INTRODUCTION_TTL_MS) {
			return { ok: false, refusal: IntroductionRefusal.EXPIRED };
		}

		if (
			now > claim.expiresAt + INTRODUCTION_CLOCK_SKEW_MS ||
			now < claim.issuedAt - INTRODUCTION_CLOCK_SKEW_MS
		) {
			return { ok: false, refusal: IntroductionRefusal.EXPIRED };
		}

		return { ok: true, claim };
	}

	/**
	 * The payload, encoded once and signed as encoded.
	 *
	 * Private on purpose: the signed bytes and the bytes that travel have to be the
	 * same string, and the only way to guarantee that is for one method to produce it.
	 */
	private _encode(claim: PeerIntroductionClaim): string {
		return Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
	}

	/** Base64url so the whole token survives an HTTP header untouched. */
	private _toBase64Url(base64: string): string {
		return Buffer.from(base64, 'base64').toString('base64url');
	}

	private _fromBase64Url(value: string): string {
		return Buffer.from(value, 'base64url').toString('base64');
	}
}
