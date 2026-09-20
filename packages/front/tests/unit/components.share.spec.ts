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
	protocol: 1,
	capabilities: [],
	fingerprint: 'AB',
	status: PeerStatus.LINKED,
	direction: null,
	trust: PeerTrust.FRIEND,
	depth: 1,
	maxDepth: null,
	readingForbidden: false,
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
		overridden: true,
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

	/**
	 * A library nobody has configured still arrives with a policy, and the form has to
	 * say so: what it shows is the gateway default applying, and it will move when that
	 * default moves. There is also nothing to delete, so nothing offers to.
	 */
	it('says when the library is only following the gateway default', () => {
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: {
				library,
				peers,
				policy: policy({ id: '', overridden: false, updatedAt: '' }),
			},
		});

		const note = wrapper.find('[data-test="share-origin-note"]');

		expect(note.attributes('data-origin')).toBe('default');
		expect(note.text()).toContain('follows the gateway default');
		expect(wrapper.find('[data-test="share-remove"]').exists()).toBe(false);
	});

	it('says when the library is not ours to share, which no default can change', () => {
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: {
				library,
				peers,
				policy: policy({
					id: '',
					overridden: false,
					relays: true,
					visibility: ShareVisibility.PRIVATE,
					updatedAt: '',
				}),
			},
		});

		const note = wrapper.find('[data-test="share-origin-note"]');

		expect(note.attributes('data-origin')).toBe('not_ours');
		expect(note.text()).toContain('not ours');
	});

	it('says when somebody set this library, and offers to drop that', () => {
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers, policy: policy() },
		});

		expect(wrapper.find('[data-test="share-origin-note"]').attributes('data-origin')).toBe('set');
		expect(wrapper.find('[data-test="share-remove"]').text()).toContain('Follow the gateway default');
	});

	it('follows what the row underneath says once the override has been dropped', async () => {
		// The store re-reads the list after the deletion, because the library falls back
		// to the gateway default rather than to private — and a form still showing what
		// somebody had set would offer to save a value nobody chose.
		const { wrapper } = mountWithApp(SharePolicyForm, {
			props: { library, peers, policy: policy({ visibility: ShareVisibility.PRIVATE }) },
		});

		await wrapper.setProps({
			policy: policy({
				id: '',
				overridden: false,
				visibility: ShareVisibility.FRIENDS_OF_FRIENDS,
				updatedAt: '',
			}),
		});
		await settle();

		expect((wrapper.vm as any).model.visibility).toBe(ShareVisibility.FRIENDS_OF_FRIENDS);
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

	it('offers to drop the override, which is a deletion followed by a re-read', async () => {
		// The second answer is the list being read back: deleting the row hands the
		// library to the gateway default, and only the gateway knows what that is now.
		stubFetch([{}, { body: [policy({ id: '', overridden: false, updatedAt: '' })] }]);
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
