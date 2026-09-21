#!/usr/bin/env bash
#
# Runs every journey from nothing: a stack of its own, a database that has never been
# opened, a gateway nobody has claimed, and a lab configured from scratch.
#
#     docker/ci/e2e.sh [playwright arguments]
#
# It is what `make e2e/ci` calls, and it tears down everything it created when it is
# done — containers, network, volumes and the gateway's files — whether the journeys
# passed or not. Set `E2E_CI_KEEP=1` to leave the stack standing for a look afterwards;
# the next run removes it before starting either way.
#
# What it leaves on purpose: `var/e2e-ci/results/` (traces and screenshots of failed
# journeys) and `var/e2e-ci/logs/` (what the API and the interface printed). Both are
# emptied at the start of the next run, and neither is ever shared with another run's
# output — `packages/front/test-results/` is, and two runs writing there wipe each
# other's artefacts.
#
# A script rather than a make recipe because the teardown has to run on failure as much
# as on success, and a recipe stops at the first command that fails.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# `-p` is not decoration: `.env` exports `COMPOSE_PROJECT_NAME=media-center-sync` into
# every make recipe, and it outranks `name:` in the file. Without it, the `down -v`
# below would remove the development project.
COMPOSE=(docker compose -p media-center-sync-ci -f "$ROOT/docker/ci/docker-compose.yml" --profile e2e)
RUN="$ROOT/var/e2e-ci"
STATE="$RUN/state"
LOGS="$RUN/logs"

export USER_ID="${USER_ID:-$(id -u)}"
export USER_GID="${USER_GID:-$(id -g)}"

teardown() {
	echo
	echo "== Tearing down the CI stack"
	"${COMPOSE[@]}" down -v --remove-orphans --timeout 5 >/dev/null 2>&1 || true
	rm -rf "$STATE"
}

say() {
	echo
	echo "== $*"
}

# Whatever an interrupted run left, first. A database that survived is a gateway that
# is already claimed, and the install journey would have nothing to install.
teardown
rm -rf "$RUN/results" "$LOGS"
mkdir -p "$STATE/keys" "$LOGS"

if [ "${E2E_CI_KEEP:-}" = '1' ]; then
	echo "E2E_CI_KEEP=1: the stack is left standing afterwards (docker compose -p media-center-sync-ci ...)"
else
	trap teardown EXIT
fi

say "Building the lab's media from the committed clip"
# Two libraries of one file each: all the three lab journeys need is a server that
# reports folders and, for Jellyfin, walks into one. Not the owner's `var/lab/media`,
# which holds a film placed there by hand — this directory is the run's and goes with it.
CLIP="$ROOT/docker/lab/fixtures/big-buck-bunny-30s.mp4"
mkdir -p "$STATE/lab-media/shows/Big Buck Bunny/Season 01" "$STATE/lab-media/movies/Big Buck Bunny (2008)"
cp "$CLIP" "$STATE/lab-media/shows/Big Buck Bunny/Season 01/Big Buck Bunny - S01E01.mp4"
cp "$CLIP" "$STATE/lab-media/movies/Big Buck Bunny (2008)/Big Buck Bunny (2008).mp4"
# A year and a synopsis, from files beside the media rather than from the internet: the
# correction journey needs a media that has both, and a run must not depend on a
# metadata provider answering, or on the machine being online at all.
cat > "$STATE/lab-media/movies/Big Buck Bunny (2008)/movie.nfo" <<'NFO'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
	<title>Big Buck Bunny</title>
	<year>2008</year>
	<plot>A giant rabbit takes a gentle revenge on three bullying rodents.</plot>
</movie>
NFO
cat > "$STATE/lab-media/shows/Big Buck Bunny/tvshow.nfo" <<'NFO'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
	<title>Big Buck Bunny</title>
	<year>2008</year>
	<plot>The same rabbit, filed as a show so that a season and an episode exist.</plot>
</tvshow>
NFO

say "Starting the containers"
"${COMPOSE[@]}" up -d api front jellyfin jellyfin-a jellyfin-b plex

# The image maps its `node` user onto USER_ID when the container starts, in the
# entrypoint. An `exec -u node` that gets in before that runs as the image's own 1000,
# and on a workstation whose UID is not 1000 it writes files the host cannot remove.
for _ in $(seq 1 30); do
	[ "$("${COMPOSE[@]}" exec -T api id -u node 2>/dev/null | tr -d '\r')" = "$USER_ID" ] && break
	sleep 1
done

# The volumes over `node_modules` are created by the daemon, owned by root, and the
# install runs as the host user.
"${COMPOSE[@]}" exec -T api chown "$USER_ID:$USER_GID" \
	/app/packages/shared/node_modules /app/packages/shared/dist \
	/app/packages/api/node_modules /app/packages/front/node_modules

say "Installing dependencies from the lockfiles"
"${COMPOSE[@]}" exec -T -u node api sh -c 'npm run ci:all && npm run build:shared'

say "Starting the API and the interface"
# The API from source through ts-node, not `nest start`: the watcher compiles into
# `packages/api/dist`, which is on the working tree and which a development API
# running from the same tree is serving at that moment.
#
# The schema is created by the API on start (`DB_MIGRATE_ON_START` defaults to on), and
# nothing seeds it: `npm run seed` creates an administrator, and the first
# administrator is what the install journey is there to create.
"${COMPOSE[@]}" exec -d -u node api sh -c \
	'cd /app/packages/api && exec node_modules/.bin/ts-node -r tsconfig-paths/register src/main.ts >/app/var/e2e-ci/logs/api.log 2>&1'
"${COMPOSE[@]}" exec -d -u node front sh -c \
	'cd /app/packages/front && exec node_modules/.bin/vite --host 0.0.0.0 >/app/var/e2e-ci/logs/front.log 2>&1'

# Plex by address, never by name. It refuses a request whose `Host` is a name it does
# not know — its guard against DNS rebinding — with a 401 that looks exactly like a
# missing token, even from a network it was told to trust. From the workstation that
# never shows, because there the name is `localhost`.
PLEX_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
	"$("${COMPOSE[@]}" ps -q plex)")
PLEX_URL="http://$PLEX_IP:32400"

say "Configuring the lab and waiting for the stack"
# From inside the network, with the lab's own scripts: the servers publish no port, so
# nothing here is reachable from the workstation, and nothing collides with the
# owner's lab on 8096 and 32400.
"${COMPOSE[@]}" run --rm --no-deps -T -e PLEX_URL="$PLEX_URL" e2e bash -c '
	set -euo pipefail
	LAB_KEY_FILE=/app/var/e2e-ci/state/keys/jellyfin.key /app/docker/lab/setup-jellyfin.sh \
		http://jellyfin:8096 "Shows:tvshows:/media/shows" "Movies:movies:/media/movies"
	/app/docker/lab/setup-plex.sh "$PLEX_URL" "Shows:show:/media/shows" "Movies:movie:/media/movies"
	# The dataset: the same two library names on both, which is what makes a merge.
	for server in jellyfin-a jellyfin-b; do
		LAB_KEY_FILE=/app/var/e2e-ci/state/keys/$server.key /app/docker/lab/setup-jellyfin.sh \
			http://$server:8096 "Shows:tvshows:/media/shows" "Movies:movies:/media/movies"
	done

	# Vite and ts-node compile on start. Running the journeys before they answer fails
	# the first one on a timeout, for a reason that has nothing to do with what it checks.
	ready=""
	for _ in $(seq 1 150); do
		curl -sf http://api:4200/api/health >/dev/null && curl -sf http://front:3200 >/dev/null && { ready=1; break; }
		sleep 2
	done
	if [ -z "$ready" ]; then
		echo "the API or the interface never answered:" \
			"api $(curl -s -o /dev/null -w "%{http_code}" http://api:4200/api/health)," \
			"front $(curl -s -o /dev/null -w "%{http_code}" http://front:3200); see var/e2e-ci/logs/" >&2
		exit 1
	fi

	# Every source module once, before any browser opens a page. Vuetify components are
	# imported by a plugin while a file is transformed, so Vite only discovers them as
	# pages are visited — and on a fresh install each discovery re-bundles and reloads
	# every open page. A journey whose page reloads under it stays on the screen it came
	# from, and fails as a link that leads nowhere. Transforming everything here lets
	# those reloads happen with nobody watching.
	cd /app/packages/front
	find src -name "*.vue" -o -name "*.ts" ! -name "*.spec.ts" | while read -r file; do
		curl -s -o /dev/null "http://front:3200/$file" || true
	done
	# Settled when the bundler has said nothing new for five seconds.
	last=""
	for _ in $(seq 1 60); do
		now=$(grep -c "optimized" /app/var/e2e-ci/logs/front.log || true)
		[ "$now" = "$last" ] && break
		last="$now"
		sleep 5
	done
'

for server in jellyfin jellyfin-a jellyfin-b; do
	if [ ! -s "$STATE/keys/$server.key" ]; then
		echo "the lab's $server minted no API key" >&2
		exit 1
	fi
done

# The dataset (see `data.spec.ts`): the first server is ours — the gateway reaches the
# files it serves from `/media` under the run's own copy of them — and the second is
# somebody else's, which it only reads over HTTP. The first is mapped one pair per
# library folder rather than once at `/media`, so every run registers a real server
# through a list of mappings and needs each library to find its own.
say "Running the journeys: install, then data, then journeys"
status=0
"${COMPOSE[@]}" run --rm --no-deps -T \
	-e E2E_JELLYFIN_TOKEN="$(cat "$STATE/keys/jellyfin.key")" \
	-e E2E_PLEX_URL="$PLEX_URL" \
	-e E2E_DATASET="http://jellyfin-a:8096|$(cat "$STATE/keys/jellyfin-a.key")|/media/shows=/app/var/e2e-ci/state/lab-media/shows;/media/movies=/app/var/e2e-ci/state/lab-media/movies,http://jellyfin-b:8096|$(cat "$STATE/keys/jellyfin-b.key")" \
	e2e npx playwright test "$@" || status=$?

echo
echo "Artefacts: var/e2e-ci/results/   Logs: var/e2e-ci/logs/"
exit "$status"
