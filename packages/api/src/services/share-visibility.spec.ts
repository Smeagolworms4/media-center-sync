import { ShareVisibility } from '@mcs/shared';
import { effectiveVisibility, type ShareSubject } from './share-visibility';

const library = { id: 'library-1', serviceId: 'service-1' };

const subject = (overrides: Partial<ShareSubject> = {}): ShareSubject => ({
	library,
	policy: null,
	shared: true,
	settings: { defaultShareVisibility: ShareVisibility.FRIENDS_OF_FRIENDS },
	...overrides,
});

describe('effectiveVisibility', () => {
	describe('with no policy row', () => {
		it('gives a library on a shared service the gateway default', () => {
			expect(effectiveVisibility(subject())).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
		});

		it('follows the default wherever it is set, which is the point of resolving late', () => {
			// The switch grants a level rather than copying one: somebody who moves the
			// setting months later moves every library nobody has overridden with it.
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

		it('keeps a library on a service nobody shares private whatever the default says', () => {
			for (const fallback of Object.values(ShareVisibility)) {
				expect(
					effectiveVisibility(
						subject({ shared: false, settings: { defaultShareVisibility: fallback } }),
					),
				).toBe(ShareVisibility.PRIVATE);
			}
		});

		it('reads the switch and not the mount, which is the whole correction', () => {
			// A Jellyfin whose folders nobody has mapped is shared when somebody said
			// so. We serve it by reading the media server over HTTP and passing the
			// bytes on, which works; refusing it used to make the commonest case of all
			// silently private with no control anywhere that could change it.
			expect(effectiveVisibility(subject({ shared: true }))).toBe(
				ShareVisibility.FRIENDS_OF_FRIENDS,
			);
		});
	});

	describe('with a policy row', () => {
		it('takes what the row says on a shared service', () => {
			expect(
				effectiveVisibility(subject({ policy: { visibility: ShareVisibility.FRIENDS } })),
			).toBe(ShareVisibility.FRIENDS);
		});

		it('keeps an explicit private on a shared service private', () => {
			// The case the default must never win: an override to private is a decision,
			// and a decision outranks a setting somebody changed months later.
			expect(
				effectiveVisibility(subject({ policy: { visibility: ShareVisibility.PRIVATE } })),
			).toBe(ShareVisibility.PRIVATE);
		});

		it('takes what the row says on a service nobody shares', () => {
			// The override wins in both directions. One library of an otherwise private
			// service is a decision as much as one private library of a shared one.
			expect(
				effectiveVisibility(
					subject({ shared: false, policy: { visibility: ShareVisibility.FRIENDS } }),
				),
			).toBe(ShareVisibility.FRIENDS);
		});

		it('keeps an explicit private on a service nobody shares private', () => {
			expect(
				effectiveVisibility(
					subject({ shared: false, policy: { visibility: ShareVisibility.PRIVATE } }),
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
