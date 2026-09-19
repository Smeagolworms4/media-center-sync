import type { Library, Peer, SharePolicy } from '@mcs/shared';
import { LibraryKind, PeerStatus, PeerTrust, ShareVisibility } from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ShareAudit from '@/components/share/ShareAudit.vue';
import SharePolicyForm from '@/components/share/SharePolicyForm.vue';
import { mountWithApp, stubFetch } from './helpers';

const library: Library = {
	id: 'l1',
	serviceId: 's1',
	externalId: 'x',
	name: 'Home videos',
	alias: null,
	position: 0,
	kind: LibraryKind.OTHER,
	paths: [],
	localPath: null,
	writable: false,
	isDefaultTarget: false,
	itemCount: 12,
	lastScanAt: null,
	lastRefreshAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

const peers: Peer[] = [{
	id: 'p1',
	name: 'Bob',
	nodeId: null,
	fingerprint: 'AB',
	status: PeerStatus.LINKED,
	direction: null,
	trust: PeerTrust.FRIEND,
	linkMode: null,
	address: null,
	viaPeerId: null,
	viaPeerName: null,
	serviceCount: 1,
	sharedItemCount: 0,
	lastSeenAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
}];

function policy (overrides: Partial<SharePolicy> = {}): SharePolicy {
	return {
		id: 'sp1',
		libraryId: 'l1',
		libraryName: 'Home videos',
		serviceId: 's1',
		visibility: ShareVisibility.FRIENDS,
		allowedPeerIds: [],
		deniedPeerIds: [],
		relays: false,
		relay: false,
		rateLimit: 0,
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

async function settle (): Promise<void> {
	for (let index = 0; index < 4; index += 1) {
		await nextTick();
		await new Promise(resolve => {
			setTimeout(resolve, 0);
		});
	}
}

describe('components/share/SharePolicyForm', () => {
	/** A private library has nobody to allow or deny, so those fields are not there. */
	it('shows no peer list while the library is private', () => {
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers, policy: null },
		});

		expect(wrapper.find('[data-test="share-allowed"]').exists()).toBe(false);
		expect(wrapper.find('[data-test="share-remove"]').exists()).toBe(false);
	});

	it('shows the lists and the cap once the library is shared', () => {
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers, policy: policy() },
		});

		expect(wrapper.find('[data-test="share-allowed"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="share-denied"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="share-rate-limit"]').exists()).toBe(true);
	});

	it('offers to make a shared library private again, which is a deletion', async () => {
		stubFetch([{}]);
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers, policy: policy() },
		});

		await wrapper.find('[data-test="share-remove"]').trigger('click');
		await settle();

		expect(wrapper.emitted('removed')?.[0]).toEqual(['l1']);
	});

	it('turns a typed cap into the byte count the API takes', async () => {
		const stub = stubFetch([{ body: policy({ rateLimit: 2 * 1024 ** 2 }) }]);
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers, policy: policy({ rateLimit: 2 * 1024 ** 2 }) },
		});

		(wrapper.vm as any).form.handle();
		await settle();

		const body = JSON.parse(String(stub.mock.calls[0][1]?.body));
		expect(body.rateLimit).toBe(2 * 1024 ** 2);
		expect(stub.mock.calls[0][1]?.method).toBe('PUT');
	});
});

describe('components/share/ShareAudit', () => {
	it('asks nothing until a peer is chosen, and says why it is empty', () => {
		const { wrapper } = mountWithApp(ShareAudit, { props: { peers } });

		expect(wrapper.text()).toContain('Pick a peer');
	});

	it('answers what that peer would see, library by library', async () => {
		stubFetch([{
			body: {
				peerId: 'p1',
				peerName: 'Bob',
				trust: 'friend',
				libraries: [{ libraryId: 'l1', name: 'Shows', itemCount: 400 }],
			},
		}]);
		const { wrapper } = mountWithApp(ShareAudit, { props: { peers, peerId: 'p1' } });
		await settle();

		expect(wrapper.findAll('[data-test="audit-library"]')).toHaveLength(1);
		expect(wrapper.text()).toContain('Shows');
		expect(wrapper.text()).toContain('400');
		expect(wrapper.text()).toContain('Bob');
	});

	/** "Nothing" is an answer, and the one people most want to be sure of. */
	it('says plainly when a peer would see nothing at all', async () => {
		stubFetch([{ body: { peerId: 'p1', peerName: 'Bob', trust: 'friend', libraries: [] } }]);
		const { wrapper } = mountWithApp(ShareAudit, { props: { peers, peerId: 'p1' } });
		await settle();

		expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Nothing at all');
	});

	it('offers a retry when the gateway did not answer', async () => {
		stubFetch([{ status: 500, body: { message: 'error.general' } }]);
		const { wrapper } = mountWithApp(ShareAudit, { props: { peers, peerId: 'p1' } });
		await settle();

		expect(wrapper.find('.error-state').exists()).toBe(true);
	});
});
