#!/usr/bin/env bash
#
# Proves the lab's release chain end to end: one search through Prowlarr, the magnet it
# hands back, a real download into the directory the download settings name, and the bytes
# compared against what the seeder holds.
#
#     check-torrents.sh <prowlarr-base-url> <download-client-base-url> [release-key]
#
# This exists because every part of the chain can pass on its own while the chain is
# broken, and each of those failures has already happened here:
#
#   - the indexer answers a search and the release it offers is seeded by nobody, so the
#     grab sits at 0 % for ever;
#   - Prowlarr accepts the indexer, tests green, and drops the magnet on the way through,
#     so the gateway gets a result it cannot act on;
#   - the swarm works over a `.torrent` file and not over a magnet, which is what marking
#     the torrents private did — see `fake-indexer/make-torrents.js`;
#   - the download completes into the client's own idea of a save path and nothing ever
#     appears under `var/lab/torrents`, which is the mapping the gateway is configured
#     with.
#
# So the check goes the whole way and compares file by file, and it is the only statement
# in the lab that "the release feature has something real to run against" is worth
# anything.
#
# It leaves nothing behind. The torrent is added under a category of its own — never the
# gateway's `media-center-sync`, whose listing is something the gateway polls and a test
# may be asserting on — and both the torrent and its files are removed at the end,
# whatever the verdict. Rerunnable as often as you like, and safe to run against a lab
# somebody else is using.
set -euo pipefail

PROWLARR="${1:?usage: check-torrents.sh <prowlarr-base-url> <download-client-base-url> [release-key]}"
CLIENT="${2:?usage: check-torrents.sh <prowlarr-base-url> <download-client-base-url> [release-key]}"

# The run of three episodes under one info hash, by default, because it is the entry that
# proves the most: a magnet resolving, three files arriving, and the directory the torrent
# names being created rather than the files being flattened into the download root.
KEY="${3:-expanse-s01e01-e03-1080p}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="$ROOT/var/lab/seed/torrents/manifest.json"
CONTENT="$ROOT/var/lab/seed/content"
DOWNLOADS="$ROOT/var/lab/torrents"

NAME="${LAB_FAKE_INDEXER_NAME:-lab fake indexer}"

USERNAME="${LAB_QBITTORRENT_USER:-admin}"
PASSWORD="${LAB_QBITTORRENT_PASSWORD:-$(cat "$ROOT/var/lab/keys/qbittorrent.key" 2>/dev/null || echo lab-password)}"

CATEGORY='lab-check'
SAVE_PATH='/downloads'

# Two minutes for a few hundred kilobytes between two containers on one bridge. It is not
# a performance budget: everything that goes wrong here goes wrong by never finishing, and
# the number only decides how long a broken lab takes to say so.
TIMEOUT=120

say() {
	printf '  %s\n' "$1"
}

fail() {
	printf '\n%s\n' "$1" >&2
	exit 1
}

[ -f "$MANIFEST" ] || fail "No $MANIFEST; run docker/lab/seed-torrents.sh first."

PROWLARR_KEY="${LAB_PROWLARR_KEY:-$(cat "$ROOT/var/lab/keys/prowlarr.key" 2>/dev/null || true)}"
[ -n "$PROWLARR_KEY" ] || fail "No Prowlarr API key in var/lab/keys/prowlarr.key; run setup-prowlarr.sh first."

ENTRY="$(
	python3 -c 'import json,sys
manifest = json.load(open(sys.argv[1]))
torrent = manifest["torrents"].get(sys.argv[2])

if torrent is None:
    sys.exit("{} is not in the manifest; it holds: {}".format(sys.argv[2], ", ".join(sorted(manifest["torrents"]))))

print(torrent["infoHash"])
print(torrent["name"])
print(len(torrent["files"]))' "$MANIFEST" "$KEY"
)" || fail "$KEY is not a release this lab seeds."

HASH="$(printf '%s' "$ENTRY" | sed -n 1p)"
TORRENT_NAME="$(printf '%s' "$ENTRY" | sed -n 2p)"
FILE_COUNT="$(printf '%s' "$ENTRY" | sed -n 3p)"

printf '\nAsking Prowlarr\n'

ID="$(
	curl -fsS -H "X-Api-Key: $PROWLARR_KEY" "$PROWLARR/api/v1/indexer" \
		| python3 -c 'import json,sys
name = sys.argv[1]
print(next((str(i["id"]) for i in json.load(sys.stdin) if i["name"] == name), ""))' "$NAME"
)"

[ -n "$ID" ] || fail "Prowlarr has no indexer called \"$NAME\"; run docker/lab/fake-indexer/register-in-prowlarr.sh."

# The magnet is taken from what Prowlarr hands back, not from the manifest, and that is
# the point of going through Prowlarr at all: a magnet read out of the manifest would
# prove the swarm and skip everything in between. An empty query is deliberate too — the
# indexer answers it with the whole fixture, so this finds the release by info hash and
# does not depend on Prowlarr and the fixture agreeing about how a title is spelled.
FOUND="$(
	curl -fsS -H "X-Api-Key: $PROWLARR_KEY" \
		"$PROWLARR/api/v1/search?query=&indexerIds=$ID&type=search&limit=100" \
		| python3 -c 'import json,sys
wanted = sys.argv[1].lower()
results = json.load(sys.stdin)
release = next((r for r in results if (r.get("infoHash") or "").lower() == wanted), None)

if release is None:
    sys.exit("{} of {} results, none with info hash {}".format(len(results), len(results), wanted))

print(release.get("magnetUrl") or "")
print(release["title"])
print(release.get("size"))
print(len(results))' "$HASH"
)" || fail "Prowlarr's own search does not offer $KEY ($HASH). The indexer is registered but its feed did not come through."

MAGNET="$(printf '%s' "$FOUND" | sed -n 1p)"
TITLE="$(printf '%s' "$FOUND" | sed -n 2p)"
SIZE="$(printf '%s' "$FOUND" | sed -n 3p)"
TOTAL="$(printf '%s' "$FOUND" | sed -n 4p)"

say "$PROWLARR/api/v1/search returns $TOTAL releases from \"$NAME\""
say "$TITLE — $SIZE bytes, info hash $HASH"

# A result with no magnet is the failure this line exists to name: Prowlarr parses
# `magneturl` out of the feed and a torznab attribute it does not recognise is dropped in
# silence, so the gateway is handed a release it has no way to grab.
[ -n "$MAGNET" ] || fail "Prowlarr offers $KEY with no magnet URL; the feed's magneturl attribute did not survive."

# Prowlarr does not hand back the magnet it read. It hands back a link to itself —
# `/<indexer>/download?apikey=…&link=<the encoded original>` — which answers 301 to the
# real magnet, and it builds that link from the `Host` of the search request. So the URL a
# search made on the workstation returns says `localhost:9696`, and `localhost` inside the
# download client's container is the client itself: give it to qBittorrent unresolved and
# it fetches nothing, adds nothing and reports no error at all. That was the first way this
# check failed.
#
# Resolving it here is also the honest test of one more link in the chain: the redirect
# target is Prowlarr telling us what it understood the magnet to be, tracker included.
if [ "${MAGNET#magnet:}" = "$MAGNET" ]; then
	say "Prowlarr proxies the magnet at ${MAGNET%%\?*}?…, following it"

	RESOLVED="$(curl -sS -o /dev/null -w '%{redirect_url}' "$MAGNET" || true)"

	[ "${RESOLVED#magnet:}" != "$RESOLVED" ] \
		|| fail "Prowlarr's download link does not redirect to a magnet; it answered \"$RESOLVED\"."

	MAGNET="$RESOLVED"
fi

say "magnet $MAGNET"

login() {
	{ curl -sS -i -X POST "$CLIENT/api/v2/auth/login" -H "Referer: $CLIENT" \
		--data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" 2>/dev/null \
		| grep -i '^set-cookie:' | sed -n 's/.*\(QBT_SID_[^;]*\).*/\1/p' | head -1; } || true
}

COOKIE=''
for _ in $(seq 1 15); do
	COOKIE="$(login)"
	[ -n "$COOKIE" ] && break
	sleep 1
done

[ -n "$COOKIE" ] || fail "$CLIENT refuses $USERNAME; run docker/lab/setup-qbittorrent.sh."

# Whatever a previous run left, gone before this one starts: a torrent already in the
# client would be reported complete within a second and this would prove nothing.
curl -sS -o /dev/null -X POST "$CLIENT/api/v2/torrents/delete" \
	-H "Cookie: $COOKIE" -H "Referer: $CLIENT" \
	--data-urlencode "hashes=$HASH" --data-urlencode 'deleteFiles=true' || true

cleanup() {
	curl -sS -o /dev/null -X POST "$CLIENT/api/v2/torrents/delete" \
		-H "Cookie: $COOKIE" -H "Referer: $CLIENT" \
		--data-urlencode "hashes=$HASH" --data-urlencode 'deleteFiles=true' || true
	curl -sS -o /dev/null -X POST "$CLIENT/api/v2/torrents/removeCategories" \
		-H "Cookie: $COOKIE" -H "Referer: $CLIENT" \
		--data-urlencode "categories=$CATEGORY" || true
}

# On the way out whatever happened, including a failure: a half-downloaded torrent left in
# the client is what makes the *next* run report success on files this one fetched.
trap cleanup EXIT

curl -sS -o /dev/null -X POST "$CLIENT/api/v2/torrents/createCategory" \
	-H "Cookie: $COOKIE" -H "Referer: $CLIENT" \
	--data-urlencode "category=$CATEGORY" --data-urlencode "savePath=$SAVE_PATH" || true

# The seeder is made to announce again, and this is not belt and braces.
#
# The tracker lives inside the `fake-indexer` process and keeps its peers in memory, so
# `docker compose restart fake-indexer` — the entire edit-and-see loop for the fixture —
# empties the swarm's registry while both clients still hold every torrent at 100 %. The
# seeder then says nothing until its own announce interval comes round, which is half an
# hour, and until it does this check waits two minutes and reports `metaDL`: no peer served
# the metadata, which is true, and which reads exactly like the lab being broken.
#
# One POST removes the whole failure mode. It is aimed at the *seeding* client and it is
# best effort: a lab without one is a lab where this was going to fail anyway, and the
# message below says so better than a dead script would.
SEED_CLIENT="${LAB_QBITTORRENT_SEED_URL:-http://localhost:${LAB_QBITTORRENT_SEED_PORT:-8091}}"
SEED_COOKIE="$(
	{ curl -sS -i --max-time 5 -X POST "$SEED_CLIENT/api/v2/auth/login" -H "Referer: $SEED_CLIENT" \
		--data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" 2>/dev/null \
		| grep -i '^set-cookie:' | sed -n 's/.*\(QBT_SID_[^;]*\).*/\1/p' | head -1; } || true
)"

if [ -n "$SEED_COOKIE" ]; then
	curl -sS -o /dev/null --max-time 10 -X POST "$SEED_CLIENT/api/v2/torrents/reannounce" \
		-H "Cookie: $SEED_COOKIE" -H "Referer: $SEED_CLIENT" \
		--data-urlencode 'hashes=all' || true
	say "asked the seeder at $SEED_CLIENT to announce itself again"
fi

printf '\nHanding the magnet to %s\n' "$CLIENT"

curl -fsS -o /dev/null -X POST "$CLIENT/api/v2/torrents/add" \
	-H "Cookie: $COOKIE" -H "Referer: $CLIENT" \
	--data-urlencode "urls=$MAGNET" \
	--data-urlencode "savepath=$SAVE_PATH" \
	--data-urlencode "category=$CATEGORY" \
	--data-urlencode 'autoTMM=false' \
	|| fail "$CLIENT refused the magnet."

# The states are printed as they change, and not for decoration. `metaDL` is where a
# magnet whose metadata nobody will serve stays for ever, and it is the one failure that
# looks like slowness rather than a fault; seeing it named makes the difference between
# "the lab is slow today" and "no client in this lab can resolve a magnet".
progress='0'
state=''
last=''
for _ in $(seq 1 "$TIMEOUT"); do
	line="$(
		curl -fsS -H "Cookie: $COOKIE" "$CLIENT/api/v2/torrents/info?hashes=$HASH" \
			| python3 -c 'import json,sys
found = json.load(sys.stdin)
# `completed` rather than `downloaded`, which counts the session and is reported as 0 for a
# torrent that finished between two polls — a true number that reads as "nothing arrived".
if found:
    print("{}\t{}\t{}".format(found[0]["state"], found[0]["progress"], found[0]["completed"]))
else:
    print("gone\t0\t0")'
	)"

	state="$(printf '%s' "$line" | cut -f1)"
	progress="$(printf '%s' "$line" | cut -f2)"

	if [ "$state" != "$last" ]; then
		say "$state"
		last="$state"
	fi

	# `1` exactly: qBittorrent reports a float, and a torrent that is 0.999 is one piece
	# short of the thing this script claims to have proven.
	[ "$progress" = '1' ] && break
	sleep 1
done

if [ "$progress" != '1' ]; then
	printf '\n%s never completed: %s at %s of 1 after %s seconds.\n' "$KEY" "$state" "$progress" "$TIMEOUT" >&2

	if [ "$state" = 'metaDL' ]; then
		printf 'It is stuck on the metadata, which means no peer served it. Three causes, in the\n' >&2
		printf 'order they actually happen:\n' >&2
		printf '  - the tracker was restarted and the seeder has not announced itself since. It\n' >&2
		printf '    keeps its peers in memory, so restarting fake-indexer empties the swarm while\n' >&2
		printf '    both clients still hold every file. This run asks the seeder to announce\n' >&2
		printf '    again, so reaching here means that did not work — check that\n' >&2
		printf '    %s answers, and its tracker status for this hash;\n' "$SEED_CLIENT" >&2
		printf '  - the seeder does not hold this torrent at all (docker/lab/seed-torrents.sh);\n' >&2
		printf '  - the torrents were built with the private flag, which stops libtorrent\n' >&2
		printf '    serving metadata at all.\n' >&2
	fi

	exit 1
fi

say "complete, $(printf '%s' "$line" | cut -f3) bytes on disk"

printf '\nComparing what landed with what the seeder holds\n'

python3 -c 'import hashlib,json,os,sys

manifest, key, content, downloads = sys.argv[1:5]
torrent = json.load(open(manifest))["torrents"][key]
files = torrent["files"]

# A single-file torrent is named after its file and lands in the download root; a
# multi-file one lands in a directory of its own name. Checking that is half the point:
# a client that flattened the paths would pass every byte comparison below and still have
# put three episodes where a media server files them wrong.
prefix = "" if len(files) == 1 and files[0]["name"] == torrent["name"] else torrent["name"] + "/"

def digest(path):
    with open(path, "rb") as handle:
        return hashlib.md5(handle.read()).hexdigest()

problems = []

for entry in files:
    relative = prefix + entry["name"]
    landed = os.path.join(downloads, relative)
    seeded = os.path.join(content, relative)

    if not os.path.isfile(landed):
        problems.append("missing: {}".format(relative))
        continue

    size = os.path.getsize(landed)

    if size != entry["length"]:
        problems.append("{}: {} bytes, the torrent says {}".format(relative, size, entry["length"]))
        continue

    if digest(landed) != digest(seeded):
        problems.append("{}: {} bytes but not the same bytes the seeder holds".format(relative, size))
        continue

    print("    {}  {} bytes  md5 {}".format(relative, size, digest(landed)))

if problems:
    sys.exit("\n".join(problems))' "$MANIFEST" "$KEY" "$CONTENT" "$DOWNLOADS" \
	|| fail "The files under $DOWNLOADS are not the files the seeder holds."

printf '\n'
say "$TITLE"
say "grabbed from $PROWLARR through its own search, over a magnet, into $SAVE_PATH"
say "$FILE_COUNT file(s) under \"$TORRENT_NAME\" in $DOWNLOADS, byte for byte what the seeder holds"
say 'removed again, so the next run proves the same thing from nothing'
