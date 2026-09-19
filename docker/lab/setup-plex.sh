#!/usr/bin/env bash
#
# Adds the two lab libraries to Plex and scans them.
#
# No token: the container runs unclaimed and `ALLOWED_NETWORKS` covers the Docker
# bridge, which is what lets a lab exist without a Plex account. A claimed server would
# need one, and a fresh claim token every run — they expire in minutes.
set -euo pipefail

BASE="${1:-http://localhost:32400}"

# Plex answers `/identity` while it is still starting its plugins, and refuses to
# create a section until it is not. Waiting on `startState` rather than on the port is
# the difference between this script working and failing with a 400 that says nothing.
for _ in $(seq 1 60); do
	state=$(curl -sS --max-time 3 "$BASE/identity" 2>/dev/null | grep -o 'startState="[^"]*"' || true)
	[ -z "$state" ] && { sleep 2; continue; }
	[ "$state" = 'startState="starting"' ] || [ "$state" = 'startState="startingPlugins"' ] || break
	sleep 2
done

sections=$(curl -sS "$BASE/library/sections" -H 'Accept: application/json')

add_section() {
	local name="$1" type="$2" agent="$3" scanner="$4" path="$5"

	if printf '%s' "$sections" | grep -q "\"title\":\"$name\""; then
		echo "  section $name already there"
		return 0
	fi

	local code
	code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
		"$BASE/library/sections?name=$name&type=$type&agent=$agent&scanner=$(printf '%s' "$scanner" | sed 's/ /%20/g')&language=en-US&location=$(printf '%s' "$path" | sed 's|/|%2F|g')")

	if [ "$code" != '201' ] && [ "$code" != '200' ]; then
		echo "  section $name refused ($code)" >&2
		return 1
	fi
	echo "  section $name -> $path"
}

echo "Adding Plex libraries"
add_section Shows show tv.plex.agents.series 'Plex TV Series' /media/shows
add_section Movies movie tv.plex.agents.movie 'Plex Movie' /media/movies

for key in $(curl -sS "$BASE/library/sections" -H 'Accept: application/json' \
	| tr ',' '\n' | grep -o '"key":"[0-9]*"' | cut -d'"' -f4); do
	curl -sS -o /dev/null "$BASE/library/sections/$key/refresh"
done

echo
echo "  Plex      $BASE/web  (unclaimed, no account needed on this network)"
echo "  Scanning is asynchronous; give it half a minute before registering it."
