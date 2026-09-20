import {
	CanActivate,
	ExecutionContext,
	Inject,
	Injectable,
	Optional,
	UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorKey, PeerStatus } from '@mcs/shared';
import { PEER_ROUTE, type AuthenticatedRequest } from '@/decorators';
import { PeerRepository } from '@/repositories';

/** `Authorization: Peer <fingerprint>:<token>` */
const SCHEME = /^Peer\s+([^:\s]+):(.+)$/i;

/**
 * Proves a peer credential really belongs to that peer.
 *
 * The check is cryptographic and belongs to the link service, which holds the session
 * keys established when the link was opened. The guard only knows it has to ask.
 */
export interface PeerCredentialVerifier {
	verify(fingerprint: string, token: string): Promise<boolean>;
}

export const PEER_CREDENTIAL_VERIFIER = 'mcs:peer-credential-verifier';

/**
 * Guards the routes another gateway calls.
 *
 * Everything not marked `@PeerRoute()` goes straight through: this guard has nothing
 * to say about the interface's own endpoints, which the rights guard handles.
 */
@Injectable()
export class PeerGuard implements CanActivate {
	public constructor(
		private readonly _reflector: Reflector,
		private readonly _peers: PeerRepository,
		@Optional()
		@Inject(PEER_CREDENTIAL_VERIFIER)
		private readonly _verifier?: PeerCredentialVerifier,
	) {}

	public async canActivate(context: ExecutionContext): Promise<boolean> {
		const isPeerRoute = this._reflector.getAllAndOverride<boolean>(PEER_ROUTE, [
			context.getHandler(),
			context.getClass(),
		]);

		if (isPeerRoute !== true) {
			return true;
		}

		const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
		const match = SCHEME.exec(request.headers.authorization ?? '');

		if (match === null) {
			throw new UnauthorizedException(ErrorKey.PEER_REJECTED);
		}

		const [, fingerprint, token] = match;
		const peer = await this._peers.findByFingerprint(fingerprint);

		// Only an established link may call these routes, and that is about the link
		// alone. A peer forbidden from reading is *not* refused here on purpose: they
		// stay linked, their requests are answered, and every one of those answers is
		// empty because `ShareManager.visiblePolicies` shows them nothing. Refusing
		// them at the door instead would close the link in both directions, which is
		// precisely the behaviour that action was rewritten to stop.
		if (peer === null || peer.status !== PeerStatus.LINKED) {
			throw new UnauthorizedException(ErrorKey.PEER_REJECTED);
		}

		// No verifier registered means the credential cannot be checked at all, and an
		// unchecked peer route hands the whole catalogue to whoever guesses a
		// fingerprint — which is public by design. Refusing is the only safe reading.
		if (this._verifier === undefined || !(await this._verifier.verify(fingerprint, token))) {
			throw new UnauthorizedException(ErrorKey.PEER_REJECTED);
		}

		request.peerId = peer.id;

		return true;
	}
}
