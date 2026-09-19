#!/usr/bin/env bash
#
# Drives the Jellyfin setup wizard, adds the libraries it is given and mints an API key.
#
#     setup-jellyfin.sh <base-url> <name>:<kind>:<path> [<name>:<kind>:<path> ...]
#
# The libraries are arguments rather than constants because the lab runs two Jellyfin
# servers that must not be configured alike: one is ours and calls its libraries
# `Shows` and `Movies`, the other is a friend's and calls them `Séries` and `Films`.
# Copying this script to say that would leave two wizards to fix the next time
# Jellyfin changes one, which is the failure this script exists to avoid.
#
# This is automated rather than documented as a manual step because a lab you have to
# click through is a lab nobody re-creates. The cost is that it speaks to the startup
# endpoints of one Jellyfin generation; the version is pinned in the compose file for
# exactly that reason, and if this script breaks after a bump, the wizard changed and
# the handler probably did too.
set -euo pipefail

BASE="${1:?usage: setup-jellyfin.sh <base-url> <name>:<kind>:<path> ...}"
shift
USERNAME="${LAB_JELLYFIN_USER:-lab}"
PASSWORD="${LAB_JELLYFIN_PASSWORD:-lab}"

# Library names are not all ASCII — `Séries` is one of the cases the lab is here to
# prove — and they travel in the query string. Sent raw, the accented byte reaches
# Jellyfin as whatever the URL parser made of it and the library is created under a
# name nothing will match afterwards. Encoding is done here rather than with a tool so
# the lab keeps its one dependency, ffmpeg.
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

api() {
	local method="$1" path="$2" body="${3:-}"
	local args=(-sS -X "$method" -H 'Content-Type: application/json')
	[ -n "$body" ] && args+=(-d "$body")
	curl "${args[@]}" "$BASE$path"
}

# A Jellyfin that has only just been started answers before it can answer usefully: the
# port accepts and `/System/Info/Public` replies 503 with an empty body. curl reports no
# error for that — it is a perfectly valid HTTP response — so waiting on the port, or on
# curl succeeding, lets the script through a few seconds too early. Under `pipefail` the
# grep that then finds nothing aborts the entire run before a single line is printed,
# which is a remarkably unhelpful way to say "not started yet". So wait for the field
# itself. Four servers boot at once here, which is what turned this from the rare case
# it was with one into the normal one.
completed=''
for _ in $(seq 1 90); do
	completed=$(curl -sS --max-time 3 "$BASE/System/Info/Public" 2>/dev/null \
		| grep -o '"StartupWizardCompleted":[a-z]*' | cut -d: -f2 || true)
	[ -n "$completed" ] && break
	sleep 2
done

if [ -z "$completed" ]; then
	echo "$BASE answered nothing usable after three minutes" >&2
	exit 1
fi

if [ "$completed" = 'false' ]; then
	echo "Running the setup wizard"
	api POST /Startup/Configuration \
		'{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}' >/dev/null
	# The wizard insists on being read before it is written; skipping this leaves the
	# next call answering 400 with no explanation.
	api GET /Startup/User >/dev/null
	api POST /Startup/User "{\"Name\":\"$USERNAME\",\"Password\":\"$PASSWORD\"}" >/dev/null
	api POST /Startup/RemoteAccess \
		'{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}' >/dev/null
	api POST /Startup/Complete >/dev/null
	echo "  account: $USERNAME / $PASSWORD"
else
	echo "Setup wizard already done"
fi

# Jellyfin wants a client identity on the authentication call and refuses it outright
# without one, with a message about the header rather than the credentials.
AUTH_HEADER='Authorization: MediaBrowser Client="media-center-sync-lab", Device="lab", DeviceId="lab", Version="1"'

token=$(curl -sS -X POST -H 'Content-Type: application/json' -H "$AUTH_HEADER" \
	-d "{\"Username\":\"$USERNAME\",\"Pw\":\"$PASSWORD\"}" \
	"$BASE/Users/AuthenticateByName" | grep -o '"AccessToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "$token" ]; then
	echo "Could not sign in as $USERNAME" >&2
	exit 1
fi

add_library() {
	local name="$1" kind="$2" path="$3"

	# The library already there is recognised by its path and not by its name. Jellyfin
	# writes non-ASCII back escaped — `Séries` comes out of the API as `S\u00E9ries` —
	# so a name comparison against what was sent silently never matches, and every
	# re-run of a target advertised as re-runnable adds another library: `Séries2`,
	# then `Séries3`. The path is ASCII, it is the thing that must not be mounted
	# twice, and it does not depend on anybody's idea of an encoding.
	if curl -sS -H "X-Emby-Token: $token" "$BASE/Library/VirtualFolders" | grep -q "\"$path\""; then
		echo "  library $name already there"
		return 0
	fi

	curl -sS -X POST -H 'Content-Type: application/json' -H "X-Emby-Token: $token" \
		-d "{\"LibraryOptions\":{\"PathInfos\":[{\"Path\":\"$path\"}]}}" \
		"$BASE/Library/VirtualFolders?name=$(urlencode "$name")&collectionType=$kind&refreshLibrary=true" >/dev/null
	echo "  library $name -> $path"
}

echo "Adding libraries"
for spec in "$@"; do
	add_library "${spec%%:*}" "$(printf '%s' "$spec" | cut -d: -f2)" "${spec##*:}"
done

# An API key rather than the session token: it is what the gateway stores, it does not
# expire with a session, and revoking it from the Jellyfin dashboard is the obvious way
# to cut the gateway off.
if ! curl -sS -H "X-Emby-Token: $token" "$BASE/Auth/Keys" | grep -q 'media-center-sync'; then
	curl -sS -X POST -H "X-Emby-Token: $token" "$BASE/Auth/Keys?app=media-center-sync" >/dev/null
fi

key=$(curl -sS -H "X-Emby-Token: $token" "$BASE/Auth/Keys" \
	| tr ',' '\n' | grep -A0 'AccessToken' | grep -o '"AccessToken":"[^"]*"' | head -1 | cut -d'"' -f4)

# The key is minted here and needed at the very end of `lab/up`, several servers later.
# Writing it down is what lets that summary be printed once, with all four services
# side by side, instead of scrolling back through four setup runs for two keys.
if [ -n "${LAB_KEY_FILE:-}" ] && [ -n "$key" ]; then
	mkdir -p "$(dirname "$LAB_KEY_FILE")"
	printf '%s\n' "$key" > "$LAB_KEY_FILE"
fi

echo
echo "  Jellyfin  $BASE"
echo "  account   $USERNAME / $PASSWORD"
echo "  API key   ${key:-<read it from Dashboard, API keys>}"
