#!/usr/bin/env bash
#
# Drives the Jellyfin setup wizard, adds the two lab libraries and mints an API key.
#
# This is automated rather than documented as a manual step because a lab you have to
# click through is a lab nobody re-creates. The cost is that it speaks to the startup
# endpoints of one Jellyfin generation; the version is pinned in the compose file for
# exactly that reason, and if this script breaks after a bump, the wizard changed and
# the handler probably did too.
set -euo pipefail

BASE="${1:-http://localhost:8096}"
USERNAME="${LAB_JELLYFIN_USER:-lab}"
PASSWORD="${LAB_JELLYFIN_PASSWORD:-lab}"

api() {
	local method="$1" path="$2" body="${3:-}"
	local args=(-sS -X "$method" -H 'Content-Type: application/json')
	[ -n "$body" ] && args+=(-d "$body")
	curl "${args[@]}" "$BASE$path"
}

completed=$(curl -sS "$BASE/System/Info/Public" | grep -o '"StartupWizardCompleted":[a-z]*' | cut -d: -f2)

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

	if curl -sS -H "X-Emby-Token: $token" "$BASE/Library/VirtualFolders" | grep -q "\"Name\":\"$name\""; then
		echo "  library $name already there"
		return 0
	fi

	curl -sS -X POST -H 'Content-Type: application/json' -H "X-Emby-Token: $token" \
		-d "{\"LibraryOptions\":{\"PathInfos\":[{\"Path\":\"$path\"}]}}" \
		"$BASE/Library/VirtualFolders?name=$name&collectionType=$kind&refreshLibrary=true" >/dev/null
	echo "  library $name -> $path"
}

echo "Adding libraries"
add_library Shows tvshows /media/shows
add_library Movies movies /media/movies

# An API key rather than the session token: it is what the gateway stores, it does not
# expire with a session, and revoking it from the Jellyfin dashboard is the obvious way
# to cut the gateway off.
if ! curl -sS -H "X-Emby-Token: $token" "$BASE/Auth/Keys" | grep -q 'media-center-sync'; then
	curl -sS -X POST -H "X-Emby-Token: $token" "$BASE/Auth/Keys?app=media-center-sync" >/dev/null
fi

key=$(curl -sS -H "X-Emby-Token: $token" "$BASE/Auth/Keys" \
	| tr ',' '\n' | grep -A0 'AccessToken' | grep -o '"AccessToken":"[^"]*"' | head -1 | cut -d'"' -f4)

echo
echo "  Jellyfin  $BASE"
echo "  account   $USERNAME / $PASSWORD"
echo "  API key   ${key:-<read it from Dashboard, API keys>}"
echo
echo "  Register it in the gateway as a remote Jellyfin service with that key."
