import 'reflect-metadata';
import type { PeerIdentity } from '@mcs/shared';
import { PeerRepository } from '@/repositories';
import { findProviderByName, reportMissing, runCommand } from './context';

/** The one method this command needs from whatever ends up owning the peer identity. */
interface IdentityHolder {
	identity(): Promise<PeerIdentity>;
}

/**
 * Prints this gateway's own identity — the fingerprint a friend links against.
 *
 * Useful outside the interface because it is what you read out loud, or paste into a
 * message, when somebody asks whether the invitation they received is really yours.
 */
runCommand(async (app) => {
	const holder = findProviderByName<IdentityHolder>(app, 'PeerManager');

	if (holder === null) {
		const linked = await app.get(PeerRepository).findLinked();

		reportMissing('PeerManager');
		process.stdout.write(`Linked peers today: ${linked.length}.\n`);

		return;
	}

	const identity = await holder.identity();

	process.stdout.write(
		[
			`name         ${identity.name}`,
			`fingerprint  ${identity.fingerprint}`,
			`rendezvous   ${identity.rendezvous}`,
			`direct       ${identity.directAddress ?? 'none'}${identity.directReachable ? '' : ' (relay only)'}`,
		].join('\n') + '\n',
	);
});
