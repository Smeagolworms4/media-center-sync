import { ShareVisibility, type Settings } from '@mcs/shared';

/** Everything the rule below reads, and nothing else. */
export interface ShareSubject {
	/**
	 * The library being asked about.
	 *
	 * Part of the question rather than of the answer: no field of it is read here, but
	 * every caller has one in hand, and a resolver taking a bare pair of flags is one
	 * that can be called without knowing which library it is answering for — which is
	 * exactly how the wrong policy ends up paired with the wrong library.
	 */
	library: { id: string; serviceId: string };
	/** The stored policy, or null when nothing was ever written for this library. */
	policy: { visibility: ShareVisibility } | null;
	/** Whether the service this library sits on is one of ours to give. */
	local: boolean;
	settings: Pick<Settings, 'defaultShareVisibility'>;
}

/**
 * What one library is visible to, once the gateway's default has been applied.
 *
 * Resolved at read time rather than written into a row when a scan discovers a
 * library, and that is the whole design. Materialising the default into every install
 * would freeze today's answer there — changing the setting afterwards would move
 * nothing, because every library would already hold a row saying what it was on the
 * day it was scanned — and it would switch sharing on for data somebody already has,
 * which is not a decision a migration gets to make. Resolved late, changing the
 * default changes every library nobody has overridden, which is what a default is
 * for.
 *
 * Three rules, in this order:
 *
 * - **a stored policy always wins**, including an explicit `private` on one of our own
 *   libraries. Somebody choosing private is a decision, and a default that could
 *   overrule a decision would not be a default, it would be a policy;
 * - **no policy on a library of ours means the gateway default.** A gateway whose
 *   libraries are invisible until somebody has visited a screen appears broken to the
 *   friend who linked to it: they see an empty shelf and conclude the link failed,
 *   while the setting says `friends_of_friends`;
 * - **no policy on anything else means private**, whatever the setting says. A library
 *   on a remote Jellyfin or Plex, or on a peer's gateway, is not ours to give: sharing
 *   it makes us the conduit for somebody else's disk, spending our bandwidth and
 *   passing on an access granted to us rather than to the people we would be handing
 *   it to. That is the `SharePolicy.relay` consent, and a default is not consent.
 */
export const effectiveVisibility = (subject: ShareSubject): ShareVisibility => {
	if (subject.policy !== null) {
		return subject.policy.visibility;
	}

	return subject.local ? subject.settings.defaultShareVisibility : ShareVisibility.PRIVATE;
};
