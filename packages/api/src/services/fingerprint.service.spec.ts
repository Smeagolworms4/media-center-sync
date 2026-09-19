import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FingerprintService, SAMPLE_SIZE } from './fingerprint.service';

describe('FingerprintService', () => {
	const service = new FingerprintService();
	let directory: string;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'mcs-fingerprint-'));
	});

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	async function write(name: string, content: Buffer): Promise<string> {
		const path = join(directory, name);

		await writeFile(path, content);

		return path;
	}

	/**
	 * Deterministic content, so a failure is a real difference rather than a file that
	 * happened to be random twice.
	 */
	function pattern(size: number, seed = 7): Buffer {
		const buffer = Buffer.alloc(size);

		for (let index = 0; index < size; index += 1) {
			buffer[index] = (index * seed + 13) % 251;
		}

		return buffer;
	}

	it('gives the same identifier for the same bytes, computed twice', async () => {
		const content = pattern(SAMPLE_SIZE * 4);
		const left = await write('same-a.bin', content);
		const right = await write('same-b.bin', content);

		const first = await service.fingerprint(left);
		const second = await service.fingerprint(right);

		// Two gateways holding the same file have to arrive here with no
		// communication at all; this is that property, tested locally.
		expect(first.quickHash).toBe(second.quickHash);
		expect(first.contentId).toBe(second.contentId);
		expect(first.size).toBe(SAMPLE_SIZE * 4);
	});

	it('gives a different identifier when the size differs', async () => {
		const base = pattern(SAMPLE_SIZE * 4);
		const shorter = await write('short.bin', base.subarray(0, base.length - 1));
		const longer = await write('long.bin', base);

		const first = await service.fingerprint(shorter);
		const second = await service.fingerprint(longer);

		expect(first.contentId).not.toBe(second.contentId);
		expect(first.quickHash).not.toBe(second.quickHash);
	});

	it('notices a change in the middle of a large file', async () => {
		const content = pattern(SAMPLE_SIZE * 6);
		const altered = Buffer.from(content);

		altered[Math.floor(altered.length / 2)] ^= 0xff;

		const first = await service.fingerprint(await write('mid-a.bin', content));
		const second = await service.fingerprint(await write('mid-b.bin', altered));

		expect(first.quickHash).not.toBe(second.quickHash);
	});

	it('reads a file too small for three windows whole', async () => {
		// The windows would overlap below this size, so the file is hashed entirely —
		// which has to still distinguish two files of the same length.
		const first = await service.fingerprint(await write('tiny-a.bin', pattern(1_024, 3)));
		const second = await service.fingerprint(await write('tiny-b.bin', pattern(1_024, 5)));

		expect(first.size).toBe(1_024);
		expect(first.quickHash).not.toBe(second.quickHash);
	});

	it('handles an empty file without throwing', async () => {
		const result = await service.fingerprint(await write('empty.bin', Buffer.alloc(0)));

		expect(result.size).toBe(0);
		expect(result.quickHash).toHaveLength(64);
	});

	it('marks the identifier with the version of the scheme', async () => {
		const result = await service.fingerprint(await write('versioned.bin', pattern(2_048)));

		// The sampling rule is a protocol between two gateways, so a change to it has
		// to be visible in the value rather than silently comparable with the old one.
		expect(result.contentId.startsWith('q1-')).toBe(true);
	});

	it('derives the same identifier from a hash and a size without the file', async () => {
		const path = await write('derived.bin', pattern(SAMPLE_SIZE * 4));
		const fingerprint = await service.fingerprint(path);

		expect(service.contentId(fingerprint.quickHash, fingerprint.size)).toBe(
			fingerprint.contentId,
		);
	});

	it('computes a full hash that matches a plain digest of the file', async () => {
		const content = randomBytes(10_000);
		const path = await write('full.bin', content);

		expect(await service.fullHash(path)).toBe(
			createHash('sha256').update(content).digest('hex'),
		);
	});

	it('hashes a range exactly as a digest of that slice would', async () => {
		const content = randomBytes(10_000);
		const path = await write('range.bin', content);

		expect(await service.hashRange(path, 100, 199)).toBe(
			createHash('sha256').update(content.subarray(100, 200)).digest('hex'),
		);
	});

	it('hashes a buffer the same way it hashes a range of it', async () => {
		const content = randomBytes(1_000);
		const path = await write('buffer.bin', content);

		expect(service.hashBuffer(content)).toBe(await service.hashRange(path, 0, 999));
	});
});
