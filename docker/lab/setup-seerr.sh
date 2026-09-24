#!/usr/bin/env bash
#
# Drives the Seerr setup wizard, opens a couple of asks, and writes down the API key.
#
#     setup-seerr.sh <base-url> [<jellyfin-host>] [<jellyfin-port>]
#
# Seerr — and the Overseerr and Jellyseerr it descends from — cannot be configured by
# dropping a file in place: the first request it accepts is the one that creates the
# administrator, and everything else is behind that account. So this drives the same four
# calls its own setup screens make, in the same order, and each one is here because
# skipping it leaves the server answering but useless:
#
#   1. `POST /api/v1/auth/jellyfin` with a hostname creates the admin *and* stores the
#      media server. It is the only call that may carry a hostname; a second one with a
#      hostname answers 500 `Jellyfin hostname already configured`, which is why the
#      re-run path below signs in with credentials alone.
#   2. `GET /api/v1/settings/jellyfin/library?sync=true` makes it read the libraries. Left
#      out, Seerr knows of no library and reports nothing as held, for ever.
#   3. `GET …?enable=<ids>` switches them on. Syncing does not enable.
#   4. `POST /api/v1/settings/initialize` flips `initialized`. Until then its interface
#      redirects every page to the wizard while the API answers perfectly well — a
#      difference that costs an evening if you are looking at a browser.
#
# It then opens two requests, because a request source with nothing in it proves only
# that the address is right. What they demonstrate is the thing the gateway's
# `RequestSource.details` exists for: **a request row carries no title.** Read
# `/api/v1/request` here and both rows answer `"title": null` — a film and a show, filed
# by number, with nothing readable on them. That is not a quirk of this lab, it is what
# the API is, and it is why the gateway looks the work up separately.
#
# Both asks name works with real metadata identifiers, so Seerr resolves them against its
# metadata provider — which means **this script needs the internet**, unlike every other
# part of the lab. Nothing else here does, and the consequence is worth knowing rather
# than discovering: offline, the admin and the libraries still get set up and the two
# requests simply are not created.
#
# Re-runnable: an initialised Seerr is signed into rather than set up again, and the asks
# are created only if the request list is empty, because Seerr answers 409 to a duplicate
# and `set -e` would take the run down with it.
set -euo pipefail

BASE="${1:?usage: setup-seerr.sh <base-url> [<jellyfin-host>] [<jellyfin-port>]}"
# The service name on the compose network, not the address this script is called on:
# Seerr resolves it from inside its own container, where `localhost` is Seerr.
JELLYFIN_HOST="${2:-jellyfin-local}"
JELLYFIN_PORT="${3:-8096}"
USERNAME="${LAB_JELLYFIN_USER:-lab}"
PASSWORD="${LAB_JELLYFIN_PASSWORD:-lab}"
JAR="$(mktemp)"

trap 'rm -f "$JAR"' EXIT

# Seerr binds its port well before it serves: the first seconds answer connection resets
# while it migrates its database. `/api/v1/status` is the one route that needs no
# credential and no configuration, and it answers only once the application is up.
version=''
for _ in $(seq 1 90); do
	version=$(curl -sS --max-time 3 "$BASE/api/v1/status" 2>/dev/null \
		| grep -o '"version":"[^"]*"' | cut -d'"' -f4 || true)
	[ -n "$version" ] && break
	sleep 2
done

if [ -z "$version" ]; then
	echo "$BASE answered nothing usable after three minutes" >&2
	exit 1
fi

initialized=$(curl -sS "$BASE/api/v1/settings/public" | grep -o '"initialized":[a-z]*' | cut -d: -f2)

if [ "$initialized" = 'true' ]; then
	# Credentials only. Sending the hostname again is the 500 described above, and under
	# `set -e` with `-f` it would abort a re-run that had nothing wrong with it.
	curl -sS -f -c "$JAR" -X POST "$BASE/api/v1/auth/jellyfin" \
		-H 'Content-Type: application/json' \
		-d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" >/dev/null
else
	curl -sS -f -c "$JAR" -X POST "$BASE/api/v1/auth/jellyfin" \
		-H 'Content-Type: application/json' \
		-d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"hostname\":\"$JELLYFIN_HOST\",\"port\":$JELLYFIN_PORT,\"useSsl\":false,\"urlBase\":\"\",\"email\":\"$USERNAME@lab.invalid\",\"serverType\":2}" \
		>/dev/null

	libraries=$(curl -sS -b "$JAR" "$BASE/api/v1/settings/jellyfin/library?sync=true")
	ids=$(printf '%s' "$libraries" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | paste -sd, -)

	if [ -z "$ids" ]; then
		echo "$BASE synced no library from $JELLYFIN_HOST:$JELLYFIN_PORT." >&2
		echo "Seerr reaches Jellyfin by service name on the compose network, so this is" >&2
		echo "either the wrong name or a Jellyfin whose own setup has not run yet." >&2
		exit 1
	fi

	curl -sS -b "$JAR" "$BASE/api/v1/settings/jellyfin/library?enable=$ids" >/dev/null
	curl -sS -b "$JAR" -X POST "$BASE/api/v1/settings/initialize" >/dev/null
fi

key=$(curl -sS -b "$JAR" "$BASE/api/v1/settings/main" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)

if [ -z "$key" ]; then
	echo "$BASE would not hand over its API key; the sign-in above did not take" >&2
	exit 1
fi

# The same check every other setup script here ends with: the key came from one place and
# the URL from another, so nothing yet proves they belong together. `/api/v1/request/count`
# is what the gateway itself probes with, and it is deliberately not `/api/v1/status` —
# that one answers without a key and would go green on a wrong one.
if ! curl -sS -H "X-Api-Key: $key" "$BASE/api/v1/request/count" | grep -q '"total"'; then
	echo "$BASE refused the key it just handed over; this is not the Seerr it looks like" >&2
	exit 1
fi

# Two asks, and only when there are none: Seerr answers 409 to a duplicate.
#
# A film and a show, and the show is asked for by season, because the gateway's verdict
# turns on precisely that difference — a request for one season of a show we hold three of
# is fulfilled, and a request for a season we hold none of is not, and the two must never
# read alike. The identifiers are TMDB's: 438631 is Dune (2021), 95396 is Severance.
count=$(curl -sS -H "X-Api-Key: $key" "$BASE/api/v1/request/count" \
	| grep -o '"total":[0-9]*' | cut -d: -f2)

if [ "${count:-0}" = '0' ]; then
	for ask in '{"mediaType":"movie","mediaId":438631}' '{"mediaType":"tv","mediaId":95396,"seasons":[1]}'; do
		if ! curl -sS -f -X POST "$BASE/api/v1/request" \
			-H "X-Api-Key: $key" -H 'Content-Type: application/json' -d "$ask" >/dev/null 2>&1; then
			echo "  (could not open an ask; Seerr resolves these against its metadata"
			echo "   provider, so this is what being offline looks like)"
			break
		fi
	done
fi

if [ -n "${LAB_KEY_FILE:-}" ]; then
	mkdir -p "$(dirname "$LAB_KEY_FILE")"
	printf '%s\n' "$key" > "$LAB_KEY_FILE"
fi

echo
echo "  Seerr     $BASE  (version $version)"
echo "  API key   $key"
echo "  Sign in   $USERNAME / $PASSWORD, through Jellyfin at $JELLYFIN_HOST:$JELLYFIN_PORT"
echo "  Two asks are open, and neither carries a title — which is the point: the gateway"
echo "  has to look the work up to have anything to put on a screen or to search with."
