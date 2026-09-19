#!/usr/bin/env bash
#
# Builds four media trees that disagree with each other on purpose.
#
# Correlation is only interesting when the sides do not already agree. So one tree is
# filed the tidy way a media server renames things, another the way a release lands on
# a disk, and the two remote trees again differently; the episode sets overlap without
# matching; and the encodings differ in every direction, so that "theirs is better",
# "ours is better" and "four sources, four encodings, pick one" are all exercised
# rather than assumed.
#
# Four trees rather than two because that is how the gateway is really used: some
# services are ours — libraries it may write into — and some are a friend's, which it
# may only read. A two-server lab can show that two catalogues differ. It cannot show
# a season nobody local holds, a group with three sources behind one quality chip, or
# a choice of where to pull from, and those are the screens that break.
#
# The names are of real shows and real films, and that is the point rather than
# decoration: every media server then reaches its metadata agents, fetches real artwork
# and attaches real TVDB and TMDB identifiers. Without that, a lab can exercise neither
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
# and the one that catches a correlation quietly built on names. There is exactly one
# such pair, and the script counts them at the end rather than asking to be believed.
set -euo pipefail

ROOT="${1:?usage: seed-media.sh <root>}"

# `seed` varies the encode so that two files are identical only when this script says
# they are. Without it, two encodes with the same parameters come out byte for byte the
# same, and an accidental checksum match would look like a working strategy. Every call
# below therefore carries its own seed, and no two share one.
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

	printf '  %-86s %s\n' "${path#"$ROOT"/}" "$(du -h "$path" | cut -f1)"
}

A="$ROOT/library-a"
B="$ROOT/library-b"
C="$ROOT/library-c"
D="$ROOT/library-d"

echo
echo "Library A — jellyfin-local, ours, filed the way a media server renames things"

# The season is deliberately not uniform, so the quality summary has something real to
# call "mixed" rather than a tidy row that proves nothing.
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E01 - Dulcinea.mp4" 1920 1080 libx265 4 1
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E02 - The Big Empty.mp4" 1280 720 libx264 4 2
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E05 - Back to the Butcher.mp4" 1920 1080 libx265 4 5
# Held by three of the four, and by both of ours.
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E06 - Rock Bottom.mp4" 1920 1080 libx265 4 6
# Held by all four, in four different encodings. Ours is the worst of them on purpose:
# the answer to "which source do I pull from" then has to be read off the sources
# rather than guessed from where the gateway happens to be standing.
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E07 - Windmills.mp4" 854 480 libx264 4 7
encode "$A/shows/Cowboy Bebop (1998)/Season 01/Cowboy Bebop (1998) - S01E01 - Asteroid Blues.mp4" 1280 720 libx264 4 3
encode "$A/movies/Tears of Steel (2012)/Tears of Steel (2012) - 1080p.mp4" 1920 1080 libx265 4 4

echo
echo "Library B — plex-local, ours, filed the way a release lands on a disk"

# Same episode, worse: ours wins, and the state must be neither missing nor outdated.
encode "$B/shows/The.Expanse.S01E01.Dulcinea.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 4 11
# Same episode, better: theirs wins, and A's copy is outdated.
encode "$B/shows/The.Expanse.S01E02.The.Big.Empty.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 12
# Episodes A has never heard of. This is what a sync is for.
encode "$B/shows/The.Expanse.S01E03.Remember.the.Cant.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 13
encode "$B/shows/The.Expanse.S01E04.CQB.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 3 14
encode "$B/shows/The.Expanse.S01E06.Rock.Bottom.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 4 20
encode "$B/shows/The.Expanse.S01E07.Windmills.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 4 21
# A second season neither remote has, so a series card has more than one child group to
# fold and one of them is answered entirely from our own side.
encode "$B/shows/The.Expanse.S02E01.Safe.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 4 18
# A show whose title only normalisation reconciles, in a better encode.
encode "$B/shows/Cowboy.Bebop.S01E01.Asteroid.Blues.2160p.x265-LAB.mp4" 3840 2160 libx265 3 15
encode "$B/movies/Tears.of.Steel.2012.1080p.x265-LAB.mp4" 1920 1080 libx265 4 16
# Films A has never heard of, all of them real open-licensed shorts.
encode "$B/movies/Elephants.Dream.2006.1080p.x264-LAB.mp4" 1920 1080 libx264 4 17
encode "$B/movies/Sintel.2010.1080p.x265-LAB.mp4" 1920 1080 libx265 4 19

echo
echo "Library C — jellyfin-remote, a friend's, tidy but by another hand"

# Tidy like A, and yet not the same tidy: no year on the folder, no year in the file,
# the season folder spelled without its leading zero. A handler that reads A only
# because of the shape A happens to have fails here, and that is the point of the third
# tree — the two conventions in the first two libraries are not the only two.
encode "$C/shows/The Expanse/Season 1/The Expanse - S01E07 - Windmills.mp4" 1920 1080 libx264 4 31
# A whole season no local service holds. Its card must show three episodes, three
# sources, and nothing held — which is a different thing from an empty season, and the
# only place the difference can be seen.
encode "$C/shows/The Expanse/Season 3/The Expanse - S03E01 - Fight or Flight.mp4" 1920 1080 libx265 4 32
encode "$C/shows/The Expanse/Season 3/The Expanse - S03E02 - IFF.mp4" 1920 1080 libx265 4 33
encode "$C/shows/The Expanse/Season 3/The Expanse - S03E03 - Assured Destruction.mp4" 1280 720 libx264 4 35
# A film two remotes hold and neither of ours does.
encode "$C/movies/Big Buck Bunny (2008)/Big Buck Bunny (2008) - 1080p.mp4" 1920 1080 libx264 4 34

echo
echo "Library D — plex-remote, a friend's, releases dropped into a folder per show"

# Plex is happy to read a release name inside a show folder, which is the third common
# shape and the one the two libraries above do not cover.
encode "$D/shows/The Expanse/Season 01/The.Expanse.S01E06.Rock.Bottom.1080p.WEB-DL.x264-LAB.mp4" 1920 1080 libx264 4 41
encode "$D/shows/The Expanse/Season 01/The.Expanse.S01E07.Windmills.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 3 42
encode "$D/movies/Big.Buck.Bunny.2008.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 3 43

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
#
# There is exactly one such pair across the four libraries, and there must stay exactly
# one: a second would mean a run where content identity works and a run where it does
# not could no longer be told apart by looking at one group.
IDENTICAL_TARGET="$B/shows/Expanse.The.S01E05.INTERNAL.1080p.x265-RELAB.mp4"
if [ ! -f "$IDENTICAL_TARGET" ]; then
	mkdir -p "$(dirname "$IDENTICAL_TARGET")"
	cp "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E05 - Back to the Butcher.mp4" "$IDENTICAL_TARGET"
	printf '  %-86s %s (identical to A S01E05)\n' "${IDENTICAL_TARGET#"$ROOT"/}" "$(du -h "$IDENTICAL_TARGET" | cut -f1)"
fi

# The claim above is checked rather than asserted. A fixture added later with a seed
# that was already taken would come out byte-identical to an existing file, the lab
# would grow a second content match nobody meant, and the one case that proves content
# identity would stop proving it — silently, because two extra identical files break
# nothing that fails.
duplicates=$(find "$ROOT" -type f -exec md5sum {} + | cut -d' ' -f1 | sort | uniq -d | wc -l)

echo
echo "Total: $(du -sh "$ROOT" | cut -f1) across $(find "$ROOT" -type f | wc -l) files"
echo "Byte-identical pairs: $duplicates (expected 1)"
[ "$duplicates" = '1' ] || { echo "  a seed is reused somewhere above; fix it before trusting a correlation run" >&2; exit 1; }

echo
echo "Ours: A on jellyfin-local, B on plex-local.  A friend's: C on jellyfin-remote, D on plex-remote."
echo
echo "What this is meant to exercise:"
echo "  S01E01  A better, B worse                    -> in sync"
echo "  S01E02  B better, A worse                    -> outdated"
echo "  S01E03  B only                               -> missing"
echo "  S01E04  B only, 2160p                        -> missing, and the odd one in the season"
echo "  S01E05  A and B, identical bytes, unrelated  -> matched on content, not on title"
echo "  S01E06  A, B and D — three of the four       -> three sources under one quality chip"
echo "  S01E07  A 480p, B 720p, C 1080p, D 2160p     -> four sources, four encodings, a real choice"
echo "  S02E01  B only, a whole season               -> a season answered entirely from our side"
echo "  S03     C only, three episodes               -> a season card with nothing held at all"
echo "  Cowboy Bebop  spelled apart, B 2160p         -> normalisation, then outdated"
echo "  Tears of Steel  A and B                      -> a film we already share"
echo "  Elephants Dream, Sintel  B only              -> films only the other local holds"
echo "  Big Buck Bunny  C and D only                 -> a film both remotes hold and we do not"
echo
echo "The libraries are named Shows/Movies on both of ours, Séries/Films on"
echo "jellyfin-remote and TV/Movies on plex-remote. Libraries of the same name are one"
echo "category, so Shows folds two and Movies folds three, while Séries, TV and Films"
echo "each stand alone although they mean the same thing — the merge, and its limit."
echo
echo "Real titles on purpose: every server fetches real artwork and real TVDB/TMDB"
echo "identifiers, which is what makes the poster wall and the external-id strategy"
echo "testable at all."
