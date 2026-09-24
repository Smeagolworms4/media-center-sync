#!/usr/bin/env bash
#
# Waits for Prowlarr and writes down the API key the gateway has to be registered with.
#
#     setup-prowlarr.sh <base-url>
#
# There is no wizard to drive here, and that is worth stating because the interface
# looks like there is: Prowlarr generates a complete configuration on its very first
# start — API key included — and serves `/api/v1` immediately. What a browser shows on
# a fresh install is the authentication screen of the interface, not a setup step, and
# it has no bearing on the API. So this script's whole job is to find the key that
# already exists and put it where `lab/services` can print it.
#
# The key is read out of `/config/config.xml` inside the container, which is ugly and
# is nonetheless the only reliable route. Every endpoint that could report it is itself
# behind it — `GET /api/v1/config/host` answers 401 without the key it would return —
# and the one place the interface exposes it is behind a UI session, which would mean
# logging in with an authentication method the lab does not configure. Minting a fresh
# one over the API has the same problem. `config.xml` is where Prowlarr generates and
# keeps it, and a container we started is a place we are entitled to read.
#
# Re-runnable, and by construction: the key is read, never created, so a Prowlarr that
# was already set up hands back the same key it handed back last time. Regenerating one
# would silently invalidate whatever the gateway already has stored for this service.
set -euo pipefail

BASE="${1:?usage: setup-prowlarr.sh <base-url>}"

# The compose project rather than a container name: `media-center-sync-lab-prowlarr-1`
# is an artefact of how Compose numbers containers and it changes the day somebody runs
# the lab under another project name. The labels are what Compose itself looks things
# up by.
PROJECT="${LAB_COMPOSE_PROJECT:-media-center-sync-lab}"
CONTAINER="${LAB_PROWLARR_CONTAINER:-$(docker ps -q \
	--filter "label=com.docker.compose.project=$PROJECT" \
	--filter 'label=com.docker.compose.service=prowlarr' | head -1)}"

if [ -z "$CONTAINER" ]; then
	echo "No running prowlarr container in the $PROJECT project; start it with 'make lab/up'" >&2
	exit 1
fi

# `/ping` rather than the port, and rather than `/api/v1/system/status`: the port is
# bound while the database migrations are still running, and the status endpoint needs
# the key this script has not read yet. `/ping` is the one route Prowlarr answers
# without a credential, and it answers it only once it is actually serving.
ready=''
for _ in $(seq 1 90); do
	ready=$(curl -sS --max-time 3 "$BASE/ping" 2>/dev/null | grep -o '"status"' || true)
	[ -n "$ready" ] && break
	sleep 2
done

if [ -z "$ready" ]; then
	echo "$BASE answered nothing usable after three minutes" >&2
	exit 1
fi

key=$(docker exec "$CONTAINER" cat /config/config.xml 2>/dev/null \
	| grep -o '<ApiKey>[^<]*</ApiKey>' | sed 's/<[^>]*>//g' || true)

if [ -z "$key" ]; then
	echo "No ApiKey in /config/config.xml of $CONTAINER; Prowlarr has not written its" >&2
	echo "configuration yet, or this container is not the one serving $BASE" >&2
	exit 1
fi

# The key is read from a file and the URL comes from the caller, so nothing so far has
# proven the two belong together — point this at the wrong port and everything above
# still succeeds. One authenticated call settles it, and it is the same call the
# gateway makes when a service is registered.
if ! curl -sS -H "X-Api-Key: $key" "$BASE/api/v1/system/status" | grep -q '"appName"'; then
	echo "$BASE refused the key read from $CONTAINER; they are not the same Prowlarr" >&2
	exit 1
fi

# Written down for the same reason as the Jellyfin keys: this runs in the middle of a
# `lab/up` that prints some sixty lines, and a key read off a screen that has scrolled
# is how a service gets registered with the wrong one — which looks exactly like a
# service that is down.
if [ -n "${LAB_KEY_FILE:-}" ]; then
	mkdir -p "$(dirname "$LAB_KEY_FILE")"
	printf '%s\n' "$key" > "$LAB_KEY_FILE"
fi

echo
echo "  Prowlarr  $BASE"
echo "  API key   $key"
echo "  No indexer is configured: which ones a lab may talk to is not ours to decide,"
echo "  and a search against none answers an empty list rather than an error."
