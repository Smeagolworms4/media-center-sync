# Media Center Sync

A gateway that sits next to your media servers and keeps them in step with each
other — and with your friends'.

You register media services: the Jellyfin in your living room, the Plex on the NAS,
a friend's gateway across town. Media Center Sync indexes them all, works out which
items are the same media, shows you at a glance what you are missing, and pulls it
across — resumable, from several sources at once, straight into the library folder
your own server already watches.

*[Version française](README.fr.md)*

---

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
  - [Services, local and remote](#services-local-and-remote)
  - [Indexing, and why the gateway caches](#indexing-and-why-the-gateway-caches)
  - [Correlation: what is the same media](#correlation-what-is-the-same-media)
  - [Quality at a glance](#quality-at-a-glance)
  - [Syncing](#syncing)
  - [Transfers](#transfers)
  - [When a transfer goes wrong](#when-a-transfer-goes-wrong)
  - [Peers, friends, and friends of friends](#peers-friends-and-friends-of-friends)
  - [Sharing](#sharing)
  - [Signing in](#signing-in)
- [Configuration](#configuration)
- [Development](#development)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Continuous integration](#continuous-integration)
- [Licence](#licence)

---

## What it does

- **Registers any number of media services**, local or remote, through a handler per
  service type. Jellyfin and Plex ship with it; adding another means writing one
  class.
- **Correlates media across every service**, so a season page can tell you that you
  have episodes 1 to 6, that 7 and 8 exist on a friend's server, and that your copy
  of episode 3 is the 720p one when a 1080p exists elsewhere.
- **Shows the state of every item** with one icon and one vocabulary, everywhere:
  in sync, missing, outdated, conflicting, syncing, local only, unknown.
- **Summarises quality** per series or season — `x265 · 1080p`, or `mixed` with every
  variant listed in the tooltip, because a library is rarely uniform and a single
  arbitrary codec would be a summary that lies.
- **Runs syncs**, one-off or scheduled, that pull what is missing into the right
  folder with the right name, metadata and artwork included.
- **Transfers properly**: chunked, resumable, several connections per source, several
  sources per file, pause and resume, live progress, per-piece verification and
  targeted repair.
- **Links gateways peer to peer**, directly when the network allows it and through a
  rendezvous relay when it does not, with friend-of-a-friend discovery so several
  people holding the same file can feed one transfer.
- **Lets you decide what you share**, per library, with whom, and whether they get the
  files or only the catalogue.

## Quick start

One container, one volume, nothing to administer:

```yaml
services:
  media-center-sync:
    image: ghcr.io/smeagolworms4/media-center-sync:main
    restart: unless-stopped
    ports:
      - 4200:4200   # interface and API
      - 4210:4210   # inbound peer connections
    environment:
      - MCS_JWT_SECRET=change-me
    volumes:
      - mcs-data:/data
      - /mnt/nas:/media

volumes:
  mcs-data:
```

Then open `http://localhost:4200` and sign in with `admin` / `admin`.

> **The `/media` mount is the one thing that has to be right.** It must point at the
> same files your media server sees. If your Jellyfin has `/media/Shows` and the
> gateway writes to a different directory that happens to be called the same, every
> transfer will succeed, the files will really be there, and your library will stay
> empty — with nothing anywhere reporting an error. The interface probes this and
> tells you, but it is worth getting right before the first sync.

Forwarding port 4210 on your router is optional. Without it, peer links fall back to
a relay through the rendezvous: it works, but the relay's bandwidth is shared by
everyone using it.

## How it works

### Services, local and remote

There is no distinguished "my server". A gateway holds a list of media services:

- a **local** service is one whose library folders the gateway can write into — its
  files land on a disk the gateway has mounted;
- a **remote** service is one it can only read from — a friend's, reached through a
  peer link, or one of yours you would rather not have written to.

You can register several of each. A sync is triggered *between* two of them, which is
why nothing in the model says which one is "the" target.

Each type is a handler. The application never knows whether it is talking to Jellyfin
or Plex: it asks a handler to probe, to list libraries, to scan, to refresh, to open a
byte range. Adding Emby, Kodi or a plain HTTP index means writing that one class.

### Indexing, and why the gateway caches

**The interface never queries your media servers.** It reads the gateway's own index.
That is what makes a library of forty thousand episodes browsable at all, and it is
what keeps ten open browser tabs from becoming ten requests to a Raspberry Pi.

The index is kept current in two ways:

- a **refresh**, cheap and frequent, asks each service for its own short list of
  recent additions and advances a per-library cursor. A few dozen rows, every few
  minutes;
- a **full scan**, rare and scheduled — plus a button in the interface — re-reads
  everything. It has to exist, because a refresh only sees what a service *reports*
  as new: files moved, deleted or re-encoded in place go unnoticed otherwise.

### Correlation: what is the same media

Two libraries call the same episode `S01E02`, `1x02`, `102` or
`Show.S01E02.1080p.WEB-DL.x265-GROUP`. Deciding they are the same thing is the part
that has to be right, so it is done in order of how much each signal can be trusted:

1. **checksum** — certain, and almost never available up front;
2. **external identifier** — the TVDB, TMDB or IMDb id both services already agree on;
3. **season and episode**, under a parent that is already matched;
4. **normalised title** and year, scored by similarity;
5. **path**.

Each match is stored as its own row with the strategy and a confidence between 0 and
1, so a wrong correlation can be explained and undone rather than being an
unaccountable fact. Below the configured threshold a match is *proposed*, not applied.

Items are never merged. The same episode held by three friends is three rows in the
index — merging them would mean choosing whose title, whose artwork and whose file
size to keep, and losing exactly the differences a sync exists to show.

### Quality at a glance

A season row shows one chip: `x265 · 1080p`. When its episodes disagree, it shows
`mixed`, and the tooltip lists every variant with how many files carry it and how much
space they take. That is the only honest summary — and the moment you need to know
which episode is the odd one, it is right there.

The same comparison decides whether a remote copy is *better* than yours: resolution
first, then codec efficiency, then bitrate, and only then size. Size alone is a bad
signal — a bloated 720p rip is bigger than a good 1080p encode.

### Syncing

A **sync plan** is a standing intent: what to pull, from where, to where. Sources are
an ordered list; left empty it follows the service priority you set once in the
administration screen, which is what most people want — pinning the list into every
plan would mean editing them all the day a friend's server moves.

The destination follows the same principle. By default a pulled file goes **next to
your own copy** of that series or collection, which keeps a tidy library tidy and does
the right thing for collections. You can instead send everything to a chosen library,
or to a fixed path.

Plans run manually, on a cron schedule, or whenever a source announces something new.
Every plan can be previewed before it runs: what it would pull, from where, to which
path, and how many bytes that is.

### Transfers

A transfer is chunked. Each piece records which source served it, how many attempts it
took, and the hash it should have. That state is in the database, not in memory — a
gateway restarted mid-pull has to know which pieces it already holds, or a
forty-gigabyte season starts over.

From there you get, without any of it being a special case:

- **several connections against one source**, when it honours range requests;
- **several sources for one file**, chosen by measured throughput;
- **pause and resume**, across restarts;
- **parallel transfers**, bounded by a setting, with global rate limits;
- **live progress**, pushed over a WebSocket rather than polled, batched into one
  frame every half second rather than one per chunk.

When several peers hold the same file, an encapsulated swarm mode lets them feed one
transfer together. Peers recognise each other's copies without exchanging anything:
the content identifier is derived from a few sampled ranges of the file plus its exact
size, so two gateways compute the same value independently. Hashing a forty-gigabyte
episode in full just to find out whether a friend has it would cost more than
downloading it.

### When a transfer goes wrong

A failed range is ambiguous. The file may have been moved by a library cleanup,
re-encoded overnight, deleted, or served badly by a flaky disk. Guessing costs either
a pointless re-download or a good source dropped for nothing — so the gateway asks.

It sends the far end a request to re-read that one item and report what it actually
holds now. The answer decides what happens next:

| The far end says | What the gateway does |
|---|---|
| still there, same fingerprint | our copy is the broken one — re-fetch the bad pieces |
| same content, new path | follow the move and resume |
| different fingerprint | it was re-encoded; this is another version now |
| no longer held | drop that source and look for another |
| no answer | decide nothing; wait and ask again |

Verification is per piece, so a repair is a few megabytes rather than a restart. The
same machinery re-verifies a file that was already placed: one that arrived intact can
still be truncated later by a full disk or a half-written move, and the gateway is the
only thing that still knows what it was supposed to contain.

### Peers, friends, and friends of friends

A peer is another gateway, identified by its public key fingerprint — never by its
address, so a friend behind a dynamic IP is still the same friend tomorrow.

You link by handing someone an invitation: a code carrying the fingerprint, a
rendezvous to meet at, and a one-shot secret. It expires, and it burns on use. An
invitation that never expired would be a credential left in a chat log, and whoever
found it would be a friend as far as the gateway is concerned.

The **rendezvous** is a middle server whose only job is to introduce two ends so they
can open a direct, encrypted connection. It is not trusted with the content: when a
direct path cannot be opened it can relay, and that is the degraded mode, not the
normal one.

A linked friend can tell you that *one of their* peers also holds a file you are
pulling. That friend of a friend is reachable and useful — more bandwidth, another
source — but they are not someone you invited, the interface says so, and the sharing
rules can exclude them entirely.

### Sharing

Sharing is decided **per library**, not per service: you may want your series visible
and your home videos not, and both live on the same Jellyfin. A library with no policy
is private — nothing is ever shared by having been forgotten.

For each one you choose who sees it (nobody, your friends, or their friends too), which
peers are allowed or denied whatever the rule says, whether they get the files or only
the catalogue, and how much bandwidth it will serve. Before saving, you can see exactly
what a given peer would see of you.

### Signing in

The gateway does not want to be one more password to remember. By default it delegates
to a media service you already registered: you sign in with your Jellyfin or Plex
account, and the gateway mirrors the user without ever holding a password it did not
issue.

Internal accounts still exist, for two reasons: the first administrator has to exist
before any service is registered, and a gateway whose only service is down must still
be reachable to fix it. An external identity provider can be added the same way —
authentication is a provider interface, like everything else here.

Sessions are backed by the database and checked on every call, so signing out is
immediate rather than leaving a token valid until it expires.

## Configuration

Everything is read from the environment.

| Variable | Default | What it does |
|---|---|---|
| `MCS_JWT_SECRET` | *(none)* | Signs sessions. **Required in production** — there is deliberately no default. |
| `MCS_MEDIA_ROOT` | `/media` | Where library folders are mounted, as the gateway sees them. |
| `API_PORT` | `4200` | Interface and API. |
| `PEER_PORT` | `4210` | Inbound peer connections. |
| `DB_TYPE` | `sqlite` | `sqlite` or `postgres`. |
| `DB_FILE` | `/data/media-center-sync.db` | SQLite file. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | — | Read only when `DB_TYPE=postgres`. |
| `REDIS_HOST` / `REDIS_PORT` | *(empty)* | Empty means an in-process cache. Only worth setting with several gateways. |
| `MCS_TRANSFER_ROOT` | `/data/transfer` | Where pieces accumulate before a file is placed. |
| `MCS_STATIC_ROOT` | *(set in the image)* | The built interface. Unset, the API serves only `/api`. |
| `MCS_CORS_ORIGINS` | *(empty)* | Comma-separated. Not needed when the interface is served by the API. |

SQLite and an in-process cache are the defaults on purpose: this is a gateway somebody
self-hosts next to their media server, not a multi-tenant service. Neither a PostgreSQL
nor a Redis should have to be kept alive to pull a few episodes. Both remain one
environment variable away, and the migrations are the same either way.

## Development

Everything runs in containers, Node included. You need Docker and Make.

```bash
make up          # start the stack
make init        # install, migrate, seed
make dev         # run the API and the interface together
```

> Install through `make`, not `npm`. `better-sqlite3` compiles a native binding and
> the containers are Alpine: one built on a glibc host refuses to load inside them,
> with an error about a missing `ld-linux-x86-64.so.2` that says nothing about where
> the install came from.

| | |
|---|---|
| Interface | http://localhost:3200 |
| API and Swagger | http://localhost:4200/api/docs |

`make` on its own lists every target. The ones you will actually use:

| Target | What it does |
|---|---|
| `make dev` | API and interface together |
| `make api/logs`, `make front/logs` | follow the logs |
| `make api/bash`, `make front/bash` | a shell in the container |
| `make check` | everything the pipeline checks: types, lint, tests |
| `make db/migrate`, `make db/migration NAME=X` | run and generate migrations |
| `make db/reset` | back to a clean, seeded database |
| `make db/postgres`, `make db/sqlite` | switch engine |
| `make library/check`, `make library/help` | verify and explain the media mounts |
| `make service/list`, `make service/probe ID=…` | poke at registered services |
| `make e2e` | Playwright journeys against the running stack |
| `make doctor` | what is up, on which ports, and whether the API is healthy |
| `make image`, `make image/run` | build and run the production image locally |

Media libraries are deliberately **not** mounted in the versioned Compose file: they
are specific to your machine, and pinning them there would break the stack for anyone
without the same NAS. Declare them in `docker/docker-compose.override.yml`, which
Compose reads automatically and git ignores. `make library/help` prints the exact
shape.

## Testing

Three layers, each answering a different question.

- **Unit tests** sit next to the code they cover and mock everything around them. A
  manager is tested against fake repositories, so a failure names the rule that broke
  rather than the stack underneath it. This is where the correlation strategies, the
  quality comparator, the chunk planner and the revalidation decision table are
  pinned down.
- **Functional tests** boot the real application over an in-memory database and talk
  to it over HTTP. They are the only thing that proves the guards, the validation pipe
  and the serialisation actually apply — none of which a unit test on a manager can
  see.
- **Journeys** (Playwright) drive a real browser against the running stack. They are
  the only place you find out that a button stays grey, that a list never fills, or
  that the progress stream stopped pushing.

```bash
make test          # unit and functional, both packages
make api/coverage  # with coverage
make e2e           # journeys, against the running stack
```

## Project layout

```
packages/
  shared/    contracts used by both sides: enums, exchange shapes, error keys
  api/       NestJS
  front/     Vue 3, Vuetify, Pinia
docker/
  build/     the production image
  dev/       the development stack
docs/        architecture and design notes
```

The three packages install separately — their own manifest, lockfile and
`node_modules` — and `@mcs/shared` is a file dependency. Nothing is hoisted, so the
interface can be built and run on its own against a remote API, and a version bump on
one side cannot silently move the other. The production image happens to bundle both
into one container; that is packaging, not coupling.

Inside the API, the layers are strict and the point of the exercise:

```
controllers/   HTTP only: route, validate, check rights, call a manager, return
managers/      the business layer. Decides. Knows nothing about HTTP
repositories/  database access only. Knows nothing about rules
services/      technical capability: handlers, transports, hashing, scheduling
entities/      the persistence model
models/        request and response shapes
```

Inside the interface, the same idea: components display, stores hold state and talk to
the API, composables hold reusable logic. A component never builds a URL.

## Continuous integration

Every push runs the types, the lint, both test suites and the Playwright journeys.
Only if all of that passes is the image built and published.

`:main` is a moving tag, republished on every merge — the image you pull to try the
latest version without tagging anything. Anything that must stay stable carries a
version tag: a stack pointing at `:main` would change code on every merge, without
anyone deciding it.

## Licence

MIT.
