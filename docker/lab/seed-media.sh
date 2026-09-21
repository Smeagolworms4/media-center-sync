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
# Every file is made from one source: thirty seconds of *Big Buck Bunny*, committed at
# `fixtures/big-buck-bunny-30s.mp4` (CC BY 3.0, Blender Foundation — see the
# ATTRIBUTION beside it), scaled and re-encoded here to the resolution and codec each
# name claims. The resolution part matters — the quality comparator reads the stream,
# so a file named 2160p that is really 720p would make the lab prove the opposite of
# what it appears to prove. The single source matters as much, for the runtime: this
# lab used to generate three or four seconds of test pattern per file, two copies of
# one film came out at 3.0 s and 4.0 s, and the different-cut rule read that as two
# versions of the film. Runtime is exactly what that rule reads, so here it is never an
# accident: every file runs for the clip's thirty seconds unless it is one of the three
# pairs below, whose runtimes are chosen on purpose.
#
# THE RUNTIME PAIRS. They pin `QualityService.isConflicting` from both sides — a
# difference over 120 s, or over 30 s *and* over 5 % of the longer runtime, is two cuts
# — so whoever changes that rule breaks one of them and sees it. Do not "tidy" them to
# thirty seconds: that deletes the only real data either side of the rule has.
#
#   Big Buck Bunny, C 30 s against D 42 s — one film, micro-cut. Twelve seconds is 29 %
#     of the longer copy, far over five percent; only the 30-second floor keeps them
#     one film. This is the owner's accident, now kept on purpose: a studio logo or a
#     trimmed credit is a few seconds, and must never split a film into two cards.
#
#   Cosmos Laundromat, A 30 s against D 180 s — two cuts of one film. A 150-second
#     difference trips the absolute branch. Both copies carry the film's real TMDB and
#     IMDb numbers, and a shared work identifier proves they are the same work, so they
#     become one card — in CONFLICT, because the runtime decides the version and these
#     are two. This used to be the opposite: the runtime was a veto asked before the
#     identifiers, the pair stayed two unrelated cards, and CONFLICT was unreachable for
#     any film. The identifier decides the work; the runtime decides the version.
#
#   Samurai Champloo S01E01, A 400 s against C 435 s — two cuts of one episode. The
#     episode number is its identity, so the pair correlates, and 35 s and 8 % apart is
#     past both the floor and the proportion, so it reads CONFLICT.
#
#     The two copies are also encoded to rank level with each other — same resolution
#     and codec, close bitrates and sizes. That was once load-bearing: CONFLICT used to
#     be derived only when neither encode ranked above the other, so a pair whose
#     longer copy was the better encode read OUTDATED instead. It no longer is: the cut
#     is now asked before the quality, because two cuts are two things rather than one
#     thing in two qualities — and ranking them let a replace-outdated sync write an
#     extended cut over a theatrical one. The level encoding is kept only so that this
#     pair reads CONFLICT under either rule, which is what makes a regression visible.
#
# The script measures all three with ffprobe at the end, applies the same rule, and
# refuses to finish when a pair lands on the wrong side of it.
#
# One pair is byte-for-byte identical under two names no title comparison could
# reconcile. It is the only case where content-derived identity can be seen winning,
# and the one that catches a correlation quietly built on names. There is exactly one
# such pair, and the script counts them at the end rather than asking to be believed.
#
# The script only ever creates. It is run again on every `lab/up`, over a tree that
# may hold files the owner put there by hand, so a path that already exists — whoever
# made it — is left exactly as it is.
set -euo pipefail

ROOT="${1:?usage: seed-media.sh <root>}"
CLIP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures/big-buck-bunny-30s.mp4"
CLIP_SECONDS=30

[ -f "$CLIP" ] || { echo "The source clip is missing: $CLIP" >&2; exit 1; }

# Every path this script is responsible for, created now or on an earlier run. The
# checks at the end read this list rather than the whole root: the root may hold the
# owner's own files — one of them is eight gigabytes — and hashing those on every
# `lab/up` would cost minutes and prove nothing about the fixtures.
MANAGED=()

# The file being written, until it is in place. An encode interrupted halfway used to
# leave a truncated file under its final name, and the early return below then kept
# that broken file forever, on every run, with nothing to say it was broken.
PENDING=''
trap 'if [ -n "$PENDING" ]; then rm -f -- "$PENDING"; fi' EXIT

# The owner keeps a real film of that name in the live lab for his own testing, eight
# gigabytes of it. A generated file of the same title would correlate with it, and a
# sync could then choose to pull the whole thing. Refused by name, here, so that no
# fixture added later can walk into it.
refuse_reserved() {
	case "${1,,}" in
		*animatrix*)
			echo "Refusing to create $1: that title is reserved for a real file in the lab" >&2
			exit 1
			;;
	esac
}

# Moves a finished temporary file under its final name, never over anything. `mv -n`
# is the guarantee; its exit status on a refused move changed between coreutils
# releases, so the outcome is read off the disk instead.
settle() {
	local pending="$1" path="$2"

	mv -n -- "$pending" "$path" || true
	PENDING=''

	if [ -e "$pending" ]; then
		rm -f -- "$pending"
		echo "  $path appeared while it was being written; the existing file was kept" >&2
		return 1
	fi
}

# `seed` makes two files identical only when this script says they are. Two encodes of
# the same clip with the same parameters come out byte for byte the same, and an
# accidental checksum match would look like a working strategy. The seed is written
# into the container's comment tag: it lands in the head of the file and changes its
# length, which is what the gateway's fingerprint reads — head, middle, tail and exact
# size — while the picture, the bitrate and the runtime the comparator reads are left
# alone. Every call below carries its own seed, and no two share one.
#
# `seconds` other than the clip's own loops it; `kbps` switches the encode from a
# constant quality to a constant bitrate, which only the CONFLICT pair needs.
encode() {
	local path="$1" width="$2" height="$3" codec="$4" seed="$5"
	local seconds="${6:-$CLIP_SECONDS}" kbps="${7:-}"

	refuse_reserved "$path"
	MANAGED+=("$path")
	mkdir -p "$(dirname "$path")"
	if [ -e "$path" ] || [ -L "$path" ]; then
		return 0
	fi

	local format=mp4 container=(-movflags +faststart)
	case "$path" in
		*.mkv) format=matroska container=() ;;
	esac

	local input=(-i "$CLIP") length=()
	if [ "$seconds" != "$CLIP_SECONDS" ]; then
		input=(-stream_loop -1 -i "$CLIP")
		length=(-t "$seconds")
	fi

	local video=()
	case "$codec" in
		libx265)
			# x265 writes its banner and its summary straight to stderr and ignores
			# ffmpeg's log level; only its own parameter silences it. `hvc1` is the tag
			# Apple clients and some Plex players require before they will even try an
			# HEVC stream in MP4; ffmpeg defaults to `hev1`.
			video=(-c:v libx265 -x265-params log-level=none -preset ultrafast -crf 30)
			if [ "$format" = mp4 ]; then
				video+=(-tag:v hvc1)
			fi
			;;
		libx264)
			if [ -n "$kbps" ]; then
				# CBR with filler, not an average: the CONFLICT pair has a margin of a few
				# percent on both bitrate and size, and an average bitrate drifts by more
				# than that over a looped clip.
				video=(-c:v libx264 -preset veryfast -b:v "${kbps}k" -minrate "${kbps}k"
					-maxrate "${kbps}k" -bufsize "${kbps}k" -x264-params nal-hrd=cbr)
			else
				video=(-c:v libx264 -preset veryfast -crf 26)
			fi
			;;
		*)
			echo "Unknown codec $codec for $path" >&2
			exit 1
			;;
	esac

	# Written beside its destination under a hidden name, so that the move into place
	# is a rename on one filesystem and the half-written file is never visible under a
	# name a media server would index.
	PENDING="$(mktemp "$(dirname "$path")/.seeding.XXXXXX")"
	ffmpeg -hide_banner -loglevel error -y "${input[@]}" "${length[@]}" \
		-map 0:v:0 -map 0:a:0 \
		-vf "scale=${width}:${height}:flags=lanczos,setsar=1" -pix_fmt yuv420p \
		"${video[@]}" -c:a copy \
		-map_metadata -1 -metadata "comment=MediaCenterSync lab fixture, seed $seed" \
		"${container[@]}" -f "$format" "$PENDING"
	settle "$PENDING" "$path" || return 0

	printf '  %-86s %6s  %sx%s %s %ss\n' "${path#"$ROOT"/}" "$(du -h "$path" | cut -f1)" \
		"$width" "$height" "${codec#lib}" "$seconds"
}

A="$ROOT/library-a"
B="$ROOT/library-b"
C="$ROOT/library-c"
D="$ROOT/library-d"

echo
echo "Library A — jellyfin-local, ours, filed the way a media server renames things"

# The season is deliberately not uniform, so the quality summary has something real to
# call "mixed" rather than a tidy row that proves nothing.
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E01 - Dulcinea.mp4" 1920 1080 libx265 1
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E02 - The Big Empty.mp4" 1280 720 libx264 2
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E05 - Back to the Butcher.mp4" 1920 1080 libx265 5
# Held by three of the four, and by both of ours.
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E06 - Rock Bottom.mp4" 1920 1080 libx265 6
# Held by all four, in four different encodings. Ours is the worst of them on purpose:
# the answer to "which source do I pull from" then has to be read off the sources
# rather than guessed from where the gateway happens to be standing.
encode "$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E07 - Windmills.mp4" 854 480 libx264 7
encode "$A/shows/Cowboy Bebop (1998)/Season 01/Cowboy Bebop (1998) - S01E01 - Asteroid Blues.mp4" 1280 720 libx264 3
# The short side of the CONFLICT pair — see the doc block before changing a number.
encode "$A/shows/Samurai Champloo (2004)/Season 01/Samurai Champloo (2004) - S01E01 - Tempestuous Temperaments.mp4" 854 480 libx264 8 400 250
encode "$A/movies/Tears of Steel (2012)/Tears of Steel (2012) - 1080p.mp4" 1920 1080 libx265 4
# The short side of the different-cut film pair.
encode "$A/movies/Cosmos Laundromat (2015)/Cosmos Laundromat (2015) - 1080p.mp4" 1920 1080 libx265 9

echo
echo "Library B — plex-local, ours, filed the way a release lands on a disk"

# Same episode, worse: ours wins, and the state must be neither missing nor outdated.
encode "$B/shows/The.Expanse.S01E01.Dulcinea.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 11
# Same episode, better: theirs wins, and A's copy is outdated.
encode "$B/shows/The.Expanse.S01E02.The.Big.Empty.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 12
# Episodes A has never heard of. This is what a sync is for.
encode "$B/shows/The.Expanse.S01E03.Remember.the.Cant.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 13
encode "$B/shows/The.Expanse.S01E04.CQB.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 14
encode "$B/shows/The.Expanse.S01E06.Rock.Bottom.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 20
encode "$B/shows/The.Expanse.S01E07.Windmills.720p.WEB-DL.x264-LAB.mp4" 1280 720 libx264 21
# A second season neither remote has, so a series card has more than one child group to
# fold and one of them is answered entirely from our own side.
encode "$B/shows/The.Expanse.S02E01.Safe.1080p.BluRay.x265-LAB.mp4" 1920 1080 libx265 18
# A show whose title only normalisation reconciles, in a better encode.
encode "$B/shows/Cowboy.Bebop.S01E01.Asteroid.Blues.2160p.x265-LAB.mp4" 3840 2160 libx265 15
encode "$B/movies/Tears.of.Steel.2012.1080p.x265-LAB.mp4" 1920 1080 libx265 16
# Films A has never heard of, all of them real open-licensed shorts.
encode "$B/movies/Elephants.Dream.2006.1080p.x264-LAB.mp4" 1920 1080 libx264 17
encode "$B/movies/Sintel.2010.1080p.x265-LAB.mp4" 1920 1080 libx265 19

echo
echo "Library C — jellyfin-remote, a friend's, tidy but by another hand"

# Tidy like A, and yet not the same tidy: no year on the folder, no year in the file,
# the season folder spelled without its leading zero. A handler that reads A only
# because of the shape A happens to have fails here, and that is the point of the third
# tree — the two conventions in the first two libraries are not the only two.
encode "$C/shows/The Expanse/Season 1/The Expanse - S01E07 - Windmills.mp4" 1920 1080 libx264 31
# A whole season no local service holds. Its card must show three episodes, three
# sources, and nothing held — which is a different thing from an empty season, and the
# only place the difference can be seen.
encode "$C/shows/The Expanse/Season 3/The Expanse - S03E01 - Fight or Flight.mp4" 1920 1080 libx265 32
encode "$C/shows/The Expanse/Season 3/The Expanse - S03E02 - IFF.mp4" 1920 1080 libx265 33
encode "$C/shows/The Expanse/Season 3/The Expanse - S03E03 - Assured Destruction.mp4" 1280 720 libx264 35
# The long side of the CONFLICT pair: 35 s longer, at a lower constant bitrate so that
# the comparator ranks it neither above nor below A's.
encode "$C/shows/Samurai Champloo/Season 1/Samurai Champloo - S01E01 - Tempestuous Temperaments.mp4" 854 480 libx264 36 435 226
# A film two remotes hold and neither of ours does — and the short side of the
# micro-cut pair.
encode "$C/movies/Big Buck Bunny (2008)/Big Buck Bunny (2008) - 1080p.mp4" 1920 1080 libx264 34

echo
echo "Library D — plex-remote, a friend's, releases dropped into a folder per show"

# Plex is happy to read a release name inside a show folder, which is the third common
# shape and the one the two libraries above do not cover.
encode "$D/shows/The Expanse/Season 01/The.Expanse.S01E06.Rock.Bottom.1080p.WEB-DL.x264-LAB.mp4" 1920 1080 libx264 41
encode "$D/shows/The Expanse/Season 01/The.Expanse.S01E07.Windmills.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 42
# The long side of the micro-cut pair: twelve seconds longer, still one film.
encode "$D/movies/Big.Buck.Bunny.2008.2160p.BluRay.x265-LAB.mp4" 3840 2160 libx265 43 42
# The long side of the different-cut film pair, and the lab's one Matroska file, in SD.
encode "$D/movies/Cosmos.Laundromat.2015.480p.x264-LAB.mkv" 854 480 libx264 44 180

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
IDENTICAL_SOURCE="$A/shows/The Expanse (2015)/Season 01/The Expanse (2015) - S01E05 - Back to the Butcher.mp4"
IDENTICAL_TARGET="$B/shows/Expanse.The.S01E05.INTERNAL.1080p.x265-RELAB.mp4"
refuse_reserved "$IDENTICAL_TARGET"
MANAGED+=("$IDENTICAL_TARGET")
if [ ! -e "$IDENTICAL_TARGET" ] && [ ! -L "$IDENTICAL_TARGET" ]; then
	mkdir -p "$(dirname "$IDENTICAL_TARGET")"
	PENDING="$(mktemp "$(dirname "$IDENTICAL_TARGET")/.seeding.XXXXXX")"
	cp -- "$IDENTICAL_SOURCE" "$PENDING"
	if settle "$PENDING" "$IDENTICAL_TARGET"; then
		printf '  %-86s %6s  (identical to A S01E05)\n' "${IDENTICAL_TARGET#"$ROOT"/}" \
			"$(du -h "$IDENTICAL_TARGET" | cut -f1)"
	fi
fi

# The claim above is checked rather than asserted. A fixture added later with a seed
# that was already taken would come out byte-identical to an existing file, the lab
# would grow a second content match nobody meant, and the one case that proves content
# identity would stop proving it — silently, because two extra identical files break
# nothing that fails.
duplicates=$(md5sum -- "${MANAGED[@]}" | cut -d' ' -f1 | sort | uniq -d | wc -l)

echo
echo "Total: $(du -ch -- "${MANAGED[@]}" | tail -n1 | cut -f1) across ${#MANAGED[@]} files"
echo "Byte-identical pairs: $duplicates (expected 1)"
[ "$duplicates" = '1' ] || { echo "  a seed is reused somewhere above; fix it before trusting a correlation run" >&2; exit 1; }

# The runtime pairs are checked the same way. An encoder upgrade that shifts a constant
# bitrate by a few percent, or somebody rounding a runtime, would move a pair across the
# rule without a single failure anywhere: the lab would go on building, and the one
# screen it exists to show would quietly stop appearing.
#
# Prints: runtime in ms, size in bytes, overall bitrate, height, video codec — the
# overall bitrate because that is the one Jellyfin reports as the source's bitrate.
measure() {
	ffprobe -v error -select_streams v:0 \
		-show_entries format=duration,size,bit_rate:stream=codec_name,height \
		-of default=noprint_wrappers=1 "$1" |
		awk -F= '{ v[$1] = $2 } END {
			printf "%d %d %d %d %s\n", v["duration"] * 1000, v["size"], v["bit_rate"], v["height"], v["codec_name"]
		}'
}

# The same arithmetic as `QualityService.isConflicting` and, for `conflict`, the part of
# `QualityService.compare` that has to come out even for the state to be derived.
check_pair() {
	local label="$1" expected="$2" left right

	left="$(measure "$3")"
	right="$(measure "$4")"

	local verdict
	verdict="$(awk -v expected="$expected" -v l="$left" -v r="$right" 'BEGIN {
		split(l, a, " "); split(r, b, " ")
		difference = a[1] > b[1] ? a[1] - b[1] : b[1] - a[1]
		longest = a[1] > b[1] ? a[1] : b[1]
		separate = difference > 120000 || (difference > 30000 && difference / longest > 0.05)
		bitrates = (a[3] > b[3] ? a[3] - b[3] : b[3] - a[3]) / (a[3] > b[3] ? a[3] : b[3])
		sizes = (a[2] > b[2] ? a[2] - b[2] : b[2] - a[2]) / (a[2] > b[2] ? a[2] : b[2])
		even = a[4] == b[4] && a[5] == b[5] && bitrates < 0.1 && sizes < 0.05
		# A conflict is a cut difference and nothing more. It used to require the two
		# encodes to rank level too, and that condition is exactly what hid CONFLICT
		# whenever one copy was the better encode. `even` is still reported, not used.
		if (expected == "same") ok = !separate
		else ok = separate
		printf "%s|%.1f s against %.1f s, %.1f s apart", ok ? "ok" : "FAIL", a[1] / 1000, b[1] / 1000, difference / 1000
		if (expected == "conflict") printf ", bitrates %.1f %% apart, sizes %.1f %% apart", bitrates * 100, sizes * 100
	}')"

	printf '  %-4s %-26s %-9s %s\n' "${verdict%%|*}" "$label" "$expected" "${verdict#*|}"
	[ "${verdict%%|*}" = 'ok' ]
}

echo
echo "Runtime pairs, measured:"
cuts_ok=0
check_pair 'Tears of Steel, A and B' same \
	"$A/movies/Tears of Steel (2012)/Tears of Steel (2012) - 1080p.mp4" \
	"$B/movies/Tears.of.Steel.2012.1080p.x265-LAB.mp4" || cuts_ok=1
check_pair 'Big Buck Bunny, C and D' same \
	"$C/movies/Big Buck Bunny (2008)/Big Buck Bunny (2008) - 1080p.mp4" \
	"$D/movies/Big.Buck.Bunny.2008.2160p.BluRay.x265-LAB.mp4" || cuts_ok=1
check_pair 'Cosmos Laundromat, A and D' conflict \
	"$A/movies/Cosmos Laundromat (2015)/Cosmos Laundromat (2015) - 1080p.mp4" \
	"$D/movies/Cosmos.Laundromat.2015.480p.x264-LAB.mkv" || cuts_ok=1
check_pair 'Samurai Champloo, A and C' conflict \
	"$A/shows/Samurai Champloo (2004)/Season 01/Samurai Champloo (2004) - S01E01 - Tempestuous Temperaments.mp4" \
	"$C/shows/Samurai Champloo/Season 1/Samurai Champloo - S01E01 - Tempestuous Temperaments.mp4" || cuts_ok=1
[ "$cuts_ok" = 0 ] || { echo "  a runtime pair landed on the wrong side of the different-cut rule; see the doc block" >&2; exit 1; }

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
echo "  Samurai Champloo S01E01  A 400 s, C 435 s    -> conflict: two cuts, neither better"
echo "  Tears of Steel  A and B                      -> a film we already share"
echo "  Cosmos Laundromat  A 30 s, D 180 s           -> two cuts of one film: one card, conflict"
echo "  Elephants Dream, Sintel  B only              -> films only the other local holds"
echo "  Big Buck Bunny  C 30 s and D 42 s only       -> a film both remotes hold, micro-cut, one card"
echo
echo "The libraries are named Shows/Movies on both of ours, Séries/Films on"
echo "jellyfin-remote and TV/Movies on plex-remote. Libraries of the same name are one"
echo "category, so Shows folds two and Movies folds three, while Séries, TV and Films"
echo "each stand alone although they mean the same thing — the merge, and its limit."
echo
echo "Real titles on purpose: every server fetches real artwork and real TVDB/TMDB"
echo "identifiers, which is what makes the poster wall and the external-id strategy"
echo "testable at all."
