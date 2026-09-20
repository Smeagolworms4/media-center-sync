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
	/** Whether somebody turned the sharing switch on for the service this sits on. */
	shared: boolean;
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
 * Two rules, in this order:
 *
 * - **a stored policy always wins**, in both directions, including an explicit
 *   `private` on a service that is shared and an explicit level on one that is not.
 *   Somebody choosing private is a decision, and a default that could overrule a
 *   decision would not be a default, it would be a policy;
 * - **otherwise the service's switch decides**, and the gateway default is the level
 *   it grants. On means `defaultShareVisibility`, whatever it is set to, so changing
 *   that setting later still moves every library nobody has overridden. Off means
 *   private.
 *
 * The switch is read here and the mount is not, which is the correction this rule
 * exists to carry. The two were one thing before: the default reached only libraries
 * whose files the gateway held, on the reasoning that sharing anything else makes us
 * the conduit for somebody else's server. That is true and it is also not a reason to
 * refuse — serving those bytes works, it is `PeerExchangeManager.content()` reading
 * the media server over HTTP, and it is often exactly what somebody with a good line
 * wants. What it needed was to be said out loud once, which is what the switch is.
 * Conflated, the commonest case of all — an ordinary Jellyfin whose folders nobody had
 * mapped yet — was silently private with no control anywhere that could change it.
 */
export const effectiveVisibility = (subject: ShareSubject): ShareVisibility => {
	if (subject.policy !== null) {
		return subject.policy.visibility;
	}

	return subject.shared ? subject.settings.defaultShareVisibility : ShareVisibility.PRIVATE;
};
