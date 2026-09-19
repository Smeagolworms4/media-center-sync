import { SpaceVerdict } from '@mcs/shared';
import { needsAcknowledgement, refusesRun, spaceVerdict, targetSpace } from './space';

const GB = 1024 * 1024 * 1024;

describe('spaceVerdict', () => {
	/**
	 * The whole comparison, as a table.
	 *
	 * Written this way because the failure this guards against is not a crash: an
	 * `INSUFFICIENT` that reads as `FITS` starts a run that dies at ninety per cent and
	 * leaves a truncated file the media server indexes as real. Every boundary is
	 * therefore pinned twice, on each side of it.
	 */
	const cases: [string, number | null, number, number, SpaceVerdict][] = [
		['room to spare', 100 * GB, 10 * GB, 5 * GB, SpaceVerdict.FITS],
		['exactly the reserve left over', 15 * GB, 10 * GB, 5 * GB, SpaceVerdict.FITS],
		['one byte inside the reserve', 15 * GB - 1, 10 * GB, 5 * GB, SpaceVerdict.TIGHT],
		['eats most of the reserve', 11 * GB, 10 * GB, 5 * GB, SpaceVerdict.TIGHT],
		['exactly the size of the file', 10 * GB, 10 * GB, 5 * GB, SpaceVerdict.TIGHT],
		['one byte short', 10 * GB - 1, 10 * GB, 5 * GB, SpaceVerdict.INSUFFICIENT],
		['nothing like enough', 1 * GB, 40 * GB, 5 * GB, SpaceVerdict.INSUFFICIENT],
		['an empty disk and a large file', 0, 1, 0, SpaceVerdict.INSUFFICIENT],
		['no reserve at all, and it just fits', 10 * GB, 10 * GB, 0, SpaceVerdict.FITS],
		['nothing to probe', null, 10 * GB, 5 * GB, SpaceVerdict.UNKNOWN],
		['nothing to probe and nothing to write', null, 0, 5 * GB, SpaceVerdict.FITS],
		['a probe that answered nonsense', Number.NaN, 10 * GB, 5 * GB, SpaceVerdict.UNKNOWN],
	];

	it.each(cases)('%s', (_name, free, required, reserve, expected) => {
		expect(spaceVerdict(free, required, reserve)).toBe(expected);
	});

	it('never reads an unmeasurable disk as room', () => {
		// The one substitution that costs a library: `statfs` fails on some network
		// mounts, and treating "we could not measure it" as "it fits" is the same full
		// disk with an alibi.
		expect(spaceVerdict(null, 1, 0)).not.toBe(SpaceVerdict.FITS);
	});
});

describe('targetSpace', () => {
	const question = {
		libraryId: 'library-1',
		libraryName: 'Shows',
		localPath: '/mnt/nas/shows',
		freeBytes: 12 * GB,
		requiredBytes: 10 * GB,
		reserveBytes: 5 * GB,
	};

	it('reports what is left after the run, which is the number worth showing', () => {
		expect(targetSpace(question)).toMatchObject({
			remainingBytes: 2 * GB,
			verdict: SpaceVerdict.TIGHT,
		});
	});

	it('leaves the remainder unknown rather than guessing it', () => {
		expect(targetSpace({ ...question, freeBytes: null })).toMatchObject({
			remainingBytes: null,
			verdict: SpaceVerdict.UNKNOWN,
		});
	});
});

describe('what a set of destinations allows', () => {
	const target = (verdict: SpaceVerdict) =>
		targetSpace({
			libraryId: verdict,
			libraryName: verdict,
			localPath: '/mnt/nas',
			freeBytes:
				verdict === SpaceVerdict.UNKNOWN
					? null
					: verdict === SpaceVerdict.INSUFFICIENT
						? 1
						: verdict === SpaceVerdict.TIGHT
							? 11 * GB
							: 100 * GB,
			requiredBytes: 10 * GB,
			reserveBytes: 5 * GB,
		});

	it('refuses the whole run over one destination that cannot take it', () => {
		// Half a run is the outcome this check exists to prevent: the other libraries
		// fitting is no consolation for the one that fills up.
		expect(refusesRun([target(SpaceVerdict.FITS), target(SpaceVerdict.INSUFFICIENT)])).toBe(true);
		expect(refusesRun([target(SpaceVerdict.FITS), target(SpaceVerdict.TIGHT)])).toBe(false);
	});

	it('asks about tight and unprobeable destinations alike', () => {
		expect(needsAcknowledgement([target(SpaceVerdict.TIGHT)])).toBe(true);
		expect(needsAcknowledgement([target(SpaceVerdict.UNKNOWN)])).toBe(true);
		expect(needsAcknowledgement([target(SpaceVerdict.FITS)])).toBe(false);
	});

	it('asks nothing of a run with no destinations', () => {
		expect(refusesRun([])).toBe(false);
		expect(needsAcknowledgement([])).toBe(false);
	});
});
