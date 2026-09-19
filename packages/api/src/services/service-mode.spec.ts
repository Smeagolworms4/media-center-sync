import { MediaServiceMode, MediaServiceScope } from '@mcs/shared';
import { serviceMode } from './service-mode';

describe('serviceMode', () => {
	it('reads a service of our own with a reachable disk as local', () => {
		expect(serviceMode({ scope: MediaServiceScope.LOCAL, peerId: null })).toBe(
			MediaServiceMode.LOCAL,
		);
	});

	it('reads a plain Jellyfin we only have an account on as remote', () => {
		expect(serviceMode({ scope: MediaServiceScope.REMOTE, peerId: null })).toBe(
			MediaServiceMode.REMOTE,
		);
	});

	it('reads anything behind a peer as a peer, whatever its scope says', () => {
		// The scope here is the one the *friend* declared: their server is local to
		// them. Reading it as local to us would plan a transfer onto their path.
		expect(serviceMode({ scope: MediaServiceScope.LOCAL, peerId: 'friend' })).toBe(
			MediaServiceMode.PEER,
		);
		expect(serviceMode({ scope: MediaServiceScope.REMOTE, peerId: 'friend' })).toBe(
			MediaServiceMode.PEER,
		);
	});
});
