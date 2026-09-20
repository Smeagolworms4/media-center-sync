#!/bin/sh
# Start the cache the deployment actually asked for, then hand over to the app.
#
# Three cases, and the point of this script is that a self-hoster gets the right one
# without choosing:
#
#   REDIS_HOST set          an external Redis or Valkey. Nothing is started here.
#   MCS_EMBEDDED_CACHE=0    no cache process at all; the app keeps its live transfer
#                           state in memory. Correct on a single node, and the
#                           smallest thing that works.
#   otherwise (the default) a Valkey of our own, on a unix socket under /data.
#
# The embedded default exists because the alternative was worse in both directions:
# requiring a Redis container turns a one-container install into a compose file, and
# defaulting to in-memory silently loses the per-worker rate accounting that makes
# multi-connection transfers behave. Valkey is three megabytes in this image.
#
# A unix socket rather than a port: nothing outside the container has any business
# reaching this cache, and a socket cannot be reached by accident from the host
# network the way a bound port can.
set -e

CACHE_SOCKET="${MCS_CACHE_SOCKET:-/data/cache.sock}"
cache_pid=""

start_embedded_cache() {
	# No persistence. What must survive a restart — per-chunk progress, the library
	# index — is in the database; this holds rates, locks and resume hints, and
	# writing those to disk would buy a few seconds of warm start in exchange for
	# constant I/O on a machine that is usually also serving video.
	valkey-server \
		--unixsocket "$CACHE_SOCKET" \
		--unixsocketperm 700 \
		--port 0 \
		--save '' \
		--appendonly no \
		--maxmemory "${MCS_CACHE_MAXMEMORY:-128mb}" \
		--maxmemory-policy allkeys-lru \
		--daemonize no \
		--logfile '' \
		--loglevel notice &
	cache_pid=$!

	# Wait for the socket rather than sleeping a fixed second: on a slow disk one
	# second is not enough, and on a fast one it is a second of every start spent
	# waiting for something that was ready immediately.
	i=0
	while [ ! -S "$CACHE_SOCKET" ]; do
		i=$((i + 1))
		if [ "$i" -gt 100 ]; then
			echo "embedded cache did not come up on $CACHE_SOCKET" >&2
			exit 1
		fi
		sleep 0.1
	done

	export REDIS_SOCKET="$CACHE_SOCKET"
	echo "cache: embedded valkey on $CACHE_SOCKET"
}

# Forward a stop to both processes. Without this the cache survives the app and
# docker waits out its full timeout on every restart.
on_term() {
	[ -n "$cache_pid" ] && kill -TERM "$cache_pid" 2>/dev/null || true
	[ -n "$app_pid" ] && kill -TERM "$app_pid" 2>/dev/null || true
}
trap on_term TERM INT

if [ -n "$REDIS_HOST" ]; then
	echo "cache: external at $REDIS_HOST:${REDIS_PORT:-6379}"
elif [ "${MCS_EMBEDDED_CACHE:-1}" = "0" ] || [ "${MCS_EMBEDDED_CACHE:-1}" = "false" ]; then
	echo "cache: in-process"
else
	start_embedded_cache
fi

"$@" &
app_pid=$!

# `wait` on the app alone: the cache is a dependency of it, not a peer. When the app
# exits, for whatever reason, this container is done, and the exit status that
# matters is the app's.
wait "$app_pid"
status=$?
on_term
exit $status
