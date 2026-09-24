#!/usr/bin/env bash
#
# Gives qBittorrent a password the lab knows, a category the gateway can file under,
# and proves the Web API answers with both.
#
#     setup-qbittorrent.sh <base-url>
#
# The linuxserver image sets no password on its first start. It invents one, prints it
# to the container log, and that is the only place it ever appears — the next start
# does not print it again, and a lab whose credential was in a log nobody kept is a lab
# that has to be deleted to be used. So the temporary password is read out of the log
# once, used once, and immediately replaced by one written in this file.
#
# The other route was to leave it open: qBittorrent bypasses authentication for
# whitelisted subnets, and the gateway supports exactly that — a login that sets no
# cookie means authentication is off and it carries on without one. It was rejected
# because it hides mistakes. With the bypass on, a service registered with the wrong
# credentials works from the lab machine and fails from anywhere else, and the login
# path is the code the release feature actually runs in a household. Here it is the one
# under test.
#
# Re-runnable: a qBittorrent that already accepts the lab password is left alone, and
# the category is created only when it is not already there.
set -euo pipefail

BASE="${1:?usage: setup-qbittorrent.sh <base-url>}"

# `admin` is the account qBittorrent creates itself, and renaming it buys the lab
# nothing. The password is not `lab` because qBittorrent refuses anything shorter than
# six characters, with a 200 and no message — the password simply stays what it was and
# every login afterwards fails for no visible reason.
USERNAME="${LAB_QBITTORRENT_USER:-admin}"
PASSWORD="${LAB_QBITTORRENT_PASSWORD:-lab-password}"

# The category the gateway files its grabs under, and it is not configurable there:
# `CATEGORY` in `release.manager.ts` is a constant precisely so that a client somebody
# also uses for their own downloads never has those listed, tracked or filed. Created
# here so the lab starts with the listing the gateway reads rather than with the first
# grab silently creating it.
CATEGORY='media-center-sync'

# The path both sides have to agree on: `/downloads` in the client, `var/lab/torrents`
# on this machine, one bind mount in the compose file. It is the correspondence the
# download settings ask a household for, and the lab has it real rather than asserted.
SAVE_PATH='/downloads'

PROJECT="${LAB_COMPOSE_PROJECT:-media-center-sync-lab}"
CONTAINER="${LAB_QBITTORRENT_CONTAINER:-$(docker ps -q \
	--filter "label=com.docker.compose.project=$PROJECT" \
	--filter 'label=com.docker.compose.service=qbittorrent' | head -1)}"

if [ -z "$CONTAINER" ]; then
	echo "No running qbittorrent container in the $PROJECT project; start it with 'make lab/up'" >&2
	exit 1
fi

# There are two ways in and both are shut, which has exactly one remedy worth naming.
stuck() {
	echo "$BASE refuses $USERNAME, and $1." >&2
	echo "It holds a password this lab does not know — put it in LAB_QBITTORRENT_PASSWORD," >&2
	echo "or delete var/lab/qbittorrent/config and start the container again." >&2
	exit 1
}

# A session cookie on success, nothing on failure.
#
# Which of those happened cannot be read from the status or from the body, because both
# changed: qBittorrent used to answer 200 `Ok.` and 200 `Fails.`, and now answers 204
# with an empty body and 401. The cookie is the one signal that has meant the same
# thing across every generation, so it is what this reads.
login() {
	local username="$1" password="$2"

	# qBittorrent refuses a login whose Referer is not its own address, and answers the
	# refusal exactly like a wrong password.
	# `|| true` on the whole pipeline, because a refused login is an ordinary answer
	# here and not an error: the `grep` that finds no cookie fails, `pipefail` makes the
	# pipeline fail with it, and the caller's assignment would take the entire script
	# down with `set -e` before printing a word about what happened.
	{ curl -sS -i -X POST "$BASE/api/v2/auth/login" -H "Referer: $BASE" \
		--data-urlencode "username=$username" --data-urlencode "password=$password" 2>/dev/null \
		| grep -i '^set-cookie:' | sed -n 's/.*\(QBT_SID_[^;]*\).*/\1/p' | head -1; } || true
}

# The Web UI is started by the container's init well after the container is up, and
# until it is, the port simply refuses the connection. Anything the server answers —
# including the 403 it gives an unauthenticated call — means it is listening.
code='000'
for _ in $(seq 1 90); do
	code=$(curl -sS -o /dev/null --max-time 3 -w '%{http_code}' "$BASE/api/v2/app/version" 2>/dev/null || true)
	[ "$code" != '000' ] && [ -n "$code" ] && break
	sleep 2
done

if [ "$code" = '000' ] || [ -z "$code" ]; then
	echo "$BASE answered nothing after three minutes" >&2
	exit 1
fi

cookie=$(login "$USERNAME" "$PASSWORD")

if [ -n "$cookie" ]; then
	echo "qBittorrent already signs in as $USERNAME"
else
	echo "Taking over the temporary password"

	# The last one, not the first: a container that has been recreated has printed a
	# temporary password for every start it did without a password set, and the older
	# ones are dead.
	temporary=$(docker logs "$CONTAINER" 2>&1 \
		| grep 'temporary password is provided' | tail -1 | awk '{print $NF}' || true)

	if [ -z "$temporary" ]; then
		stuck "$CONTAINER has no temporary password left in its log"
	fi

	# `admin` and not `$USERNAME`: the temporary password belongs to the account
	# qBittorrent created for itself, which is the one the log names, whatever this lab
	# renames it to on the next line.
	cookie=$(login admin "$temporary")

	if [ -z "$cookie" ]; then
		# The ordinary cause is a lab that has been set up once already under another
		# password: the log still holds the temporary one from the first start, and it
		# stopped being valid the moment a real password was written.
		stuck "the temporary password in the log of $CONTAINER was refused too"
	fi

	# Both in one call: changing the username alone would cost a second login with a
	# password that is still the throwaway one.
	curl -sS -o /dev/null -X POST "$BASE/api/v2/app/setPreferences" \
		-H "Cookie: $cookie" -H "Referer: $BASE" \
		--data-urlencode "json={\"web_ui_username\":\"$USERNAME\",\"web_ui_password\":\"$PASSWORD\"}"

	# The session dies with the password it was opened under, so everything below needs
	# a new one. It is asked for in a loop because qBittorrent writes the new credential
	# asynchronously and answers the first login or two with the old one still in force.
	cookie=''
	for _ in $(seq 1 15); do
		cookie=$(login "$USERNAME" "$PASSWORD")
		[ -n "$cookie" ] && break
		sleep 1
	done

	if [ -z "$cookie" ]; then
		echo "$BASE still refuses $USERNAME after the password was changed" >&2
		exit 1
	fi

	echo "  account: $USERNAME / $PASSWORD"
fi

# The lab stays on this machine, and this is the only thing that makes it so.
#
# The torrents are deliberately not marked private — that flag stops libtorrent from ever
# serving metadata for a magnet, so it would silently break every magnet in the lab, and
# `make-torrents.js` says so at length. Which means the lab's swarm is a public one by
# construction, and what keeps it local is here: with DHT, peer exchange and local
# discovery off, a client has no way to learn of a peer other than the tracker named in
# the torrent, and the only tracker the lab's torrents name is the lab's own indexer.
# Turn any of the three back on and this machine starts telling the public DHT what it
# holds.
#
# Queueing is off for a different reason: it is the one default that silently stops a
# transfer. Nine torrents against a default of three active slots leaves six sitting in
# `queuedDL` or `queuedUP`, which reads from the outside exactly like a client that
# accepted a grab and then did nothing with it.
curl -fsS -o /dev/null -X POST "$BASE/api/v2/app/setPreferences" \
	-H "Cookie: $cookie" -H "Referer: $BASE" \
	--data-urlencode 'json={"dht":false,"pex":false,"lsd":false,"queueing_enabled":false}'

if curl -sS -H "Cookie: $cookie" "$BASE/api/v2/torrents/categories" | grep -q "\"$CATEGORY\""; then
	echo "  category $CATEGORY already there"
else
	curl -sS -o /dev/null -X POST "$BASE/api/v2/torrents/createCategory" \
		-H "Cookie: $cookie" -H "Referer: $BASE" \
		--data-urlencode "category=$CATEGORY" --data-urlencode "savePath=$SAVE_PATH"
	echo "  category $CATEGORY -> $SAVE_PATH"
fi

# The listing the gateway reads on every poll, asked for exactly as it asks for it. A
# server that authenticated and then answers this with anything but a list is a server
# that would fail hours later, during a transfer, as an empty download queue.
if ! curl -sS -H "Cookie: $cookie" "$BASE/api/v2/torrents/info?category=$CATEGORY" | grep -q '^\['; then
	echo "$BASE signed $USERNAME in but would not list the $CATEGORY torrents" >&2
	exit 1
fi

# The password, and not a token: qBittorrent has none. This is what the gateway stores
# for this service, and what `lab/services` prints at the end of a run that has
# scrolled well past this line.
if [ -n "${LAB_KEY_FILE:-}" ]; then
	mkdir -p "$(dirname "$LAB_KEY_FILE")"
	printf '%s\n' "$PASSWORD" > "$LAB_KEY_FILE"
fi

echo
echo "  qBittorrent  $BASE"
echo "  account      $USERNAME / $PASSWORD"
echo "  category     $CATEGORY, saving into $SAVE_PATH (var/lab/torrents on this machine)"
echo "  swarm        DHT, peer exchange and local discovery off — the lab's own tracker only"
