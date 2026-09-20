# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Media Center Sync — production image.
#
# One image, one container. The API serves both `/api` and the built interface, the
# database is a SQLite file under `/data`, and the cache is a Valkey started inside
# the image on a unix socket. Somebody self-hosting this next to their media server
# should not have to run a PostgreSQL, a Redis and a reverse proxy to pull a few
# episodes.
#
# The cache is embedded rather than required as a second container because both
# alternatives were worse. Asking for a Redis container turns a one-container install
# into a compose file somebody has to maintain, and the live transfer state — the
# per-worker rate accounting that makes multi-connection transfers behave, the
# chunk locks, the resume hints — is what would be lost by defaulting to in-process
# memory, silently and only under load. Valkey costs three megabytes here, so the
# default carries the cost nobody notices instead of the one that shows up as a
# transfer that will not go faster than one stream.
#
# Everything stays swappable through the environment: `DB_TYPE=postgres` points at
# a real server, `REDIS_HOST` hands the cache to one you already run, and
# `MCS_EMBEDDED_CACHE=0` starts nothing at all and keeps that state in the process.
# See `entrypoint.sh`, which decides between the three.
#
# Built in two stages: one with the full toolchain, one that keeps only the result
# and the runtime dependencies. The shipped image carries no TypeScript, no tests
# and no sources.
# ---------------------------------------------------------------------------

FROM node:24-alpine AS builder

WORKDIR /app

# Manifests first: as long as they do not change, Docker reuses the install layer,
# by far the longest one.
COPY package.json ./
COPY packages/shared/package.json packages/shared/package-lock.json packages/shared/
COPY packages/api/package.json packages/api/package-lock.json packages/api/
COPY packages/front/package.json packages/front/package-lock.json packages/front/

# Manifests and lockfiles first, one install per package: as long as they do not
# change, Docker reuses these layers, by far the longest ones.
#
# `better-sqlite3` compiles here — it has no prebuilt binary for this Node on Alpine —
# and the toolchain never leaves this stage.
RUN apk add --no-cache python3 make g++ \
	&& npm --prefix packages/shared ci \
	&& npm --prefix packages/api ci \
	&& npm --prefix packages/front ci

COPY packages/shared packages/shared
COPY packages/api packages/api
COPY packages/front packages/front

# Read by Vite at build time, not at runtime. The produced files are static: what is
# not pinned here can no longer be pinned afterwards.
ARG MCS_VERSION=dev
ENV VITE_APP_VERSION=$MCS_VERSION

RUN npm --prefix packages/shared run build \
	&& npm --prefix packages/api run build \
	&& npm --prefix packages/front run build

# --- Runtime dependencies --------------------------------------------------
#
# A separate stage rather than a prune of the previous one: that one carries Vue,
# Vuetify and Vite, which the running process has no use for.

FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json packages/shared/package-lock.json packages/shared/
COPY packages/api/package.json packages/api/package-lock.json packages/api/

# Only what the running process needs. The interface's dependencies — Vue, Vuetify,
# Vite — weigh more than everything else here and are of no use once it is built.
RUN apk add --no-cache python3 make g++ \
	&& npm --prefix packages/shared ci --omit=dev \
	&& npm --prefix packages/api ci --omit=dev \
	&& npm cache clean --force

# --- Final image -----------------------------------------------------------

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# The cache that `entrypoint.sh` starts unless the deployment points at another one.
# Valkey rather than Redis because it is the package Alpine carries, under a licence
# that lets it be shipped inside an image like this one.
RUN apk add --no-cache valkey

# We keep the base image's `node` user, at uid 1000.
#
# Libraries are mounted from the host, where they belong to the NAS user — uid 1000
# in the vast majority of cases. A container running as 1001 has no write access,
# and the first transfer fails on an `EACCES` that nothing announces: the app
# starts, reports itself healthy, and refuses the first file.

COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/api/package.json packages/api/
COPY --from=builder /app/packages/api/dist packages/api/dist
COPY --from=deps /app/packages/api/node_modules packages/api/node_modules

# The interface, served by the API itself. `MCS_STATIC_ROOT` points at it; unset,
# the API serves nothing but `/api`, which is what the development stack wants.
COPY --from=builder /app/packages/front/dist public
ENV MCS_STATIC_ROOT=/app/public

# `/data` holds the SQLite file, the transfer scratch space and the cache socket.
# Declared as a volume so that `docker run` without `-v` does not silently lose the
# library index on the next image pull.
#
# `node` owns it because the container runs as `node` and the embedded cache creates
# its socket there at startup. A `/data` only root could write to would kill the
# container in its first second, on an error about a socket rather than about a
# permission.
RUN mkdir -p /data/transfer /media && chown -R node:node /data
VOLUME ["/data"]

ENV DB_TYPE=sqlite
ENV DB_FILE=/data/media-center-sync.db
ENV MCS_TRANSFER_ROOT=/data/transfer
ENV MCS_MEDIA_ROOT=/media

USER node

ENV API_PORT=4200
EXPOSE 4200

# Checks that the API answers and that its database is reachable, not merely that
# the process is alive: a broken database leaves the server standing but unusable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint starts the cache and then runs the command, so `docker run … <image>
# node -e …` still works: whatever is passed replaces the `CMD` and is what the
# entrypoint runs, with the cache already up.
COPY --chmod=0755 docker/build/entrypoint.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "packages/api/dist/main.js"]
