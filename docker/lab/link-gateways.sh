#!/usr/bin/env bash
#
# Links the two lab gateways to each other, and prints what the link agreed on.
#
#     link-gateways.sh <ours> <theirs>
#
# Nothing here is special to the lab. It is exactly what the interface does: each
# gateway is told the other's fingerprint, and one of them dials. The only reason it
# is a script is that doing it by hand twice, in two browser tabs, is how a lab stops
# being re-created.
#
# Linking by fingerprint rather than by invitation on purpose: an invitation is
# one-shot and expiring, which is right for a human and wrong for something that has
# to be re-runnable. Both sides naming each other is what a link is, and it is the
# form that survives being run twice.
set -euo pipefail

OURS="${1:?usage: link-gateways.sh <ours> <theirs>}"
THEIRS="${2:?usage: link-gateways.sh <ours> <theirs>}"

USER_NAME="${LAB_GATEWAY_USER:-lab}"
PASSWORD="${LAB_GATEWAY_PASSWORD:-lab-password}"

# Both gateways answer on the same port they serve the interface on, and a peer link
# is a WebSocket upgrade on it. These are the addresses they hand each other; they are
# service names because that is what resolves on the lab's bridge.
OURS_PEER_ADDRESS="${LAB_GATEWAY_ADDRESS:-gateway-local:4200}"
THEIRS_PEER_ADDRESS="${LAB_GATEWAY_REMOTE_ADDRESS:-gateway-remote:4200}"

json() {
	# `jq` is not assumed: a lab that needs a package installed before it runs is a
	# lab that gets run once.
	node -e '
		let body = "";
		process.stdin.on("data", (chunk) => (body += chunk));
		process.stdin.on("end", () => {
			try {
				const value = process.argv[1].split(".").reduce((a, k) => a?.[k], JSON.parse(body));
				process.stdout.write(value === undefined || value === null ? "" : String(value));
			} catch {
				process.stdout.write("");
			}
		});
	' "$1"
}

wait_for() {
	local url="$1" name="$2" attempt=0

	printf '  waiting for %s' "$name"

	until curl -sf "$url/api/health" >/dev/null 2>&1; do
		attempt=$((attempt + 1))

		if [ "$attempt" -gt 120 ]; then
			printf '\n  %s never answered at %s\n' "$name" "$url"
			exit 1
		fi

		printf '.'
		sleep 2
	done

	printf ' up\n'
}

sign_in() {
	curl -sf -X POST "$1/api/auth/login" \
		-H 'Content-Type: application/json' \
		-d "{\"provider\":\"internal\",\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}" \
		| json accessToken
}

fingerprint_of() {
	curl -sf "$1/api/peers/identity" -H "Authorization: Bearer $2" | json fingerprint
}

# Idempotent: adding a peer that already exists updates the row it finds rather than
# creating a second one, so this target can be run again after a restart.
add_peer() {
	curl -s -X POST "$1/api/peers" \
		-H "Authorization: Bearer $2" \
		-H 'Content-Type: application/json' \
		-d "{\"fingerprint\":\"$3\",\"name\":\"$4\",\"address\":\"$5\"}"
}

wait_for "$OURS" 'gateway-local'
wait_for "$THEIRS" 'gateway-remote'

OURS_TOKEN="$(sign_in "$OURS")"
THEIRS_TOKEN="$(sign_in "$THEIRS")"

if [ -z "$OURS_TOKEN" ] || [ -z "$THEIRS_TOKEN" ]; then
	printf '  could not sign in as %s. Has the first account been created?\n' "$USER_NAME"
	exit 1
fi

OURS_FINGERPRINT="$(fingerprint_of "$OURS" "$OURS_TOKEN")"
THEIRS_FINGERPRINT="$(fingerprint_of "$THEIRS" "$THEIRS_TOKEN")"

printf '\n  gateway-local   %s\n' "$OURS_FINGERPRINT"
printf '  gateway-remote  %s\n\n' "$THEIRS_FINGERPRINT"

# Each names the other. The second one to do it settles both rows: two sides having
# named each other is precisely what a link is.
add_peer "$OURS" "$OURS_TOKEN" "$THEIRS_FINGERPRINT" 'Lab friend' "$THEIRS_PEER_ADDRESS" >/dev/null
add_peer "$THEIRS" "$THEIRS_TOKEN" "$OURS_FINGERPRINT" 'Lab us' "$OURS_PEER_ADDRESS" >/dev/null

# By fingerprint, never by position. A gateway whose data directory was thrown away
# comes back with a new key, the old row stays behind, and dialling whichever peer
# happened to be first in the list reaches a fingerprint nobody holds any more.
PEER_ID="$(curl -sf "$OURS/api/peers" -H "Authorization: Bearer $OURS_TOKEN" \
	| node -e '
		let body = "";
		process.stdin.on("data", (chunk) => (body += chunk));
		process.stdin.on("end", () => {
			const peers = JSON.parse(body || "[]");
			const match = peers.find((peer) => peer.fingerprint === process.argv[1]);
			process.stdout.write(match ? match.id : "");
		});
	' "$THEIRS_FINGERPRINT")"

if [ -z "$PEER_ID" ]; then
	printf '  the peer row was not created; nothing to connect to\n'
	exit 1
fi

printf '  dialling %s …\n\n' "$THEIRS_PEER_ADDRESS"
curl -s -X POST "$OURS/api/peers/$PEER_ID/connect" -H "Authorization: Bearer $OURS_TOKEN" \
	| node -e '
		let body = "";
		process.stdin.on("data", (chunk) => (body += chunk));
		process.stdin.on("end", () => {
			const peer = JSON.parse(body || "{}");

			// A refusal answers a key, not a peer. Printing the row anyway would show
			// six question marks and hide the one line that says what went wrong.
			if (peer.status === undefined) {
				process.stdout.write(`  the link was refused: ${peer.message ?? peer.key ?? body}\n`);
				process.exitCode = 1;

				return;
			}

			process.stdout.write(
				[
					`  name          ${peer.name ?? "?"}`,
					`  status        ${peer.status ?? "?"}`,
					`  link          ${peer.linkMode ?? "none"} at ${peer.address ?? "?"}`,
					`  protocol      ${peer.protocol ?? "not negotiated"}`,
					`  capabilities  ${(peer.capabilities ?? []).join(", ") || "none advertised"}`,
					"",
				].join("\n"),
			);
		});
	'

printf '\n  Both gateways now hold a live link on the port they serve their interface on.\n'
printf '  There is no second port anywhere in this: it is a WebSocket upgrade on\n'
printf '  /api/peer/link. `make lab/pull` moves a file across it.\n\n'
