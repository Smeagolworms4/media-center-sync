#!/usr/bin/env bash
#
# Builds two media trees that disagree with each other on purpose.
#
# Correlation is only interesting when the two sides do not already agree. So one tree
# is filed the tidy way a media server renames things, the other the way a release
# lands on a disk; the episode sets overlap without matching; and the encodings differ
# in both directions, so that "theirs is better" and "ours is better" are both
# exercised rather than assumed.
#
# Files are generated, never downloaded: a few seconds of test pattern at the real
# resolution the name claims. The quality comparator reads the stream, so a file named
# 2160p that is really 720p would make the lab prove the opposite of what it looks like
# it proves.
#
# One pair is byte-for-byte identical under two different names, deliberately. It is
# the only case where the checksum strategy can be observed winning, and it is also the
# case that catches a correlation built on names alone.
set -euo pipefail

ROOT="${1:?usage: seed-media.sh <root>}"

# `seed` varies the test pattern so that two files are identical only when this script
# says they are. Without it, two encodes with the same parameters come out byte for
# byte the same, and an accidental checksum match would look like a working strategy.
encode() {
	local path="$1" width="$2" height="$3" codec="$4" seconds="$5" seed="${6:-0}"

	mkdir -p "$(dirname "$path")"
	[ -f "$path" ] && return 0

	# x265 writes its banner and its summary straight to stderr and ignores ffmpeg's
	# log level; only its own parameter silences it.
	local quiet=()
	[ "$codec" = 'libx265' ] && quiet=(-x265-params log-level=none)

	ffmpeg -hide_banner -loglevel error -y \
		-f lavfi -i "testsrc=size=${width}x${height}:rate=24:duration=${seconds}:decimals=${seed}" \
		-f lavfi -i "sine=frequency=$((440 + seed * 30)):duration=${seconds}" \
		-c:v "$codec" "${quiet[@]}" -crf 40 -preset ultrafast -pix_fmt yuv420p \
		-c:a aac -b:a 64k -shortest \
		"$path" 2>/dev/null

	printf '  %-72s %s\n' "${path#"$ROOT"/}" "$(du -h "$path" | cut -f1)"
}

A="$ROOT/library-a"
B="$ROOT/library-b"

echo
echo "Library A — filed the way a media server renames things"

# The season is deliberately not uniform, so the interface has something real to call
# "mixed" rather than a tidy row that proves nothing.
encode "$A/shows/Big Buck Bunny (2008)/Season 01/Big Buck Bunny (2008) - S01E01 - The Meadow.mp4" 1920 1080 libx265 4 1
encode "$A/shows/Big Buck Bunny (2008)/Season 01/Big Buck Bunny (2008) - S01E02 - The Trap.mp4" 1280 720 libx264 4 2
encode "$A/shows/Big Buck Bunny (2008)/Season 01/Big Buck Bunny (2008) - S01E05 - The Flight.mp4" 1920 1080 libx265 4 5
encode "$A/shows/Sintel Chronicles (2010)/Season 01/Sintel Chronicles (2010) - S01E01 - The Dragon.mp4" 1280 720 libx264 4 3
encode "$A/movies/Tears of Steel (2012)/Tears of Steel (2012) - 1080p.mp4" 1920 1080 libx265 4 4

echo
echo "Library B — filed the way a release lands on a disk"

# Same episode, worse: ours wins, and the state must be neither missing nor outdated.
encode "$B/shows/Big.Buck.Bunny.S01E01.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 4 11
# Same episode, better: theirs wins, and A's copy is outdated.
encode "$B/shows/Big.Buck.Bunny.S01E02.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 12
# Episodes A has never heard of. This is what a sync is for.
encode "$B/shows/Big.Buck.Bunny.S01E03.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 13
encode "$B/shows/Big.Buck.Bunny.S01E04.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 3 14
# A show named differently enough that only normalisation saves it, in a better encode.
encode "$B/shows/Sintel.Chronicles.S01E01.2160p.x265-LAB.mp4" 3840 2160 libx265 3 15
encode "$B/movies/Tears.of.Steel.2012.1080p.x265-LAB.mp4" 1920 1080 libx265 4 16
# A film A has never heard of.
encode "$B/movies/Elephants.Dream.2006.1080p.x264-LAB.mp4" 1920 1080 libx264 4 17

# The same bytes under a different name.
#
# Nothing about the two names would let a title comparison call them the same episode:
# the words are in a different order, so they normalise differently, and the release
# tags share nothing. Only the content answers — which is the whole argument for
# deriving an identity from the file rather than from what it is called, and the case
# that catches a correlation quietly built on names.
#
# Two things about this name are load-bearing, and both were paid for here.
#
# The words are reordered rather than run together: `BigBuckBunny.S01E05...` is the
# obvious way to write a title a match cannot reconcile, and Plex's scanner derives no
# show from it at all.
#
# And the release group is not `-OTHER`. Plex reads a trailing `-other` — like
# `-trailer`, `-featurette`, `-behindthescenes` — as its convention for a local extra:
# the file is found, opened, analysed, given an identifier, and then attached to
# nothing. It never appears in the library, nothing is logged as an error, and the only
# trace is one line in the scanner log saying `found local extra`. A release tag that
# collides with that convention is not a hypothetical: `-OTHER` is a real group name.
IDENTICAL_TARGET="$B/shows/Bunny.Big.Buck.S01E05.INTERNAL.1080p.x265-RELAB.mp4"
if [ ! -f "$IDENTICAL_TARGET" ]; then
	mkdir -p "$(dirname "$IDENTICAL_TARGET")"
	cp "$A/shows/Big Buck Bunny (2008)/Season 01/Big Buck Bunny (2008) - S01E05 - The Flight.mp4" "$IDENTICAL_TARGET"
	printf '  %-72s %s (identical to A S01E05)\n' "${IDENTICAL_TARGET#"$ROOT"/}" "$(du -h "$IDENTICAL_TARGET" | cut -f1)"
fi

echo
echo "Total: $(du -sh "$ROOT" | cut -f1) across $(find "$ROOT" -type f | wc -l) files"
echo
echo "What this is meant to exercise:"
echo "  S01E01  present on both, ours better      -> in sync, no action"
echo "  S01E02  present on both, theirs better    -> outdated"
echo "  S01E03  only theirs                       -> missing"
echo "  S01E04  only theirs, 2160p                -> missing, and the odd one in the season"
echo "  S01E05  identical bytes, unrelated names  -> matched on content, not on title"
echo "  Sintel  differently spelled, theirs 2160p -> normalisation, then outdated"
echo "  Films   one shared, one only theirs       -> a library that is not a show"
