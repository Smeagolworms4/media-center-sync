export DOCKER_NAME=media-center-sync

# external resource #
export MAKEFILE_URL=https://raw.githubusercontent.com/Smeagolworms4/auto-makefile/master
export IMPORT_MK=docker-compose.mk

# import #
$(shell [ ! -f docker/.makefiles/index.mk ] && mkdir -p docker/.makefiles && curl -L --silent -f $(MAKEFILE_URL)/$(IMPORT_MK) -o docker/.makefiles/index.mk)
include docker/.makefiles/index.mk

export FRONT_PORT             ## Web interface (default: 3200)
export API_PORT               ## API (default: 4200)
export DEBUG_PORT             ## Node debugger for the API (default: 9230)
export PEER_PORT              ## Inbound peer connections (default: 4210)
export DB_PORT                ## PostgreSQL (default: 5433)
export REDIS_PORT             ## Redis (default: 6381)
export PGADMIN_PORT           ## pgAdmin (default: 7795)

###############
# Development #
###############

## Init project (install + migrations + demo dataset)
init: install db/migrate db/seed
	@echo ""
	@echo "  Interface      http://localhost:$${FRONT_PORT:-3200}"
	@echo "  Swagger        http://localhost:$${API_PORT:-4200}/api/docs"
	@echo "  pgAdmin        make tools/up then http://localhost:$${PGADMIN_PORT:-7795}"
	@echo ""

## Install dependencies (npm workspaces, one install for everything)
install:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm install
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run build --workspace @mcs/shared

## Clean reinstall from the lockfile
install/ci:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm ci --workspaces --include-workspace-root
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run build --workspace @mcs/shared

## Run the API and the interface together
dev:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run dev:api & \
	$(COMPOSE) exec -u node front env $(FIX_SHELL) npm run dev:front & \
	wait

## Typecheck every package
typecheck:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run typecheck

## Lint every package
lint:
	$(COMPOSE) exec -u node front env $(FIX_SHELL) npm run lint

## Lint and fix what can be fixed
lint/fix:
	$(COMPOSE) exec -u node front env $(FIX_SHELL) npm run lint:fix --workspace @mcs/front

## Whole unit and functional test campaign
test: api/test front/test

## Production build of every package
build:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run build

## Everything the CI checks, in one go
check: typecheck lint test

#######
# API #
#######

## Display logs `api`
api/logs:
	$(COMPOSE) logs -f api

## Connect to shell `api`
api/bash:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) sh -l

## Connect to shell `api` (root)
api/bash-root:
	$(COMPOSE) exec api env $(FIX_SHELL) sh -l

## Start dev `api`
api/dev:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run dev:api

## Unit and functional tests of the API
api/test:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm test --workspace @mcs/api

## API tests in watch mode
api/test-watch:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run test:watch --workspace @mcs/api

## API tests with coverage
api/coverage:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run test:cov --workspace @mcs/api

## Restart the API container
api/restart:
	$(COMPOSE) restart api

#########
# Front #
#########

## Display logs `front`
front/logs:
	$(COMPOSE) logs -f front

## Connect to shell `front`
front/bash:
	$(COMPOSE) exec -u node front env $(FIX_SHELL) sh -l

## Start dev `front`
front/dev:
	$(COMPOSE) exec -u node front env $(FIX_SHELL) npm run dev:front

## Unit tests of the interface
front/test:
	$(COMPOSE) exec -u node front env $(FIX_SHELL) npm test --workspace @mcs/front

## Interface tests in watch mode
front/test-watch:
	$(COMPOSE) exec -u node front env $(FIX_SHELL) npm run test:watch --workspace @mcs/front

## Production build `front`
front/build:
	$(COMPOSE) exec -u node front env $(FIX_SHELL) npm run build --workspace @mcs/front

#######
# E2E #
#######

## Playwright journeys against the running development stack
##
## The stack must be up: these journeys open real pages and write to the database.
## `--no-deps` so we do not restart what already runs — and above all do not tear it
## down on exit, which an `up` followed by a `down` would do.
e2e:
	$(COMPOSE) --profile e2e run --rm --no-deps e2e npx playwright test $(ARGS)

## Bring the stack up, seed it, run the journeys — the CI target
##
## It starts from a stopped stack and leaves it standing. On a workstation it would
## therefore disturb the running development stack; this is an integration target,
## not a local convenience. Locally `make e2e` is enough: the stack already runs.
##
## Servers are started detached, then waited for. Vite and Nest compile on startup:
## running the journeys without waiting would fail the first one on a timeout, for a
## reason that has nothing to do with what it checks.
e2e/ci:
	USER_ID=$$(id -u) USER_GID=$$(id -g) $(COMPOSE) up -d db cache api front
	$(COMPOSE) exec -T -u node api sh -lc 'npm ci --workspaces --include-workspace-root'
	$(COMPOSE) exec -T -u node api sh -lc 'npm run build --workspace @mcs/shared'
	$(COMPOSE) exec -T -u node api sh -lc 'npm run migration:run --workspace @mcs/api'
	$(COMPOSE) exec -T -u node api sh -lc 'npm run seed --workspace @mcs/api'
	$(COMPOSE) exec -d -u node api sh -lc 'npm run dev --workspace @mcs/api'
	$(COMPOSE) exec -d -u node front sh -lc 'npm run dev --workspace @mcs/front'
	$(COMPOSE) --profile e2e run --rm --no-deps e2e sh -lc '\
		for i in $$(seq 1 90); do \
			curl -sf http://api:4200/api/docs-json >/dev/null && curl -sf http://front:3200 >/dev/null && break; \
			sleep 2; \
		done; \
		npx playwright test'

## Open a shell in the Playwright container
e2e/bash:
	$(COMPOSE) --profile e2e run --rm --no-deps e2e sh -l

## Path of the last journey report
e2e/report:
	@echo "packages/front/playwright-report/index.html"

############
# Database #
############

## Display logs `db`
db/logs:
	$(COMPOSE) logs -f db

## Open a SQL client on the database
db/shell:
	$(COMPOSE) exec db psql -U $${DB_USER:-mcs} $${DB_NAME:-mcs}

## Run pending migrations
db/migrate:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run migration:run --workspace @mcs/api

## Revert the last migration
db/revert:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run migration:revert --workspace @mcs/api

## Generate a migration: make db/migration NAME=AddSomething
db/migration:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run migration:generate --workspace @mcs/api -- src/database/migrations/$(NAME)

## Install the admin account and the demo dataset
db/seed:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run seed --workspace @mcs/api

## Dump the database to var/dump.sql
db/dump:
	$(COMPOSE) exec -T db pg_dump -U $${DB_USER:-mcs} $${DB_NAME:-mcs} > var/dump.sql
	@echo "var/dump.sql"

## Reset the database, replay migrations and reinstall the dataset
db/reset:
	$(COMPOSE) stop db
	$(COMPOSE) rm -f db
	docker volume rm -f $(DOCKER_NAME)_db-data || true
	$(COMPOSE) up -d db
	@sleep 6
	@$(MAKE) --no-print-directory db/migrate db/seed

#############
# Libraries #
#############

# The gateway must see exactly the same paths as the media service.
#
# A media file pulled into `/media/Shows/…` only exists for Jellyfin if that path
# points at the same directory on both sides. Otherwise the transfer succeeds, the
# file is really there, and the library stays empty — a defect that only shows up
# afterwards and that no error reports.
#
# Mounts are machine-specific: they live in `docker/docker-compose.override.yml`,
# never here.

## List what the gateway sees of the mounted libraries
library/list:
	$(COMPOSE) exec -u node api sh -lc 'ls -la $${MCS_MEDIA_ROOT:-/media}'

## Check every declared library is readable and writable from the gateway
library/check:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run library:check --workspace @mcs/api

## Explain how to declare a mount (NFS, SMB, bind)
library/help:
	@echo ""
	@echo "  Mount the libraries on the host, then pass them to the container with a"
	@echo "  bind in docker/docker-compose.override.yml (not versioned):"
	@echo ""
	@echo "      services:"
	@echo "        api:"
	@echo "          volumes:"
	@echo "            - /mnt/nas:/media"
	@echo ""
	@echo "  On the host, an NFS export mounts like this:"
	@echo ""
	@echo "      sudo mount -t nfs <host>:/export/<share> /mnt/nas/<share>"
	@echo ""

############
# Services #
############

## List registered media services and their reachability
service/list:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run service:list --workspace @mcs/api

## Probe one service: make service/probe ID=<uuid>
service/probe:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run service:probe --workspace @mcs/api -- $(ID)

## Rescan a service library: make service/scan ID=<uuid>
service/scan:
	$(COMPOSE) exec -u node api env $(FIX_SHELL) npm run service:scan --workspace @mcs/api -- $(ID)

##############
# Diagnostic #
##############

## Stack status: containers, ports, API health
doctor:
	@$(COMPOSE) ps
	@echo ""
	@curl -fsS http://localhost:$${API_PORT:-4200}/api/health 2>/dev/null && echo "" || echo "  api: unreachable on $${API_PORT:-4200}"

## Start the optional tooling containers (pgAdmin)
tools/up:
	$(COMPOSE) --profile tools up -d
	@echo "pgAdmin: http://localhost:$${PGADMIN_PORT:-7795}"

## Stop the optional tooling containers
tools/down:
	$(COMPOSE) --profile tools stop pgadmin

## Remove dependencies and build outputs (leaves the database alone)
clean:
	rm -rf node_modules packages/*/node_modules packages/*/dist
	rm -rf packages/front/test-results packages/front/playwright-report

## Remove everything, volumes included — the database is lost
clean/all: clean
	$(COMPOSE) down -v

##########
# Engine #
##########

# The database engine is read from `DB_TYPE`. SQLite is the default and is enough
# for a single household gateway: one file, nothing to operate. PostgreSQL stays one
# environment variable away, and the migrations are the same.

## Switch the stack to PostgreSQL (starts the server and points the API at it)
db/postgres:
	@grep -q '^DB_TYPE=' .env.local 2>/dev/null || printf 'DB_TYPE=postgres\nDB_HOST=db\n' >> .env.local
	$(COMPOSE) --profile postgres up -d db
	@$(MAKE) --no-print-directory api/restart db/migrate
	@echo "Engine: postgres. Remove DB_TYPE from .env.local to go back to SQLite."

## Switch the stack back to SQLite
db/sqlite:
	@sed -i '/^DB_TYPE=/d;/^DB_HOST=/d' .env.local 2>/dev/null || true
	$(COMPOSE) --profile postgres stop db || true
	@$(MAKE) --no-print-directory api/restart db/migrate
	@echo "Engine: sqlite ($${DB_FILE:-var/media-center-sync.db})."

## Start Redis and point the API at it (in-memory cache otherwise)
cache/redis:
	@grep -q '^REDIS_HOST=' .env.local 2>/dev/null || echo 'REDIS_HOST=cache' >> .env.local
	$(COMPOSE) --profile redis up -d cache
	@$(MAKE) --no-print-directory api/restart

##########
# Images #
##########

## Build the production image locally (one image: API + interface)
image:
	docker build -f docker/build/Dockerfile -t media-center-sync:local .

## Run the production image locally, on its own volume
image/run: image
	docker run --rm -it -p 4200:4200 -p 4210:4210 \
		-v media-center-sync-data:/data \
		-e MCS_JWT_SECRET=local-secret \
		media-center-sync:local

## Open a shell inside the production image
image/bash: image
	docker run --rm -it --entrypoint sh media-center-sync:local
