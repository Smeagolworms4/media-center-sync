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

# The release side of the lab, printed last because it shares nothing with the four media
# servers: no test that correlates libraries knows any of this exists. It is here because
# the addresses and the two credentials are what a hand test needs, and the alternative is
# reading them back out of `docker compose ps` and a key file.
printf '  %-16s %-34s %s\n' 'RELEASES' 'URL' 'WHAT IT IS'
printf '  %-16s %-34s %s\n' \
	'prowlarr' "http://localhost:${LAB_PROWLARR_PORT:-9696}" 'the indexer the gateway searches'
printf '  %-16s %-34s %s\n' \
	'fake-indexer' "http://localhost:${LAB_FAKE_INDEXER_PORT:-9117}" 'the fixture it searches, and the tracker'
printf '  %-16s %-34s %s\n' \
	'fake-indexer (2)' "http://localhost:${LAB_FAKE_INDEXER_MIRROR_PORT:-9118}" 'the same fixture at a second address'
printf '  %-16s %-34s %s\n' \
	'qbittorrent' "http://localhost:${LAB_QBITTORRENT_PORT:-8090}" 'the client the gateway drives'
printf '  %-16s %-34s %s\n' \
	'qbittorrent-seed' "http://localhost:${LAB_QBITTORRENT_SEED_PORT:-8091}" 'the client that holds the files'
printf '\n'

# Seerr in its own block, and not under RELEASES, because it belongs to neither half: it
# is not a media server and it is not a place bytes come from. It is where the household
# asks, which is a third kind of thing entirely, and filing it with the trackers is how
# somebody ends up expecting it to download something.
printf '  %-16s %-34s %s\n' 'REQUESTS' 'URL' 'WHAT IT IS'
printf '  %-16s %-34s %s\n' \
	'seerr' "http://localhost:${LAB_SEERR_PORT:-5055}" 'where the household asks for things'
printf '\n'

if [ -f "$KEYS/prowlarr.key" ]; then
	printf '  Prowlarr API key  %s\n' "$(cat "$KEYS/prowlarr.key")"
fi

if [ -f "$KEYS/seerr.key" ]; then
	printf '  Seerr API key     %s\n' "$(cat "$KEYS/seerr.key")"
	printf '  Seerr sign-in     %s / %s, through Jellyfin\n' \
		"${LAB_JELLYFIN_USER:-lab}" "${LAB_JELLYFIN_PASSWORD:-lab}"
	printf '  Two asks are open and neither carries a title, which is what the gateway has\n'
	printf '  to work around: a request row is identifiers and statuses, so the work is\n'
	printf '  looked up separately to have anything to show or to search with.\n'
fi

printf '  Both clients sign in as %s / %s.\n' \
	"${LAB_QBITTORRENT_USER:-admin}" "${LAB_QBITTORRENT_PASSWORD:-lab-password}"
printf '\n'
printf '  There are two trackers on purpose: the same nine releases at two addresses, which\n'
printf '  is what makes one row say "on 2 trackers" with a copy to choose between. Two\n'
printf '  indexers pointed at one address would not do it — Prowlarr deduplicates on the\n'
printf '  guid, which is built from the address, and folds them back into one.\n'
printf '\n'
printf '  The indexer answers a fixed fixture of nine releases — the names the parser has\n'
printf '  to get right, from three qualities of one episode to a complete series in\n'
printf '  subdirectories — and every one of them is a real torrent that qbittorrent-seed\n'
printf '  is really seeding to qbittorrent over the tracker in the same process. Nothing\n'
printf '  reaches the internet: those torrents name no other tracker, and DHT, peer\n'
printf '  exchange and local discovery are off in both clients.\n'
printf '\n'
printf '  make lab/torrents        builds the torrents, starts the seeding, puts the\n'
printf '                           indexer in Prowlarr and searches it once to prove it\n'
printf '  make lab/torrents-check  searches Prowlarr, grabs a magnet, downloads it and\n'
printf '                           compares the bytes with what the seeder holds\n'
printf '\n'
printf '  Downloads land in %s, which is /downloads in the client:\n' 'var/lab/torrents'
printf '  that correspondence is the one the download settings ask a household for, and\n'
printf '  it is real here rather than asserted.\n'
printf '\n'
