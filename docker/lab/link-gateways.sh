#!/usr/bin/env bash
#
# Links the lab gateways to each other, and prints what each link agreed on.
#
#     link-gateways.sh <ours>=<peer-address> <theirs>=<peer-address> [<more>=<address> ...]
#
# Nothing here is special to the lab. It is exactly what the interface does: each
# gateway is told the other's fingerprint, and one of them dials. The only reason it
# is a script is that doing it by hand, in several browser tabs, is how a lab stops
# being re-created.
#
# Linking by fingerprint rather than by invitation on purpose: an invitation is
# one-shot and expiring, which is right for a human and wrong for something that has
# to be re-runnable. Both sides naming each other is what a link is, and it is the
# form that survives being run twice.
#
# **Two peers is not the shape this product has to work in.** One link is symmetric, so
# every bug that needs three gateways hides behind it: a media two peers both hold and
# which one is offered, a peer that is down while another answers, a suggestion arriving
# from one and not the other, a fingerprint that matches the wrong row because the list
# had one element in it. So the first argument is ours and every other argument is
# somebody else's, ours dials each of them, and nothing here depends on there being
# exactly two.
#
# Each argument is a URL and the address that gateway hands out on the lab's bridge,
# joined by `=`: `http://localhost:4300=gateway-local:4200`. Both halves are needed and
# neither can be derived — the first is where this script reaches it from the host, the
# second is where the *other gateways* reach it, and a lab that conflated them produced
# links that connected from here and not from each other.
set -euo pipefail

if [ "$#" -lt 2 ]; then
	echo "usage: link-gateways.sh <ours>=<peer-address> <theirs>=<peer-address> [...]" >&2
	exit 1
fi

USER_NAME="${LAB_GATEWAY_USER:-lab}"
PASSWORD="${LAB_GATEWAY_PASSWORD:-lab-password}"

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

url_of() { printf '%s' "${1%%=*}"; }
address_of() { printf '%s' "${1#*=}"; }
# The service name, which is what a person reads these lines to identify.
label_of() { printf '%s' "${1#*=}" | cut -d: -f1; }

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

# By fingerprint, never by position. A gateway whose data directory was thrown away
# comes back with a new key, the old row stays behind, and dialling whichever peer
# happened to be first in the list reaches a fingerprint nobody holds any more. With
# three gateways in the table this stops being a precaution and becomes the only thing
# that picks the right row.
peer_id_of() {
	curl -sf "$1/api/peers" -H "Authorization: Bearer $2" \
		| node -e '
			let body = "";
			process.stdin.on("data", (chunk) => (body += chunk));
			process.stdin.on("end", () => {
				const peers = JSON.parse(body || "[]");
				const match = peers.find((peer) => peer.fingerprint === process.argv[1]);
				process.stdout.write(match ? match.id : "");
			});
		' "$3"
}

report_link() {
	node -e '
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
}

OURS="$(url_of "$1")"
OURS_ADDRESS="$(address_of "$1")"
OURS_LABEL="$(label_of "$1")"
shift
THEM=("$@")

wait_for "$OURS" "$OURS_LABEL"

for entry in "${THEM[@]}"; do
	wait_for "$(url_of "$entry")" "$(label_of "$entry")"
done

OURS_TOKEN="$(sign_in "$OURS")"

if [ -z "$OURS_TOKEN" ]; then
	printf '  could not sign in to %s as %s. Has the first account been created?\n' \
		"$OURS" "$USER_NAME"
	exit 1
fi

OURS_FINGERPRINT="$(fingerprint_of "$OURS" "$OURS_TOKEN")"

printf '\n  %-15s %s\n' "$OURS_LABEL" "$OURS_FINGERPRINT"

failed=0
# Everybody's identity first, and the dialling afterwards. Interleaved, the output reads as
# though a fingerprint belonged to the link printed above it, which with three gateways is
# the one thing somebody comes to this listing to check.
declare -a TOKENS=()

for entry in "${THEM[@]}"; do
	url="$(url_of "$entry")"
	label="$(label_of "$entry")"
	token="$(sign_in "$url")"

	if [ -z "$token" ]; then
		printf '  could not sign in to %s as %s\n' "$url" "$USER_NAME"
		failed=1
		TOKENS+=('')
		continue
	fi

	TOKENS+=("$token")
	printf '  %-15s %s\n' "$label" "$(fingerprint_of "$url" "$token")"
done

for index in "${!THEM[@]}"; do
	entry="${THEM[$index]}"
	token="${TOKENS[$index]}"

	[ -z "$token" ] && continue

	url="$(url_of "$entry")"
	address="$(address_of "$entry")"
	label="$(label_of "$entry")"
	fingerprint="$(fingerprint_of "$url" "$token")"

	# Each names the other. The second one to do it settles both rows: two sides having
	# named each other is precisely what a link is.
	add_peer "$OURS" "$OURS_TOKEN" "$fingerprint" "$label" "$address" >/dev/null
	add_peer "$url" "$token" "$OURS_FINGERPRINT" "$OURS_LABEL" "$OURS_ADDRESS" >/dev/null

	peer_id="$(peer_id_of "$OURS" "$OURS_TOKEN" "$fingerprint")"

	if [ -z "$peer_id" ]; then
		printf '\n  %s: the peer row was not created; nothing to connect to\n' "$label"
		failed=1
		continue
	fi

	printf '\n  dialling %s …\n\n' "$address"

	# One peer refusing does not end the run: the rest of the lab is still worth linking,
	# and a script that stopped at the first would leave the others in a half-built state
	# that looks like a different bug.
	if ! curl -s -X POST "$OURS/api/peers/$peer_id/connect" \
		-H "Authorization: Bearer $OURS_TOKEN" | report_link; then
		failed=1
	fi
done

printf '\n  %s now holds a live link to each of the others, on the port they serve their\n' \
	"$OURS_LABEL"
printf '  interface on. There is no second port anywhere in this: it is a WebSocket\n'
printf '  upgrade on /api/peer/link. `make lab/pull` moves a file across one.\n\n'

exit "$failed"
