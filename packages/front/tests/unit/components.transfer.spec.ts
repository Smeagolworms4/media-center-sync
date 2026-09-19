import type { Revalidation, Transfer, TransferChunk, TransferSource } from '@mcs/shared';
import {
	ChunkState,
	RevalidationAction,
	RevalidationOutcome,
	TransferErrorKind,
	TransferState,
	TransferTransport,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';
import ChunkMap from '@/components/transfer/ChunkMap.vue';
import RevalidationList from '@/components/transfer/RevalidationList.vue';
import TransferActions from '@/components/transfer/TransferActions.vue';
import TransferSources from '@/components/transfer/TransferSources.vue';
import { mountWithApp, tooltipStub } from './helpers';

function transfer (overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: 't1',
		jobId: null,
		itemId: 'm1',
		contentId: null,
		title: 'Pilot',
		kind: 'episode',
		state: TransferState.DOWNLOADING,
		targetPath: '/media/shows/pilot.mkv',
		bytesTotal: 1000,
		bytesDone: 100,
		rate: 10,
		etaSeconds: 90,
		sources: [],
		chunkSize: 100,
		chunksTotal: 10,
		chunksDone: 1,
		error: null,
		errorKind: null,
		chunksRepaired: 0,
		lastVerifiedAt: null,
		startedAt: null,
		finishedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function source (overrides: Partial<TransferSource> = {}): TransferSource {
	return {
		serviceId: 's1',
		serviceName: 'Bob’s Jellyfin',
		peerId: 'p1',
		peerName: 'Bob',
		transport: TransferTransport.PEER_DIRECT,
		rate: 500_000,
		bytesDone: 4000,
		connections: 2,
		healthy: true,
		...overrides,
	};
}

function actions (wrapper: ReturnType<typeof mountWithApp>['wrapper']): string[] {
	return wrapper.findAll('[data-test^="transfer-"]')
		.map(node => node.attributes('data-test') ?? '');
}

describe('components/transfer/TransferActions', () => {
	it('offers a pause while the transfer is moving, and no resume', () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: { transfer: transfer() },
		});

		expect(actions(wrapper)).toContain('transfer-pause');
		expect(actions(wrapper)).not.toContain('transfer-resume');
	});

	it('offers a resume, and nothing else to press, on a paused transfer', () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: { transfer: transfer({ state: TransferState.PAUSED }) },
		});

		expect(actions(wrapper)).toContain('transfer-resume');
		expect(actions(wrapper)).not.toContain('transfer-pause');
	});

	/**
	 * The behaviour that matters: a failure is offered the action that fits it
	 * rather than a retry that would reach the same wall.
	 */
	it('offers another source, not a retry, when the source is gone', () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: {
				transfer: transfer({
					state: TransferState.FAILED,
					errorKind: TransferErrorKind.SOURCE_GONE,
				}),
			},
		});

		expect(actions(wrapper)).toContain('transfer-another_source');
		expect(actions(wrapper)).not.toContain('transfer-retry');
	});

	it('offers another library when the disk is full', () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: {
				transfer: transfer({
					state: TransferState.FAILED,
					errorKind: TransferErrorKind.DISK_FULL,
				}),
			},
		});

		expect(actions(wrapper)).toContain('transfer-another_target');
		expect(actions(wrapper)).not.toContain('transfer-retry');
	});

	it('emits the action somebody pressed', async () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: {
				transfer: transfer({
					state: TransferState.FAILED,
					errorKind: TransferErrorKind.NETWORK,
				}),
			},
		});

		await wrapper.find('[data-test="transfer-retry"]').trigger('click');

		expect(wrapper.emitted('action')?.[0]).toEqual(['retry']);
	});

	it('offers a verification on a finished transfer, because a file can rot later', () => {
		const { wrapper } = mountWithApp(TransferActions, {
			props: { transfer: transfer({ state: TransferState.DONE }) },
		});

		expect(actions(wrapper)).toContain('transfer-verify');
	});
});

describe('components/transfer/TransferSources', () => {
	it('lists every source with its transport', () => {
		const { wrapper } = mountWithApp(TransferSources, {
			props: {
				sources: [
					source(),
					source({ serviceId: 's2', serviceName: 'Swarm', transport: TransferTransport.SWARM }),
				],
			},
			global: { stubs: tooltipStub },
		});

		const rows = wrapper.findAll('[data-test="transfer-source"]');
		expect(rows).toHaveLength(2);
		expect(rows[0].attributes('data-transport')).toBe(TransferTransport.PEER_DIRECT);
		expect(rows[1].attributes('data-transport')).toBe(TransferTransport.SWARM);
	});

	/** A dead source hides behind a healthy aggregate rate; here it cannot. */
	it('marks a source that has stopped serving', () => {
		const { wrapper } = mountWithApp(TransferSources, {
			props: { sources: [source(), source({ serviceId: 's2', healthy: false, rate: 0 })] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.findAll('[data-test="transfer-source-unhealthy"]')).toHaveLength(1);
		expect(wrapper.findAll('[data-healthy="false"]')).toHaveLength(1);
	});

	it('says plainly when nothing is feeding the transfer', () => {
		const { wrapper } = mountWithApp(TransferSources, {
			props: { sources: [] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('no source');
	});
});

describe('components/transfer/ChunkMap', () => {
	function chunk (index: number, state: ChunkState): TransferChunk {
		return {
			index,
			start: index * 100,
			end: index * 100 + 99,
			state,
			bytesDone: 0,
			sourceServiceId: null,
			attempts: 0,
			checksum: null,
		};
	}

	it('draws a cell per piece and counts each state', () => {
		const { wrapper } = mountWithApp(ChunkMap, {
			props: {
				chunks: [chunk(0, ChunkState.DONE), chunk(1, ChunkState.CORRUPT), chunk(2, ChunkState.PENDING)],
			},
		});

		expect(wrapper.findAll('[data-test="chunk-cell"]')).toHaveLength(3);
		expect(wrapper.find('[data-state="corrupt"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Corrupt: 1');
	});

	it('says so rather than drawing nothing when there is no map yet', () => {
		const { wrapper } = mountWithApp(ChunkMap, { props: { chunks: [] } });

		expect(wrapper.text()).toContain('no piece map');
	});
});

describe('components/transfer/RevalidationList', () => {
	const revalidation: Revalidation = {
		id: 'r1',
		transferId: 't1',
		sourceServiceId: 's1',
		sourceServiceName: 'Bob',
		cause: TransferErrorKind.SOURCE_GONE,
		requestedAt: '2026-02-02T00:00:00.000Z',
		answeredAt: '2026-02-02T00:00:30.000Z',
		outcome: RevalidationOutcome.MOVED,
		remoteFile: {
			path: '/data/new/place.mkv',
			size: 10,
			container: null,
			videoCodec: null,
			audioCodec: null,
			width: null,
			height: null,
			durationMs: null,
			bitrate: null,
			quickHash: null,
			contentId: null,
			checksum: null,
		},
		action: RevalidationAction.FOLLOW_MOVE,
		note: null,
	};

	it('says who was asked, what they answered and what was decided', () => {
		const { wrapper } = mountWithApp(RevalidationList, {
			props: { revalidations: [revalidation] },
			global: { stubs: tooltipStub },
		});

		const text = wrapper.text();
		expect(text).toContain('Bob');
		expect(text).toContain('Moved');
		expect(text).toContain('follow it to its new path');
		expect(text).toContain('/data/new/place.mkv');
	});

	it('shows a request nobody has answered yet as pending', () => {
		const { wrapper } = mountWithApp(RevalidationList, {
			props: { revalidations: [{ ...revalidation, answeredAt: null, outcome: null, action: null }] },
			global: { stubs: tooltipStub },
		});

		expect(wrapper.text()).toContain('Waiting for an answer');
	});

	it('says nothing was asked rather than showing an empty block', () => {
		const { wrapper } = mountWithApp(RevalidationList, { props: { revalidations: [] } });

		expect(wrapper.text()).toContain('Nothing has been asked');
	});
});
