#!/usr/bin/env bash
#
# Registers the four lab servers in a gateway, with the path mapping that makes them
# usable, and scans them.
#
#     register-services.sh <gateway-url> <keys-directory>
#
# `print-services.sh` prints what somebody would type; this types it. Doing it by hand
# is four forms, two API keys read off a screen that has scrolled, and one field —
# the root mapping — that nothing on the screen forces anybody to fill in. Leave it out
# and every library is unwritable, so the first pull is refused with
# `error.library.path_not_writable` and the lab looks broken when it is merely unwired.
#
# **The mapping is the whole reason this script exists.** Jellyfin reports `/media/shows`
# because that is the path inside its own container; the gateway running on the host
# reaches the same files at `var/lab/media/library-a/shows`. Both are true and neither
# is guessable, which is exactly the situation a real deployment is in.
#
# Which of the four is local and which is remote is a decision, not a fact about any
# container: local means the gateway may write there — a pull target — and remote means
# read-only, a source. The lab has four servers precisely so both exist.
#
# Re-runnable: a service already registered under the same name is updated rather than
# duplicated, so this can be run after every `lab/up` without thinking about it.
set -euo pipefail

GATEWAY="${1:?usage: register-services.sh <gateway-url> <keys-directory>}"
KEYS="${2:?usage: register-services.sh <gateway-url> <keys-directory>}"

USER_NAME="${MCS_ADMIN_USER:-admin}"
PASSWORD="${MCS_ADMIN_PASSWORD:-admin}"

# The lab's media on this machine. Each server mounts one of these as its own `/media`,
# which is the correspondence every mapping below states.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/var/lab/media"

key_of() {
	local file="$KEYS/$1.key"
	[ -f "$file" ] && cat "$file" || printf ''
}

say() {
	printf '  %s\n' "$1"
}

TOKEN="$(
	curl -fsS -X POST "$GATEWAY/api/auth/login" \
		-H 'Content-Type: application/json' \
		-d "{\"provider\":\"internal\",\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}" |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])'
)"

# One request for the whole list rather than one per name: four lookups against a
# gateway that answers all of them in one is three round trips spent on nothing.
EXISTING="$(curl -fsS "$GATEWAY/api/services" -H "Authorization: Bearer $TOKEN")"

register() {
	local name="$1" type="$2" url="$3" token="$4" priority="$5" local_root="$6"
	local id body

	# Matched on the address and not on the name, because the address is what a gateway
	# refuses a duplicate on. Keyed on the name instead, a second run against a lab
	# somebody had already wired by hand would try to create a service that exists and
	# fail on a conflict that is not one.
	id="$(
		printf '%s' "$EXISTING" |
			python3 -c 'import json,sys
url = sys.argv[1].rstrip("/")
print(next((one["id"] for one in json.load(sys.stdin)
            if (one.get("baseUrl") or "").rstrip("/") == url), ""))' "$url"
	)"

	# The mapping goes in on registration rather than being left for somebody to add:
	# a service registered without one has libraries nothing can write into, and the
	# failure only shows up at the first pull, several screens away from its cause.
	body="$(
		python3 -c 'import json,sys
name, kind, url, token, priority, local_root = sys.argv[1:7]
payload = {
    "name": name,
    "type": kind,
    "baseUrl": url,
    "priority": int(priority),
}
if token:
    payload["token"] = token
if local_root:
    payload["rootMappings"] = [{"remoteRoot": "/media", "localRoot": local_root}]
print(json.dumps(payload))' "$name" "$type" "$url" "$token" "$priority" "$local_root"
	)"

	if [ -n "$id" ]; then
		curl -fsS -X PATCH "$GATEWAY/api/services/$id" \
			-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
			-d "$body" > /dev/null
		say "updated $name"
	else
		id="$(
			curl -fsS -X POST "$GATEWAY/api/services" \
				-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
				-d "$body" |
				python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
		)"
		say "registered $name"
	fi

	# Scanned on the way in, because a registered service with an empty catalogue is
	# indistinguishable from one that cannot be read.
	curl -fsS -X POST "$GATEWAY/api/services/$id/scan" \
		-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' > /dev/null
}

printf '\n'

# Ours: mapped, so the gateway can write into them. These are the only possible targets
# of a pull, and the priority is what makes the nearer one the preferred source.
register 'lab jellyfin (ours)' jellyfin \
	"http://localhost:${LAB_JELLYFIN_PORT:-8096}" "$(key_of jellyfin-local)" 10 "$ROOT/library-a"
register 'lab plex (ours)' plex \
	"http://localhost:${LAB_PLEX_PORT:-32400}" '' 20 "$ROOT/library-b"

# A friend's: no mapping, deliberately. Their files are not on our disks and never will
# be — they are read over HTTP, which is what makes them a source and not a target.
register 'lab jellyfin (a friend)' jellyfin \
	"http://localhost:${LAB_JELLYFIN_REMOTE_PORT:-8097}" "$(key_of jellyfin-remote)" 50 ''
register 'lab plex (a friend)' plex \
	"http://localhost:${LAB_PLEX_REMOTE_PORT:-32401}" '' 60 ''

# The indexer and the download client, which are settings rather than services: one of
# each, and neither is a library. Wired here for the same reason the mappings are —
# the path correspondence between what the client writes and what the gateway reads is
# the field nothing forces anybody to fill in, and getting it wrong succeeds at every
# step while the file is never filed.
PROWLARR_KEY="$(key_of prowlarr)"
QBITTORRENT_PASSWORD="$(key_of qbittorrent)"
# The request source is a third thing again, and it is not a source of media: Seerr says
# what the household asked for and hands over nothing. Wired here anyway, because the one
# question that cannot be answered without it — do we already hold what somebody asked
# for — is a question about this gateway's catalogue and nothing else.
SEERR_KEY="$(key_of seerr)"

if [ -n "$PROWLARR_KEY" ] || [ -n "$QBITTORRENT_PASSWORD" ] || [ -n "$SEERR_KEY" ]; then
	SETTINGS="$(
		python3 -c 'import json,sys
key, password, torrents, prowlarr_port, qb_port, seerr_key, seerr_port = sys.argv[1:8]
patch = {}
if key:
    patch["indexer"] = {
        "type": "prowlarr",
        "baseUrl": f"http://localhost:{prowlarr_port}",
        "apiKey": key,
        "enabled": True,
    }
# `admin` is what the image creates; the password is whatever the setup script found or
# set. The two paths are the lab making the real problem real: qBittorrent writes to
# /downloads inside its container, and the gateway reaches the same files here.
patch["downloadClient"] = {
    "type": "qbittorrent",
    "baseUrl": f"http://localhost:{qb_port}",
    "username": "admin",
    "rootMappings": [{"remoteRoot": "/downloads", "localRoot": torrents}],
    "enabled": True,
}
if password:
    patch["downloadClient"]["password"] = password
if seerr_key:
    patch["requestSource"] = {
        "type": "seerr",
        "baseUrl": f"http://localhost:{seerr_port}",
        "apiKey": seerr_key,
        "enabled": True,
    }
print(json.dumps(patch))' \
			"$PROWLARR_KEY" "$QBITTORRENT_PASSWORD" \
			"$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/var/lab/torrents" \
			"${LAB_PROWLARR_PORT:-9696}" "${LAB_QBITTORRENT_PORT:-8090}" \
			"$SEERR_KEY" "${LAB_SEERR_PORT:-5055}"
	)"

	curl -fsS -X PATCH "$GATEWAY/api/settings" \
		-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
		-d "$SETTINGS" > /dev/null
	say 'wired the indexer, the download client and the request source'
fi

printf '\n'
say "Registered in $GATEWAY. The two of ours are mapped onto $ROOT and are writable;"
say 'the two of a friend’s are read-only sources, which is what makes a pull mean'
say 'anything at all.'
printf '\n'
