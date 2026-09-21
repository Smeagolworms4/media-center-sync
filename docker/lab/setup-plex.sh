#!/usr/bin/env bash
#
# Adds the libraries it is given to a Plex server and scans them.
#
#     setup-plex.sh <base-url> <name>:<type>:<path> [<name>:<type>:<path> ...]
#
# The libraries are arguments rather than constants because the lab runs two Plex
# servers that must not be configured alike: one is ours and calls its libraries
# `Shows` and `Movies`, the other is a friend's and calls its shows `TV`. Libraries of
# the same name are one category in the gateway, so which server calls which library
# what is exactly the thing under test, and it cannot live inside the script.
#
# `type` is `show` or `movie`; the agent and the scanner follow from it, and passing
# them in as well would only be four more places to mistype the same two constants.
#
# No token: the containers run unclaimed and `ALLOWED_NETWORKS` covers the Docker
# bridge, which is what lets a lab exist without a Plex account. A claimed server would
# need one, and a fresh claim token every run — they expire in minutes.
set -euo pipefail

BASE="${1:?usage: setup-plex.sh <base-url> <name>:<type>:<path> ...}"
shift

# Library names are not all ASCII and they travel in the query string. See the same
# function in setup-jellyfin.sh: sent raw, an accented byte reaches the server as
# whatever the URL parser made of it, and the library is created under a name nothing
# will match afterwards.
urlencode() {
	local string="$1" i char out=''

	for ((i = 0; i < ${#string}; i++)); do
		char="${string:i:1}"
		case "$char" in
			[a-zA-Z0-9.~_-]) out+="$char" ;;
			*) out+="$(printf '%s' "$char" | od -An -tx1 | tr -d ' \n' | sed 's/../%&/g')" ;;
		esac
	done

	printf '%s' "$out"
}

# Plex answers `/identity` while it is still starting its plugins, and refuses to
# create a section until it is not. Waiting on `startState` rather than on the port is
# the difference between this script working and failing with a 400 that says nothing.
#
# A server that has finished starting drops the attribute altogether, so an answer that
# names the machine and no state is the ready one. Waiting for a state that never comes
# spent the whole two minutes below on every run, on a server that was ready at once.
for _ in $(seq 1 60); do
	identity=$(curl -sS --max-time 3 "$BASE/identity" 2>/dev/null || true)
	state=$(printf '%s' "$identity" | grep -o 'startState="[^"]*"' || true)
	if [ -z "$state" ]; then
		printf '%s' "$identity" | grep -q 'machineIdentifier=' && break
		sleep 2
		continue
	fi
	[ "$state" = 'startState="starting"' ] || [ "$state" = 'startState="startingPlugins"' ] || break
	sleep 2
done

sections=$(curl -sS "$BASE/library/sections" -H 'Accept: application/json')

add_section() {
	local name="$1" type="$2" path="$3" agent scanner

	case "$type" in
		show) agent='tv.plex.agents.series'; scanner='Plex TV Series' ;;
		movie) agent='tv.plex.agents.movie'; scanner='Plex Movie' ;;
		*) echo "  unknown library type $type" >&2; return 1 ;;
	esac

	# Recognised by its path and not by its title, for the same reason as in
	# setup-jellyfin.sh: a server is free to write a non-ASCII title back escaped, a
	# title comparison against what was sent then never matches, and a target
	# advertised as re-runnable quietly mounts the same directory a second time.
	if printf '%s' "$sections" | grep -q "\"path\":\"$path\""; then
		echo "  section $name already there"
		return 0
	fi

	local code
	code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
		"$BASE/library/sections?name=$(urlencode "$name")&type=$type&agent=$agent&scanner=$(urlencode "$scanner")&language=en-US&location=$(urlencode "$path")")

	if [ "$code" != '201' ] && [ "$code" != '200' ]; then
		echo "  section $name refused ($code)" >&2
		return 1
	fi
	echo "  section $name -> $path"
}

echo "Adding Plex libraries"
for spec in "$@"; do
	add_section "${spec%%:*}" "$(printf '%s' "$spec" | cut -d: -f2)" "${spec##*:}"
done

for key in $(curl -sS "$BASE/library/sections" -H 'Accept: application/json' \
	| tr ',' '\n' | grep -o '"key":"[0-9]*"' | cut -d'"' -f4); do
	curl -sS -o /dev/null "$BASE/library/sections/$key/refresh"
done

echo
echo "  Plex      $BASE/web  (unclaimed, no account needed on this network)"
echo "  Scanning is asynchronous; give it half a minute before registering it."
