import type { Release, ReleaseGroup } from '@mcs/shared';
import { releaseCodecOf, releaseTeamOf } from './release-preferences';

/**
 * Folding a search result into the list somebody can actually read.
 *
 * A search for one episode comes back as forty rows, of which perhaps four are
 * genuinely different files: the rest are the same release re-listed by every tracker
 * that carries it. Shown flat, the screen is a wall in which the four real choices are
 * invisible, and the obvious reading — that there are forty different copies — is
 * wrong in the one way that costs a download.
 *
 * Folded on what the name resolves to. Not on the name itself, which differs by the
 * group tag every tracker appends, and not on the size, which differs by a few
 * kilobytes between two copies of one file.
 */

/**
 * What makes two rows the same thing to grab.
 *
 * The coordinate, the quality, the source and the languages — everything a person
 * chooses between. Deliberately *not* the release group: two 1080p WEB-DLs of one
 * episode from two groups really are two files, and somebody who cares which will
 * recognise the name, which is why every copy stays listed under the line.
 */
const keyOf = (release: Release): string =>
	[
		release.kind,
		release.coverage.seasonNumber ?? '',
		// The whole run, not just the first: `S01E01-E03` and `S01E01` are two different
		// things to grab, and folding them together offers one line that fills three gaps
		// under a name that promises one.
		release.coverage.episodeNumbers.join('-'),
		release.coverage.wholeSeason ? 'season' : '',
		release.coverage.wholeSeries ? 'series' : '',
		release.quality ?? '',
		release.source ?? '',
		[...release.languages].sort().join('+'),
		/*
		 * The codec and the release group, and they are here because of what the folding
		 * costs without them.
		 *
		 * A line is named after its best-seeded member and a grab takes that member. Two
		 * groups' 1080p WEB-DLs of one episode, within the same size bucket, folded into
		 * one line — so somebody who prefers a particular team saw the line ranked on
		 * another team's name and then fetched that other team's file. The preference did
		 * not merely fail to apply: the screen said something untrue.
		 *
		 * The cost is more lines on a busy search, which is the honest shape: those
		 * really are different files.
		 */
		releaseCodecOf(release.title) ?? '',
		releaseTeamOf(release.title) ?? '',
		// The size to the nearest hundred megabytes, which is what separates two
		// different encodes of one episode from two listings of one file. Without it a
		// 2 GB and a 6 GB WEB-DL fold into one line and the seeders of one are credited
		// to the other.
		release.size === null ? '' : Math.round(release.size / 100_000_000),
	].join('|');

/**
 * Best first, and "best" is seeders before size.
 *
 * A release nobody is seeding is not a better copy for being bigger — it is a download
 * that will never finish, which is the one outcome worth ordering against. Size breaks
 * the tie because between two equally seeded copies the larger is the less compressed.
 */
const better = (left: Release, right: Release): number =>
	(right.seeders ?? 0) - (left.seeders ?? 0) || (right.size ?? 0) - (left.size ?? 0);

export const groupReleases = (releases: Release[]): ReleaseGroup[] => {
	const groups = new Map<string, Release[]>();

	for (const release of releases) {
		const key = keyOf(release);
		const existing = groups.get(key);

		if (existing === undefined) {
			groups.set(key, [release]);
		} else {
			existing.push(release);
		}
	}

	const folded: ReleaseGroup[] = [];

	for (const [key, copies] of groups) {
		const sorted = [...copies].sort(better);
		const first = sorted[0];

		folded.push({
			key,
			// The best-seeded copy's name, because that is the one a grab takes and the
			// name has to be the name of the thing that will actually arrive.
			title: first.title,
			kind: first.kind,
			seasonNumber: first.seasonNumber,
			episodeNumber: first.episodeNumber,
			quality: first.quality,
			source: first.source,
			languages: first.languages,
			size: sorted.reduce<number | null>(
				(largest, one) => (one.size !== null && one.size > (largest ?? 0) ? one.size : largest),
				null,
			),
			// Summed rather than taken from the best: a release carried by four trackers
			// really is better seeded than the same file on one, and that is the number
			// somebody is choosing on.
			seeders: sorted.some((one) => one.seeders !== null)
				? sorted.reduce((total, one) => total + (one.seeders ?? 0), 0)
				: null,
			releases: sorted,
			// The union, not the intersection: a release is free when one of its trackers
			// gives it away, and taking that copy is one press on the row.
			flags: [...new Set(sorted.flatMap((one) => one.flags))],
			indexers: [...new Set(sorted.map((one) => one.indexer))],
			coverage: first.coverage,
			// Both filled by the manager, which is the only layer that knows what we hold
			// and what any server here has ever reported.
			fills: [],
			brings: [],
			heldAlready: sorted.some((one) => one.heldAlready),
		});
	}

	// Held copies last, then best seeded. Something already on the disk is not a choice
	// worth putting at the top of a list of things to fetch — and it is still listed,
	// because "you already have this one" is an answer.
	return folded.sort(
		(left, right) =>
			Number(left.heldAlready) - Number(right.heldAlready) ||
			(right.seeders ?? 0) - (left.seeders ?? 0) ||
			(right.size ?? 0) - (left.size ?? 0),
	);
};
