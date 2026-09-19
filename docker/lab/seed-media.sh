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
# The names are of real shows and real films, and that is the point rather than
# decoration: both media servers then reach their metadata agents, fetch real artwork
# and attach real TVDB and TMDB identifiers. Without that, a lab can exercise neither
# the poster wall — every card a placeholder — nor the external-identifier strategy,
# which is the second most trusted signal correlation has and the one no fixture of
# invented titles can reach.
#
# The files themselves are generated: a few seconds of test pattern at the real
# resolution the name claims. That last part matters — the quality comparator reads the
# stream, so a file named 2160p that is really 720p would make the lab prove the
# opposite of what it appears to prove. The four films are open-licensed Blender shorts,
# so their names and their metadata are honestly theirs; the series names carry nothing
# but a name.
#
# One pair is byte-for-byte identical under two names no title comparison could
# reconcile. It is the only case where content-derived identity can be seen winning,
# and the one that catches a correlation quietly built on names.
set -euo pipefail

ROOT="${1:?usage: seed-media.sh <root>}"

# `seed` varies the encode so that two files are identical only when this script says
# they are. Without it, two encodes with the same parameters come out byte for byte the
# same, and an accidental checksum match would look like a working strategy.
#
# The variation rides on the audio frequency rather than on the video pattern:
# `testsrc`'s `decimals` is bounded at 17 and ffmpeg fails outright past it, which under
# `set -e` stops the whole script halfway through with nothing saying which option was
# refused. A frequency has no such ceiling.
encode() {
	local path="$1" width="$2" height="$3" codec="$4" seconds="$5" seed="${6:-0}"

	mkdir -p "$(dirname "$path")"
	[ -f "$path" ] && return 0

	# x265 writes its banner and its summary straight to stderr and ignores ffmpeg's
	# log level; only its own parameter silences it.
	local quiet=()
	[ "$codec" = 'libx265' ] && quiet=(-x265-params log-level=none)

	ffmpeg -hide_banner -loglevel error -y \
		-f lavfi -i "testsrc=size=${width}x${height}:rate=24:duration=${seconds}:decimals=$((seed % 10))" \
		-f lavfi -i "sine=frequency=$((300 + seed * 37)):duration=${seconds}" \
		-c:v "$codec" "${quiet[@]}" -crf 40 -preset ultrafast -pix_fmt yuv420p \
		-c:a aac -b:a 64k -shortest \
		"$path" 2>/dev/null

	printf '  %-74s %s\n' "${path#"$ROOT"/}" "$(du -h "$path" | cut -f1)"
}

A="$ROOT/library-a"
B="$ROOT/library-b"

echo
echo "Library A — filed the way a media server renames things"

# The season is deliberately not uniform, so the quality summary has something real to
# call "mixed" rather than a tidy row that proves nothing.
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E01 - Dulcinea.mp4" 1920 1080 libx265 4 1
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E02 - The Big Empty.mp4" 1280 720 libx264 4 2
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E05 - Back to the Butcher.mp4" 1920 1080 libx265 4 5
encode "$A/shows/Cowboy Bebop (1998)/Season 01/Cowboy Bebop (1998) - S01E01 - Asteroid Blues.mp4" 1280 720 libx264 4 3
encode "$A/movies/Tears of Steel (2012)/Tears of Steel (2012) - 1080p.mp4" 1920 1080 libx265 4 4

echo
echo "Library B — filed the way a release lands on a disk"

# Same episode, worse: ours wins, and the state must be neither missing nor outdated.
encode "$B/shows/The.Expanse.S01E01.Dulcinea.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 4 11
# Same episode, better: theirs wins, and A's copy is outdated.
encode "$B/shows/The.Expanse.S01E02.The.Big.Empty.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 12
# Episodes A has never heard of. This is what a sync is for.
encode "$B/shows/The.Expanse.S01E03.Remember.the.Cant.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 13
encode "$B/shows/The.Expanse.S01E04.CQB.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 3 14
# A second season, so a series card has more than one child group to fold.
encode "$B/shows/The.Expanse.S02E01.Safe.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 18
# A show whose title only normalisation reconciles, in a better encode.
encode "$B/shows/Cowboy.Bebop.S01E01.Asteroid.Blues.2160p.x265-LAB.mp4" 3840 2160 libx265 3 15
encode "$B/movies/Tears.of.Steel.2012.1080p.x265-LAB.mp4" 1920 1080 libx265 4 16
# Films A has never heard of, all of them real open-licensed shorts.
encode "$B/movies/Elephants.Dream.2006.1080p.x264-LAB.mp4" 1920 1080 libx264 4 17
encode "$B/movies/Sintel.2010.1080p.x265-LAB.mp4" 1920 1080 libx265 4 19

# The same bytes under a different name.
#
# Two things about this name are load-bearing, and both were paid for here.
#
# The words are reordered rather than run together: a name whose show runs together,
# like `TheExpanse.S01E05`, yields no show title to Plex's scanner at all.
#
# And the release group is not `-OTHER`. Plex reads a trailing `-other` — like
# `-trailer`, `-featurette`, `-behindthescenes` — as its convention for a local extra:
# the file is found, opened, analysed, given an identifier, and then attached to
# nothing. It never appears in the library, nothing is logged as an error, and the only
# trace is one line in the scanner log saying `found local extra`. A release tag that
# collides with that convention is not a hypothetical: `-OTHER` is a real group name.
IDENTICAL_TARGET="$B/shows/Expanse.The.S01E05.INTERNAL.1080p.x265-RELAB.mp4"
if [ ! -f "$IDENTICAL_TARGET" ]; then
	mkdir -p "$(dirname "$IDENTICAL_TARGET")"
	cp "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E05 - Back to the Butcher.mp4" "$IDENTICAL_TARGET"
	printf '  %-74s %s (identical to A S01E05)\n' "${IDENTICAL_TARGET#"$ROOT"/}" "$(du -h "$IDENTICAL_TARGET" | cut -f1)"
fi

echo
echo "Total: $(du -sh "$ROOT" | cut -f1) across $(find "$ROOT" -type f | wc -l) files"
echo
echo "What this is meant to exercise:"
echo "  S01E01  present on both, ours better       -> in sync"
echo "  S01E02  present on both, theirs better     -> outdated"
echo "  S01E03  only theirs                        -> missing"
echo "  S01E04  only theirs, 2160p                 -> missing, and the odd one in the season"
echo "  S01E05  identical bytes, unrelated names   -> matched on content, not on title"
echo "  S02E01  a whole season only theirs         -> a season card with nothing held"
echo "  Cowboy Bebop  spelled apart, theirs 2160p  -> normalisation, then outdated"
echo "  Films   one shared, three only theirs      -> a library that is not a show"
echo
echo "Real titles on purpose: both servers fetch real artwork and real TVDB/TMDB"
echo "identifiers, which is what makes the poster wall and the external-id strategy"
echo "testable at all."
