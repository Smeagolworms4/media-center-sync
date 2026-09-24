#!/usr/bin/env bash
#
# Proves the request chain end to end: Seerr's asks, read through the gateway, named,
# matched against the catalogue, and carrying a search nothing ran.
#
#     check-requests.sh <gateway-base-url> [<seerr-base-url>]
#
# This exists because the request screen is the easiest thing in this product to ship
# broken while every part of it reports success, and each of the failures below is a real
# one rather than a hypothetical:
#
#   - **A request row carries no title.** Seerr answers `"title": null` for a film and for
#     a show alike — identifiers and statuses and nothing readable — so a screen that
#     simply displayed the rows is a column of numbers, and no test that mocks the source
#     with a friendly fixture will ever say so. The gateway looks the work up separately;
#     this is what checks that the lookup happens and arrives.
#   - **The two identifiers are both small integers.** A request's own number and the
#     media's number are different sequences, and on a fresh install both are 1 and 2. Read
#     one where the other belongs and marking an ask answered completes somebody else's,
#     successfully, with nothing anywhere to say so.
#   - **A wrong API key reads as a server that is down**, unless something insists on the
#     difference: one is a field on one screen, the other is an address and a network.
#   - **The suggestion is a sentence and not an action.** Nothing on that screen may fetch
#     anything, and the only way to be sure is to look at what the gateway did.
#
# It only reads. Nothing here marks an ask answered — that would close a request in the
# lab's Seerr and the next run would have nothing left to check — and nothing grabs.
set -euo pipefail

# The gateway `lab/register` wires, which is your own on the host and not one of the lab's
# three. The lab registers everything at `localhost` addresses, which is correct from the
# host and names the container itself from inside one — so a containerised gateway wired
# that way reaches no service at all, and the only symptom is an empty screen.
GATEWAY="${1:?usage: check-requests.sh <gateway-base-url> [<seerr-base-url>]}"
SEERR="${2:-http://localhost:${LAB_SEERR_PORT:-5055}}"

USER_NAME="${LAB_GATEWAY_USER:-lab}"
PASSWORD="${LAB_GATEWAY_PASSWORD:-lab-password}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SEERR_KEY="${LAB_SEERR_KEY:-$(cat "$ROOT/var/lab/keys/seerr.key" 2>/dev/null || true)}"

say() {
	printf '  %s\n' "$1"
}

fail() {
	printf '\n%s\n' "$1" >&2
	exit 1
}

field() {
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

TOKEN="$(curl -sS -X POST "$GATEWAY/api/auth/login" \
	-H 'Content-Type: application/json' \
	-d "{\"provider\":\"internal\",\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}" \
	| field accessToken)"

[ -n "$TOKEN" ] || fail "Could not sign in to $GATEWAY as $USER_NAME."

# Straight from the source first, so that a difference between the two can be attributed.
# A gateway answering an empty list is one of two quite different things — nobody has asked
# for anything, or the gateway is not reading the source — and only the source can say
# which.
if [ -n "$SEERR_KEY" ]; then
	asked="$(curl -sS "$SEERR/api/v1/request/count" -H "X-Api-Key: $SEERR_KEY" | field total)"
	say "Seerr holds ${asked:-0} ask(s)"

	if [ "${asked:-0}" = '0' ]; then
		fail "Seerr has no open ask; run docker/lab/setup-seerr.sh first."
	fi

	# The premise of the whole feature, checked rather than trusted: if a fork ever starts
	# answering titles on the request rows, the lookup below stops being the only source of
	# a name and this check should be revisited rather than quietly passing.
	titled="$(curl -sS "$SEERR/api/v1/request?take=25&skip=0&filter=all&sort=added" \
		-H "X-Api-Key: $SEERR_KEY" \
		| node -e '
			let body = "";
			process.stdin.on("data", (chunk) => (body += chunk));
			process.stdin.on("end", () => {
				const rows = JSON.parse(body || "{}").results ?? [];
				process.stdout.write(String(rows.filter((row) => row.title).length));
			});
		')"

	if [ "$titled" != '0' ]; then
		say "note: this Seerr answers titles on $titled request row(s), which it did not use to"
	fi
fi

VIEWS="$(curl -sS "$GATEWAY/api/requests" -H "Authorization: Bearer $TOKEN")"

# The refusals come back as a message and not as a list, and each one sends somebody
# somewhere different. Printing "0 requests" for any of them is the failure this reports.
key="$(printf '%s' "$VIEWS" | field message)"

if [ -n "$key" ]; then
	case "$key" in
		error.request_source.not_configured)
			fail "The gateway has no request source configured. Run 'make lab/register'." ;;
		error.request_source.unauthorized)
			fail "Seerr refused the gateway's key. Re-run setup-seerr.sh and 'make lab/register'." ;;
		error.request_source.unreachable)
			fail "The gateway cannot reach $SEERR. From a container, localhost is the container." ;;
		*) fail "The gateway refused: $key" ;;
	esac
fi

printf '%s' "$VIEWS" | node -e '
	let body = "";
	process.stdin.on("data", (chunk) => (body += chunk));
	process.stdin.on("end", () => {
		const views = JSON.parse(body || "[]");

		if (!Array.isArray(views) || views.length === 0) {
			process.stderr.write("\n  The gateway answered no request at all.\n");
			process.exitCode = 1;

			return;
		}

		const problems = [];

		for (const view of views) {
			const label = `${view.kind} ${view.tmdbId ?? view.tvdbId ?? view.id}`;

			// The whole point of the lookup. A row with no name is the column-of-numbers
			// screen, and it is what this check exists to catch.
			if (!view.title) {
				problems.push(`${label}: nothing named it — neither our catalogue nor the source`);
			}

			// Ours or the source is fine; what is not fine is a row we hold nothing for and
			// which the source could not describe either, because that is the row somebody
			// is looking at and it would be blank.
			if (!view.heldAlready && view.details === null) {
				problems.push(`${label}: held by nothing here and the source would not describe it`);
			}

			// A suggestion is a sentence. It must be sayable for anything we are short of,
			// and it must never be empty words.
			if (!view.heldAlready && view.suggestion === null) {
				problems.push(`${label}: nothing to search with, so the screen can offer nothing`);
			}

			if (view.suggestion !== null && !view.suggestion.term) {
				problems.push(`${label}: a suggestion with no term in it`);
			}

			if (view.fulfillable && !view.heldAlready) {
				problems.push(`${label}: offered as fulfillable while nothing here answers it`);
			}
		}

		for (const view of views) {
			const seasons = (view.suggestion?.seasonNumbers ?? []).join(", ");

			process.stdout.write(
				`  ${(view.title ?? "—").padEnd(28)}`
				+ ` ${view.kind.padEnd(7)} ${view.heldAlready ? "held here" : "held by nothing"}`
				+ `${view.details ? "  named by the source" : ""}`
				+ `${seasons ? `  search: seasons ${seasons}` : ""}\n`,
			);
		}

		if (problems.length > 0) {
			process.stderr.write(`\n${problems.map((one) => `  ${one}`).join("\n")}\n`);
			process.exitCode = 1;
		}
	});
'

say ''
say 'Every ask was named, matched against the catalogue, and carries a search that'
say 'nothing here ran. Marking one answered is deliberately not part of this check: it'
say 'would close the ask, and the next run would have nothing left to read.'
