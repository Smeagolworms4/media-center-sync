#!/usr/bin/env bash
#
# Builds the lab's torrents and starts seeding them, so that a grab in the lab is a real
# download.
#
#     seed-torrents.sh <seeder-base-url>
#
# Up to here the lab could prove that a search returns something and that a client
# accepts a magnet. It could not prove the part that actually breaks — bytes arriving,
# under the file names the release claimed, into the directory the download settings say
# they land in. That needs three things this script arranges: content named the way the
# releases are named, `.torrent` files over it, and a client that holds those files and
# answers requests for them.
#
# What it does, in order: lays out `var/lab/seed/content` from the generated media under
# the release names in `fake-indexer/releases.js`, writes one `.torrent` per release plus
# the manifest the indexer answers searches from, then hands every torrent to
# `qbittorrent-seed` and waits until that client reports each of them complete. It prints
# the magnets at the end, which are what a hand test needs and what nothing else prints.
#
# Nothing leaves this machine. The tracker is the lab's own `fake-indexer`, the peers are
# two containers on one bridge, and both clients have DHT, peer exchange and local
# discovery switched off by `setup-qbittorrent.sh` — which is the part that matters, since
# with all three off the tracker written into the torrents is the only way either client
# can learn that a peer exists at all. Marking the torrents private would say the same
# thing more strongly and is not done: it stops libtorrent serving metadata for a magnet,
# and `fake-indexer/make-torrents.js` explains what that costs.
#
# The building runs in a container, like everything else here: the script would work with
# the workstation's `node`, and then the lab would depend on which one that is.
#
# Re-runnable, twice over: content already in place is left alone — rewriting a file a
# seeder is reading from turns a complete torrent into "missing files" with no explanation
# — and a torrent the client already holds is not added again. The info hashes are stable
# across runs by construction, so re-running does not invalidate a magnet anybody wrote
# down.
set -euo pipefail

BASE="${1:?usage: seed-torrents.sh <seeder-base-url>}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEDIA="$ROOT/var/lab/media"
CONTENT="$ROOT/var/lab/seed/content"
TORRENTS="$ROOT/var/lab/seed/torrents"

USERNAME="${LAB_QBITTORRENT_USER:-admin}"
PASSWORD="${LAB_QBITTORRENT_PASSWORD:-lab-password}"

# The seeder's own category, and not the gateway's `media-center-sync`: the two clients
# are read by different things, and a shared name would make a listing of the gateway's
# grabs include nine torrents it never asked for.
CATEGORY='lab-seed'
SAVE_PATH='/content'

# Fixed, because the tracker hands other peers whatever port the client announced. A
# client left on "random port" announces a different one after every restart, which is
# fine — and then the downloader, which caches the peer list, dials the old one.
LISTEN_PORT="${LAB_SEED_LISTEN_PORT:-6881}"

# The image the compose file already runs the indexer with, so this pulls nothing.
IMAGE='node:24-alpine'

PROJECT="${LAB_COMPOSE_PROJECT:-media-center-sync-lab}"

say() {
	printf '  %s\n' "$1"
}

if [ ! -d "$MEDIA/library-b" ]; then
	echo "$MEDIA holds no libraries; run seed-media.sh first — the torrents are made of that media" >&2
	exit 1
fi

CONTAINER="${LAB_QBITTORRENT_SEED_CONTAINER:-$(docker ps -q \
	--filter "label=com.docker.compose.project=$PROJECT" \
	--filter 'label=com.docker.compose.service=qbittorrent-seed' | head -1)}"

if [ -z "$CONTAINER" ]; then
	echo "No running qbittorrent-seed container in the $PROJECT project." >&2
	echo "Start it and the indexer with:" >&2
	echo "  docker compose -f docker/lab/docker-compose.yml -p $PROJECT up -d fake-indexer qbittorrent-seed" >&2
	exit 1
fi

mkdir -p "$CONTENT" "$TORRENTS"

printf '\nBuilding the torrents\n'

# `LAB_TRACKER_ANNOUNCE` is passed through empty when it is unset, and that is not a bug:
# the default belongs in `make-torrents.js`, which is also what the compose file's port
# has to agree with, and an empty string leaves it in charge.
docker run --rm \
	--user "$(id -u):$(id -g)" \
	-v "$ROOT:/app" \
	-w /app/docker/lab/fake-indexer \
	-e LAB_TRACKER_ANNOUNCE="${LAB_TRACKER_ANNOUNCE:-}" \
	"$IMAGE" node make-torrents.js /app/var/lab/media /app/var/lab/seed/content /app/var/lab/seed/torrents

# The seeder is a qBittorrent like the other one, so it has the same first-start problem:
# a password invented at random and printed once into a log. `setup-qbittorrent.sh` is
# what solves that, and it takes the container to look at from the environment precisely
# so that a second client can be set up with it. Calling it rather than repeating it
# keeps one implementation of the login dance in the lab; the cost is a
# `media-center-sync` category created on a client that has no `/downloads`, which is
# unused and harmless.
#
# LAB_KEY_FILE is cleared on purpose: this password is the seeder's, and the file the
# caller may have set is where the gateway reads the *download client's* credential from.
printf '\nSetting the seeder up\n'
LAB_KEY_FILE='' \
	LAB_QBITTORRENT_CONTAINER="$CONTAINER" \
	LAB_QBITTORRENT_USER="$USERNAME" \
	LAB_QBITTORRENT_PASSWORD="$PASSWORD" \
	"$(dirname "${BASH_SOURCE[0]}")/setup-qbittorrent.sh" "$BASE" > /dev/null

login() {
	{ curl -sS -i -X POST "$BASE/api/v2/auth/login" -H "Referer: $BASE" \
		--data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" 2>/dev/null \
		| grep -i '^set-cookie:' | sed -n 's/.*\(QBT_SID_[^;]*\).*/\1/p' | head -1; } || true
}

COOKIE=''
for _ in $(seq 1 15); do
	COOKIE="$(login)"
	[ -n "$COOKIE" ] && break
	sleep 1
done

if [ -z "$COOKIE" ]; then
	echo "$BASE refuses $USERNAME although the setup script reported success" >&2
	exit 1
fi

# What is left to set once the shared setup has run, and both of these are about the
# swarm still being there an hour later. The offline switches and the queue are not here:
# they belong to every client in the lab and `setup-qbittorrent.sh`, called just above,
# is what sets them.
#
# The share limits are off for the same reason a run later in the afternoon should behave
# like the first one: a ratio limit reached is a torrent paused, and a paused seeder looks
# exactly like a tracker that lost it.
curl -fsS -o /dev/null -X POST "$BASE/api/v2/app/setPreferences" \
	-H "Cookie: $COOKIE" -H "Referer: $BASE" \
	--data-urlencode "json={\"random_port\":false,\"listen_port\":$LISTEN_PORT,\"max_ratio_enabled\":false,\"max_seeding_time_enabled\":false}"

# Not `-f`, and the output dropped: qBittorrent answers 409 for a category that is
# already there, which is the ordinary case on every run after the first.
curl -sS -o /dev/null -X POST "$BASE/api/v2/torrents/createCategory" \
	-H "Cookie: $COOKIE" -H "Referer: $BASE" \
	--data-urlencode "category=$CATEGORY" --data-urlencode "savePath=$SAVE_PATH" || true

ANNOUNCE="$(
	python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["announce"])' "$TORRENTS/manifest.json"
)"

ENTRIES="$(
	python3 -c 'import json,sys
manifest = json.load(open(sys.argv[1]))
for key, torrent in sorted(manifest["torrents"].items()):
    print("\t".join([key, torrent["infoHash"], str(torrent["length"]), str(len(torrent["files"])), torrent["name"]]))' \
		"$TORRENTS/manifest.json"
)"

held() {
	curl -fsS -H "Cookie: $COOKIE" "$BASE/api/v2/torrents/info" \
		| python3 -c 'import json,sys
print(" ".join(torrent["hash"].lower() for torrent in json.load(sys.stdin)))'
}

HELD="$(held)"

WANTED="$(printf '%s\n' "$ENTRIES" | cut -f2 | tr '\n' ' ')"

# Anything in the seeder's own category that the manifest no longer names, dropped before
# the new ones go in.
#
# This is not tidying. An info hash is the hash of the fixture's content and layout, so
# every edit to `releases.js` — a renamed release, one more episode in a pack — gives that
# torrent a new identity, and the client is left holding the old one as well. It is still
# complete, it still announces, and it seeds something no search offers: the swarm looks
# healthy while the release somebody is testing has no seeder at all. Only this category,
# and `deleteFiles=false`, because the files under `/content` back both the old torrent and
# the new one.
STALE="$(
	curl -fsS -H "Cookie: $COOKIE" "$BASE/api/v2/torrents/info?category=$CATEGORY" \
		| python3 -c 'import json,sys
wanted = set(sys.argv[1].split())
print("|".join(t["hash"] for t in json.load(sys.stdin) if t["hash"].lower() not in wanted))' "$WANTED"
)"

if [ -n "$STALE" ]; then
	curl -fsS -o /dev/null -X POST "$BASE/api/v2/torrents/delete" \
		-H "Cookie: $COOKIE" -H "Referer: $BASE" \
		--data-urlencode "hashes=$STALE" --data-urlencode 'deleteFiles=false'
	say "dropped $(printf '%s\n' "$STALE" | tr '|' '\n' | wc -l | tr -d ' ') torrent(s) the fixture no longer describes"
	HELD="$(held)"
fi

printf '\nHanding them to the seeder\n'

while IFS=$'\t' read -r key hash size count name; do
	if [ -n "$key" ] && printf '%s' " $HELD " | grep -q " $hash "; then
		say "$key already there"
		continue
	fi

	# `skip_checking` is left alone, so the client hashes the files it was pointed at
	# before it claims to have them. It is the only check anywhere that the content laid
	# out under the release names is the content the torrent describes — skip it and a
	# mismatch shows up much later, as a download that stalls with no error on either
	# side.
	curl -fsS -o /dev/null -X POST "$BASE/api/v2/torrents/add" \
		-H "Cookie: $COOKIE" -H "Referer: $BASE" \
		-F "torrents=@$TORRENTS/$key.torrent" \
		-F "savepath=$SAVE_PATH" \
		-F "category=$CATEGORY" \
		-F 'autoTMM=false'

	say "added $key"
done <<< "$ENTRIES"

# Complete, not merely added. A torrent whose content is one byte off is added happily,
# reports 99.9 % and is never announced as a seed; the difference only becomes visible on
# the other side, as a download that gets most of the way and stops.
missing=''
for _ in $(seq 1 60); do
	missing="$(
		curl -fsS -H "Cookie: $COOKIE" "$BASE/api/v2/torrents/info?category=$CATEGORY" \
			| python3 -c 'import json,sys
wanted = set(sys.argv[1].split())
complete = {t["hash"].lower() for t in json.load(sys.stdin) if t["progress"] >= 1}
print(" ".join(sorted(wanted - complete)))' "$WANTED"
	)"

	[ -z "$missing" ] && break
	sleep 1
done

if [ -n "$missing" ]; then
	echo "The seeder never reported these complete: $missing" >&2
	echo "Their content under $CONTENT does not match the torrent that describes it." >&2
	exit 1
fi

printf '\n'
say "Seeder   $BASE  ($USERNAME / $PASSWORD)"
say "Content  $CONTENT, as $SAVE_PATH in the client"
say "Tracker  $ANNOUNCE"
printf '\n'

while IFS=$'\t' read -r key hash size count name; do
	[ -z "$key" ] && continue
	printf '  %s\n' "$name"
	printf '    %s bytes in %s file(s), seeding\n' "$size" "$count"
	printf '    magnet:?xt=urn:btih:%s&dn=%s&tr=%s\n' \
		"$hash" \
		"$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$name")" \
		"$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ANNOUNCE")"
done <<< "$ENTRIES"

printf '\n'
say "The indexer offers all of them at http://localhost:${LAB_FAKE_INDEXER_PORT:-9117}/api?t=search"
say "and lists the magnets in plain text at http://localhost:${LAB_FAKE_INDEXER_PORT:-9117}/"
