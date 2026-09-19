#!/usr/bin/env bash
#
# Prints what somebody needs to register the four lab services in the gateways, and
# what the two lab gateways are.
#
#     print-services.sh <keys-directory>
#
# This is a separate step, and printed once at the end, because the two Jellyfin keys
# are minted in the middle of two setup runs that between them print some sixty lines.
# Reading a key off a screen that has scrolled is how a lab gets registered wrong, and
# a service registered with the wrong key looks exactly like a service that is down.
#
# Which of the four is local and which is remote is the one thing no container knows:
# it is a decision made at registration, and the reason the lab has four servers at
# all. Local means the gateway may write into that library — so it is a pull target;
# remote means it may only read, and is a source.
set -euo pipefail

KEYS="${1:?usage: print-services.sh <keys-directory>}"

key_of() {
	local file="$KEYS/$1.key"
	[ -f "$file" ] && cat "$file" || printf '<Dashboard, API keys>'
}

printf '\n'
printf '  %-16s %-34s %-8s %s\n' 'SERVICE' 'URL' 'SCOPE' 'CREDENTIAL'
printf '  %-16s %-34s %-8s %s\n' \
	'jellyfin-local' "http://localhost:${LAB_JELLYFIN_PORT:-8096}" 'local' "$(key_of jellyfin-local)"
printf '  %-16s %-34s %-8s %s\n' \
	'plex-local' "http://localhost:${LAB_PLEX_PORT:-32400}" 'local' 'none (unclaimed)'
printf '  %-16s %-34s %-8s %s\n' \
	'jellyfin-remote' "http://localhost:${LAB_JELLYFIN_REMOTE_PORT:-8097}" 'remote' "$(key_of jellyfin-remote)"
printf '  %-16s %-34s %-8s %s\n' \
	'plex-remote' "http://localhost:${LAB_PLEX_REMOTE_PORT:-32401}" 'remote' 'none (unclaimed)'
printf '\n'
printf '  Both Jellyfin servers sign in as %s / %s; the key above is the one to store.\n' \
	"${LAB_JELLYFIN_USER:-lab}" "${LAB_JELLYFIN_PASSWORD:-lab}"
printf '\n'
printf '  Register the first two as local: they are ours, and the gateway may write into\n'
printf '  them — which makes them the only possible targets of a pull. Register the last\n'
printf '  two as remote: they are a friend'"'"'s, they are read-only, and they are where the\n'
printf '  season nobody local holds and the film we do not have come from.\n'
printf '\n'
printf '  Libraries: Shows/Movies on both of ours, Séries/Films on jellyfin-remote,\n'
printf '  TV/Movies on plex-remote. Same name, one category — so Shows folds two and\n'
printf '  Movies folds three, while Séries, TV and Films stand alone although all three\n'
printf '  mean the same thing. That is the merge and its limit, in one screen.\n'
printf '\n'

printf '  %-16s %-34s %s\n' 'GATEWAY' 'URL' 'WHOSE'
printf '  %-16s %-34s %s\n' \
	'gateway-local' "http://localhost:${LAB_GATEWAY_PORT:-4300}" 'yours'
printf '  %-16s %-34s %s\n' \
	'gateway-remote' "http://localhost:${LAB_GATEWAY_REMOTE_PORT:-4301}" "a friend’s"
printf '\n'
printf '  Both sign in as %s / %s, created on first start.\n' \
	"${LAB_GATEWAY_USER:-lab}" "${LAB_GATEWAY_PASSWORD:-lab-password}"
printf '\n'
printf "  Two gateways rather than one, because peer exchange cannot be proven against\n"
printf "  a single node: a link, a protocol handshake and a pull between two households\n"
printf "  need two of everything — two identities, two databases, two media servers.\n"
printf '\n'
printf "  make lab/link    each names the other by fingerprint, one of them dials, and\n"
printf "                   it prints the version and the capabilities they agreed on\n"
printf "  make lab/pull    reads the friend’s catalogue over that link and pulls a\n"
printf "                   range of one file across it\n"
printf '\n'
printf "  They link on the port they serve their interface on — a WebSocket upgrade on\n"
printf "  /api/peer/link. There is no second port anywhere in this application.\n"
printf '\n'
printf "  Register jellyfin-remote in gateway-remote as its own local service and share\n"
printf "  its libraries: a gateway with nothing of its own has nothing to answer a\n"
printf "  catalogue with. Inside the lab the two reach each other by service name —\n"
printf "  http://jellyfin-remote:8096 — and never through localhost.\n"
printf '\n'
