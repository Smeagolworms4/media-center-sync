#!/usr/bin/env bash
#
# Makes sure every lab gateway has a database of its own, on a server that already exists.
#
#     ensure-databases.sh [<database> ...]
#
# `gateway-databases.sql` is mounted into `/docker-entrypoint-initdb.d`, and Postgres runs
# that **only when it initialises an empty data directory**. Every lab whose database
# volume predates a gateway being added therefore starts that gateway against a database
# nobody created, and what you get is not an error about the lab: the container retries
# `Unable to connect to the database` ten times, the health check never goes green, and
# `lab/link` reports that the gateway "never answered" — which reads as a code fault in the
# API and costs half an hour before anybody thinks of the volume.
#
# So the init script keeps its job for a fresh lab, and this closes the gap for an existing
# one. Idempotent by construction: it creates only what is missing, so it is safe on every
# `lab/up` and cannot touch a database that already holds a gateway's identity and
# catalogue — dropping and recreating one would invalidate every peer link naming it.
set -euo pipefail

PROJECT="${LAB_COMPOSE_PROJECT:-media-center-sync-lab}"
USER_NAME="${LAB_DB_USER:-mcs}"

# Defaults to the two the init script creates beside `POSTGRES_DB`. Passing names lets a
# gateway be added without this script having to know about it.
DATABASES=("$@")
[ "${#DATABASES[@]}" -eq 0 ] && DATABASES=(gateway_remote gateway_far)

CONTAINER="$(docker ps -q \
	--filter "label=com.docker.compose.project=$PROJECT" \
	--filter 'label=com.docker.compose.service=gateway-db' | head -1)"

if [ -z "$CONTAINER" ]; then
	echo "No running gateway-db container in the $PROJECT project; start it first" >&2
	exit 1
fi

# The health check is what `depends_on` waits for, but this runs from the host and may well
# arrive first: `pg_isready` is the same question Compose asks, asked here.
for _ in $(seq 1 60); do
	docker exec "$CONTAINER" pg_isready -U "$USER_NAME" >/dev/null 2>&1 && break
	sleep 2
done

for database in "${DATABASES[@]}"; do
	# `CREATE DATABASE` has no `IF NOT EXISTS` in Postgres and cannot run inside a
	# transaction, so the check and the creation are two statements. Between them nothing
	# else creates databases on this server, and a duplicate would fail loudly rather than
	# quietly — which is the right way round.
	exists="$(docker exec "$CONTAINER" psql -U "$USER_NAME" -d postgres -tAc \
		"SELECT 1 FROM pg_database WHERE datname = '$database'" 2>/dev/null || true)"

	if [ "$exists" = '1' ]; then
		printf '  %-16s already there\n' "$database"
		continue
	fi

	docker exec "$CONTAINER" psql -U "$USER_NAME" -d postgres -q \
		-c "CREATE DATABASE $database OWNER $USER_NAME"
	printf '  %-16s created\n' "$database"
done
