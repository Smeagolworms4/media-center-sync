import { MediaServiceMode } from '@mcs/shared';
import { reachesFiles, serviceMode } from './service-mode';

describe('reachesFiles', () => {
	it('reads a service with a root mapping as one whose files we hold', () => {
		expect(reachesFiles({ rootMappings: [{ remoteRoot: '/media', localRoot: '/mnt/nas' }] }, []))
			.toBe(true);
	});

	it('counts a mapping no library sits under yet', () => {
		// A declaration that the gateway reaches that disk. The library the server adds
		// there tomorrow derives its path at the next probe; turning the service remote
		// until then would take it out of the destinations for no reason anybody set.
		const rootMappings = [
			{ remoteRoot: '/data/movies', localRoot: '/mnt/nas1/movies' },
			{ remoteRoot: '/srv/unused', localRoot: '/mnt/nas2/unused' },
		];

		expect(reachesFiles({ rootMappings }, [{ localPath: null }])).toBe(true);
	});

	it('reads a service with no mapping at all as one we only reach over HTTP', () => {
		// The owner's own case: a Jellyfin on the same network, reachable, scanning
		// fine, and with nothing anywhere telling this gateway where its files are.
		expect(reachesFiles({ rootMappings: [] }, [{ localPath: null }])).toBe(false);
	});

	it('accepts a library path as a mapping of its own', () => {
		// A service whose only mapping is one library's explicit path is just as
		// mounted as one with a mapping: that field exists for the exceptions the
		// mappings cannot express, and a service holding only those is not a remote service.
		expect(reachesFiles({ rootMappings: [] }, [{ localPath: null }, { localPath: '/mnt/x' }]))
			.toBe(true);
	});

	it('ignores an empty string, which is a box somebody cleared rather than a path', () => {
		expect(reachesFiles({ rootMappings: [] }, [{ localPath: '' }])).toBe(false);
	});
});

describe('serviceMode', () => {
	it('reads a service whose files this gateway reaches as local', () => {
		expect(serviceMode({ filesMounted: true, peerId: null })).toBe(MediaServiceMode.LOCAL);
	});

	it('reads a service we only talk to over HTTP as remote', () => {
		expect(serviceMode({ filesMounted: false, peerId: null })).toBe(MediaServiceMode.REMOTE);
	});

	it('reads anything behind a peer as a peer, mounted or not', () => {
		// A row that arrived mounted — by a bug, or by a hand on the database — must
		// still not be offered as a destination: we cannot write into their disk, and
		// the failure would arrive at the end of a completed download.
		expect(serviceMode({ filesMounted: true, peerId: 'friend' })).toBe(MediaServiceMode.PEER);
		expect(serviceMode({ filesMounted: false, peerId: 'friend' })).toBe(MediaServiceMode.PEER);
	});

	it('flips when a mapping lands, because it reads the fact and not a declaration', () => {
		const registered = { rootMappings: [] as { remoteRoot: string; localRoot: string }[], peerId: null };
		const libraries = [{ localPath: null }];

		expect(serviceMode({ filesMounted: reachesFiles(registered, libraries), peerId: null }))
			.toBe(MediaServiceMode.REMOTE);

		const mapped = { ...registered, rootMappings: [{ remoteRoot: '/media', localRoot: '/mnt/nas' }] };

		expect(serviceMode({ filesMounted: reachesFiles(mapped, libraries), peerId: null }))
			.toBe(MediaServiceMode.LOCAL);
	});
});
