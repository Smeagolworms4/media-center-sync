#!/usr/bin/env bash
#
# Adds the lab's fake indexer to Prowlarr as a Generic Torznab indexer, and proves the
# search works through Prowlarr rather than only against the fixture.
#
#     register-in-prowlarr.sh <prowlarr-base-url> [api-key]
#
# It lives beside the indexer rather than with the other `setup-*` scripts because it is
# part of the fixture: the definition it posts — the base URL on the compose network, the
# API path, the categories Prowlarr will map — is only correct for this indexer, and a
# generic "add an indexer" step would have to be told all of it anyway.
#
# `http://fake-indexer:9117` and not `localhost`: Prowlarr dials this itself, from inside
# its own container, and an indexer registered on `localhost` tests green from a browser
# on the workstation and fails from the only place it is ever used.
#
# The API key is a formality. Prowlarr requires the field for a Torznab indexer and sends
# it on every call; the lab's indexer ignores it (see `server.js`).
#
# Re-runnable: an indexer already there under the same name is updated in place, which
# matters because deleting and re-adding it would give it a new id — and the gateway, or
# anybody's saved search, refers to indexers by id.
set -euo pipefail

BASE="${1:?usage: register-in-prowlarr.sh <prowlarr-base-url> [api-key]}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KEY="${2:-$(cat "$ROOT/var/lab/keys/prowlarr.key" 2>/dev/null || true)}"

NAME="${LAB_FAKE_INDEXER_NAME:-lab fake indexer}"

# The address on the compose network, which is what Prowlarr has to reach. The port is
# the container's, not the published one: the published port only exists for the
# workstation.
URL="${LAB_FAKE_INDEXER_URL:-http://fake-indexer:9117}"

if [ -z "$KEY" ]; then
	echo "No Prowlarr API key given and none in var/lab/keys/prowlarr.key; run setup-prowlarr.sh first" >&2
	exit 1
fi

say() {
	printf '  %s\n' "$1"
}

# `/ping` is the one route Prowlarr answers before it has finished starting, and the one
# that needs no key.
ready=''
for _ in $(seq 1 60); do
	ready="$(curl -sS --max-time 3 "$BASE/ping" 2>/dev/null | grep -o '"status"' || true)"
	[ -n "$ready" ] && break
	sleep 2
done

if [ -z "$ready" ]; then
	echo "$BASE answered nothing usable after two minutes" >&2
	exit 1
fi

# The indexer has to be up before the definition is posted, or Prowlarr tests it against
# nothing and reports a bad URL. Checked on the published port, which is the same process
# under the other name — the address Prowlarr uses cannot be reached from here at all, and
# a probe that needed a container on the lab network would need an image to be pulled.
if ! curl -fsS --max-time 5 "http://localhost:${LAB_FAKE_INDEXER_PORT:-9117}/api?t=caps" > /dev/null 2>&1; then
	echo "Nothing answers t=caps on localhost:${LAB_FAKE_INDEXER_PORT:-9117}; start the indexer with:" >&2
	echo "  docker compose -f docker/lab/docker-compose.yml -p ${LAB_COMPOSE_PROJECT:-media-center-sync-lab} up -d fake-indexer" >&2
	exit 1
fi

EXISTING="$(
	curl -fsS -H "X-Api-Key: $KEY" "$BASE/api/v1/indexer" \
		| python3 -c 'import json,sys
name = sys.argv[1]
print(next((str(indexer["id"]) for indexer in json.load(sys.stdin) if indexer["name"] == name), ""))' "$NAME"
)"

# Built from Prowlarr's own schema rather than from a payload written here: the field
# list of a Torznab indexer has grown twice — the seed ratio and the pack seed time are
# recent — and a hand-written body silently loses whatever it does not mention.
BODY="$(
	curl -fsS -H "X-Api-Key: $KEY" "$BASE/api/v1/indexer/schema" \
		| python3 -c 'import json,sys
name, url, existing = sys.argv[1:4]

schema = next((s for s in json.load(sys.stdin) if s.get("name") == "Generic Torznab"), None)

if schema is None:
    sys.exit("Prowlarr offers no \"Generic Torznab\" definition; it is the one this lab is built on")

values = {"baseUrl": url, "apiPath": "/api", "apiKey": "lab"}

for field in schema["fields"]:
    if field["name"] in values:
        field["value"] = values[field["name"]]

schema["name"] = name
schema["enable"] = True
# The only profile a fresh Prowlarr has, and the field is mandatory: the schema hands
# back 0, which is refused with a validation error naming a profile nobody chose.
schema["appProfileId"] = 1
schema["tags"] = []

if existing:
    schema["id"] = int(existing)

print(json.dumps(schema))' "$NAME" "$URL" "$EXISTING"
)"

# Tested before it is saved, because Prowlarr's test is the only thing that reads the
# caps and runs a search: a definition that saves cleanly and fails both is the usual way
# an indexer ends up listed, enabled and answering nothing.
if ! TEST="$(curl -sS -X POST "$BASE/api/v1/indexer/test" \
	-H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d "$BODY" -w '\n%{http_code}')"; then
	echo "Prowlarr did not answer the test call" >&2
	exit 1
fi

if [ "$(printf '%s' "$TEST" | tail -1)" != '200' ]; then
	echo "Prowlarr refused the indexer:" >&2
	printf '%s\n' "$TEST" | sed '$d' >&2
	exit 1
fi

if [ -n "$EXISTING" ]; then
	ID="$(
		curl -fsS -X PUT "$BASE/api/v1/indexer/$EXISTING" \
			-H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d "$BODY" \
			| python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
	)"
	say "updated \"$NAME\" (id $ID)"
else
	ID="$(
		curl -fsS -X POST "$BASE/api/v1/indexer" \
			-H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d "$BODY" \
			| python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
	)"
	say "added \"$NAME\" (id $ID)"
fi

# The proof, and the reason this script does not stop at "saved": a search through
# Prowlarr's own endpoint is the call the gateway makes, and the only one that exercises
# the caps mapping, the category translation and the feed parsing at once.
RESULTS="$(
	curl -fsS -H "X-Api-Key: $KEY" \
		"$BASE/api/v1/search?query=Expanse&indexerIds=$ID&type=search" \
		| python3 -c 'import json,sys
releases = json.load(sys.stdin)
print(len(releases))
for release in releases:
    print("    {} [{} seeders, {} bytes]".format(release["title"], release.get("seeders"), release.get("size")))'
)"

COUNT="$(printf '%s' "$RESULTS" | head -1)"

if [ "$COUNT" = '0' ]; then
	echo "Prowlarr accepted the indexer and its search for \"Expanse\" returned nothing." >&2
	echo "The fixture has not been seeded: run docker/lab/seed-torrents.sh." >&2
	exit 1
fi

say "a search for \"Expanse\" through $BASE/api/v1/search returns $COUNT releases:"
printf '%s\n' "$RESULTS" | tail -n +2
