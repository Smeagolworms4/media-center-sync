import { ShareVisibility } from '@mcs/shared';
import { effectiveVisibility, type ShareSubject } from './share-visibility';

const library = { id: 'library-1', serviceId: 'service-1' };

const subject = (overrides: Partial<ShareSubject> = {}): ShareSubject => ({
	library,
	policy: null,
	local: true,
	settings: { defaultShareVisibility: ShareVisibility.FRIENDS_OF_FRIENDS },
	...overrides,
});

describe('effectiveVisibility', () => {
	describe('with no policy row', () => {
		it('gives a library of ours the gateway default', () => {
			expect(effectiveVisibility(subject())).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
		});

		it('follows the default wherever it is set, which is the point of resolving late', () => {
			expect(
				effectiveVisibility(
					subject({ settings: { defaultShareVisibility: ShareVisibility.FRIENDS } }),
				),
			).toBe(ShareVisibility.FRIENDS);

			expect(
				effectiveVisibility(
					subject({ settings: { defaultShareVisibility: ShareVisibility.PRIVATE } }),
				),
			).toBe(ShareVisibility.PRIVATE);
		});

		it('keeps a library that is not ours private whatever the default says', () => {
			// Sharing it would make us the conduit for somebody else's disk: our
			// bandwidth, and an access granted to us rather than to our friends. That is
			// the relay consent, and a default is not consent.
			for (const fallback of Object.values(ShareVisibility)) {
				expect(
					effectiveVisibility(
						subject({ local: false, settings: { defaultShareVisibility: fallback } }),
					),
				).toBe(ShareVisibility.PRIVATE);
			}
		});
	});

	describe('with a policy row', () => {
		it('takes what the row says on a library of ours', () => {
			expect(
				effectiveVisibility(subject({ policy: { visibility: ShareVisibility.FRIENDS } })),
			).toBe(ShareVisibility.FRIENDS);
		});

		it('keeps an explicit private on a library of ours private', () => {
			// The case the default must never win: an override to private is a decision,
			// and a decision outranks a setting somebody changed months later.
			expect(
				effectiveVisibility(subject({ policy: { visibility: ShareVisibility.PRIVATE } })),
			).toBe(ShareVisibility.PRIVATE);
		});

		it('takes what the row says on a library that is not ours', () => {
			// Relaying was agreed to when the row was written — the manager refuses to
			// save this combination otherwise — so the row is the answer here too.
			expect(
				effectiveVisibility(
					subject({ local: false, policy: { visibility: ShareVisibility.FRIENDS } }),
				),
			).toBe(ShareVisibility.FRIENDS);
		});

		it('keeps an explicit private on a library that is not ours private', () => {
			expect(
				effectiveVisibility(
					subject({ local: false, policy: { visibility: ShareVisibility.PRIVATE } }),
				),
			).toBe(ShareVisibility.PRIVATE);
		});

		it('ignores the default entirely, whichever way the two disagree', () => {
			expect(
				effectiveVisibility(
					subject({
						policy: { visibility: ShareVisibility.FRIENDS_OF_FRIENDS },
						settings: { defaultShareVisibility: ShareVisibility.PRIVATE },
					}),
				),
			).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
		});
	});
});
