import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChunkState } from '@mcs/shared';
import { FingerprintService } from './fingerprint.service';
import { VerificationService, type VerifiableChunk } from './verification.service';

function sha(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

describe('VerificationService', () => {
	const service = new VerificationService(new FingerprintService());
	let directory: string;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcs-verify-'));
	});

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	async function write(name: string, content: Buffer): Promise<string> {
		const path = join(directory, name);

		await writeFile(path, content);

		return path;
	}

	const content = Buffer.concat([
		Buffer.alloc(100, 1),
		Buffer.alloc(100, 2),
		Buffer.alloc(100, 3),
	]);

	function chunks(overrides: Partial<VerifiableChunk>[] = []): VerifiableChunk[] {
		return [
			{ index: 0, start: 0, end: 99, checksum: sha(content.subarray(0, 100)) },
			{ index: 1, start: 100, end: 199, checksum: sha(content.subarray(100, 200)) },
			{ index: 2, start: 200, end: 299, checksum: sha(content.subarray(200, 300)) },
		].map((chunk, index) => ({ ...chunk, ...overrides[index] }));
	}

	it('passes a file whose every piece matches', async () => {
		const path = await write('good.bin', content);

		const report = await service.verify({
			transferId: 't1',
			path,
			chunks: chunks(),
			expectedSize: 300,
		});

		expect(report).toMatchObject({
			ok: true,
			chunksChecked: 3,
			chunksCorrupt: 0,
			bytesToRepair: 0,
			corruptChunks: [],
		});
	});

	it('names only the pieces that are wrong', async () => {
		// The whole point: two bad megabytes must not cost thirty gigabytes.
		const damaged = Buffer.from(content);

		damaged[150] = 0xff;

		const path = await write('damaged.bin', damaged);

		const report = await service.verify({
			transferId: 't1',
			path,
			chunks: chunks(),
			expectedSize: 300,
		});

		expect(report.ok).toBe(false);
		expect(report.corruptChunks).toEqual([1]);
		expect(report.bytesToRepair).toBe(100);
		expect(report.detail).toContain('1 pieces');
	});

	it('rejects a truncated file without bothering to hash anything', async () => {
		// A wrong size makes every offset meaningless, so no piece hash is worth
		// computing — and this is exactly what a full disk produces.
		const path = await write('short.bin', content.subarray(0, 250));

		const report = await service.verify({
			transferId: 't1',
			path,
			chunks: chunks(),
			expectedSize: 300,
		});

		expect(report.ok).toBe(false);
		expect(report.corruptChunks).toEqual([0, 1, 2]);
		expect(report.detail).toContain('size is 250');
	});

	it('reports a file that is no longer there', async () => {
		const report = await service.verify({
			transferId: 't1',
			path: join(directory, 'never-written.bin'),
			chunks: chunks(),
		});

		expect(report.ok).toBe(false);
		expect(report.detail).toContain('not there');
	});

	it('falls back to the whole-file hash when no piece carries one', async () => {
		const path = await write('whole.bin', content);
		const bare = chunks().map((chunk) => ({ ...chunk, checksum: null }));

		expect(
			await service.verify({
				transferId: 't1',
				path,
				chunks: bare,
				expectedChecksum: sha(content),
			}),
		).toMatchObject({ ok: true, chunksCorrupt: 0 });
	});

	it('suspects every piece when only the whole-file hash fails', async () => {
		// Without per-piece hashes nothing says which part is wrong. That is the cost
		// of a source that could not give us any, and it belongs on screen.
		const path = await write('whole-bad.bin', content);
		const bare = chunks().map((chunk) => ({ ...chunk, checksum: null }));

		const report = await service.verify({
			transferId: 't1',
			path,
			chunks: bare,
			expectedChecksum: sha(Buffer.alloc(10)),
		});

		expect(report.ok).toBe(false);
		expect(report.corruptChunks).toEqual([0, 1, 2]);
		expect(report.detail).toContain('no piece hashes');
	});

	it('passes when there is nothing at all to check against', async () => {
		const path = await write('unverifiable.bin', content);

		expect(
			await service.verify({ transferId: 't1', path, chunks: [], expectedSize: 300 }),
		).toMatchObject({ ok: true, chunksChecked: 0 });
	});

	it('verifies a file that is already in the library', async () => {
		const path = await write('placed.bin', content);

		expect(await service.verifyPlaced('t1', path, 300, sha(content))).toMatchObject({ ok: true });
		expect(await service.verifyPlaced('t1', path, 400, null)).toMatchObject({ ok: false });
	});

	describe('planRepair', () => {
		it('sends a repair to a source other than the one that served the bad bytes', async () => {
			const damaged = Buffer.from(content);

			damaged[10] = 0xff;

			const path = await write('repair.bin', damaged);
			const withSources = chunks().map((chunk) => ({
				...chunk,
				sourceServiceId: 'bad-source',
				state: ChunkState.DONE,
			}));

			const report = await service.verify({ transferId: 't1', path, chunks: withSources });
			const plan = service.planRepair(report, withSources, ['bad-source', 'other-source']);

			expect(plan).toEqual([
				{
					chunkIndex: 0,
					sourceServiceId: 'other-source',
					previousSourceServiceId: 'bad-source',
				},
			]);
		});

		it('goes back to the only source there is rather than giving up', async () => {
			const damaged = Buffer.from(content);

			damaged[10] = 0xff;

			const path = await write('repair-single.bin', damaged);
			const withSources = chunks().map((chunk) => ({ ...chunk, sourceServiceId: 'only' }));

			const report = await service.verify({ transferId: 't1', path, chunks: withSources });

			expect(service.planRepair(report, withSources, ['only'])[0].sourceServiceId).toBe('only');
		});

		it('spreads a large repair over the alternatives', async () => {
			const damaged = Buffer.alloc(300, 9);
			const path = await write('repair-many.bin', damaged);
			const withSources = chunks().map((chunk) => ({ ...chunk, sourceServiceId: 'bad' }));

			const report = await service.verify({ transferId: 't1', path, chunks: withSources });
			const plan = service.planRepair(report, withSources, ['bad', 'a', 'b']);

			expect(plan.map((entry) => entry.sourceServiceId)).toEqual(['a', 'b', 'a']);
		});

		it('plans nothing for a file that verified', async () => {
			const path = await write('clean.bin', content);
			const report = await service.verify({ transferId: 't1', path, chunks: chunks() });

			expect(service.planRepair(report, chunks(), ['a'])).toEqual([]);
		});
	});
});
