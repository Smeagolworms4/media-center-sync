# Architecture

How the pieces fit, and why they were cut that way. `README.md` says what the product
does; this says how it is built. `CLAUDE.md` says how to work on it.

## Shape of the repository

```
packages/
  shared/              contracts: enums, exchange shapes, error keys, event names
  api/                 NestJS
    src/
      controllers/     HTTP surface
      managers/        business decisions
      repositories/    database access
      services/        technical capability
        handlers/      one per media service type
        transport/     one per way of moving bytes
      entities/        persistence model
      models/          request and response DTOs
      security/        strategies and guards
      decorators/      @Granted, @CurrentUser, @MediaHandler, @PeerRoute
      database/        data source and migrations
      commands/        standalone scripts run from the Makefile
      config/          one typed configuration function
    test/              functional tests
  front/               Vue 3, Vuetify, Pinia
    src/
      pages/           one per route
      components/      display only, small, single-purpose
      stores/          state and API calls
      composables/     reusable logic (useForm, …)
      hooks/           small composables (useEvents, useAppInit, …)
      libs/            framework-free helpers (the HTTP caller, observers, utils)
      plugins/         vuetify, i18n, validators, rights
      router/          routes and guards
      locales/         message catalogues
    tests/unit/        vitest
    tests/e2e/         playwright journeys
docker/
  build/               the production image
  dev/                 the development stack
docs/                  this
```

Three packages, three installs. Each has its own manifest, lockfile and
`node_modules`; `@mcs/shared` is a `file:` dependency. Nothing is hoisted, which costs
a little disk and buys two things: the interface can be built and run alone against a
remote API, and a dependency bump on one side cannot silently move the other. The
production image bundles the API and the built interface into one container — that is
packaging, and the only place the two meet.

## The contract package

`packages/shared` is not a utility library. It holds the vocabulary both sides have to
agree on:

- the `SyncState` values the whole interface renders;
- `MediaServiceType`, `TransferState`, `RevalidationOutcome` and the rest of the
  enums that appear in the database, in HTTP payloads and in the UI;
- every request and response shape;
- `ErrorKey`, the keys the API answers with instead of sentences;
- `EventName` and the payloads pushed over the WebSocket.

Anything defined twice will eventually disagree, and the disagreement will be a state
icon that means one thing in a list and another on a detail page. Putting the
vocabulary in one compiled package makes that a type error instead.

## Layering in the API

```
HTTP ─▶ controller ─▶ manager ─┬─▶ repository ─▶ database
                               └─▶ service ────▶ media server, peer, disk
```

- **Controllers** route, validate the DTO, check the right, call one manager method,
  return. They hold no rule. A controller that branches on a business condition is a
  manager that has not been written yet.
- **Managers** decide. Whether a sync should run, which source wins, whether a match
  is good enough to apply, what happens when a transfer fails. They take and return
  plain shapes and know nothing about HTTP, which is what makes them testable against
  fake repositories — and what makes a failing unit test name the rule that broke.
- **Repositories** read and write. They never know who is asking or what they are
  allowed to see.
- **Services** are capability without authority: a handler knows how to ask Jellyfin
  for a byte range, not whether it should. Keeping the authority out of them is what
  lets a second handler be written without re-deciding anything.

Rights are checked with `@Granted(Right.X)` on the route. Roles are bundles of rights
and never appear in a condition — the hierarchy will change and the routes should not.
A route with no decorator is public, deliberately: sign-in cannot require the identity
it establishes.

## Handlers: the one abstraction that has to hold

Everything about a media service goes through one interface:

```
probe            is it there, who am I, what version, which libraries
authenticate     verify a user against it, when it is our identity provider
listLibraries
scanLibrary      full read, an async iterable of normalised items
refreshLibrary   what changed since a cursor, plus the new cursor
getItem
openStream       a readable stream for a byte range
getDownloadUrl   when the service can hand out a direct URL
```

Handlers are registered by decorator and found through Nest's `DiscoveryService`.

> The trap: without `DiscoveryModule` imported in the application module, nothing is
> collected and **no compilation fails**. The application simply behaves as though no
> handler existed, which looks like a configuration problem for a long time.

`scanLibrary` and `refreshLibrary` being separate is the load-bearing part. See below.

## Indexing

The interface never queries a media server. It reads the gateway's index. Two paths
keep that index honest:

```
refresh   every few minutes   ask for recent additions, advance the per-library cursor
scan      rare, scheduled     re-read everything, clear the cursor
```

A refresh is a few dozen rows. It exists because a browsable library of forty thousand
episodes cannot come from a live query, and because ten open tabs should not be ten
requests to a Raspberry Pi. A full scan exists because a refresh only sees what a
service *reports* as new: a file moved, deleted or re-encoded in place is invisible to
it.

The cursor is opaque — a timestamp for one handler, a watermark for another. Only the
handler that wrote it knows how to read it, which is what keeps the scan scheduler
from growing a branch per service type.

On top of that sits a short-lived cache with a TTL behind one interface: the Valkey
the production image starts on a unix socket and announces through `REDIS_SOCKET`, a
Redis or Valkey of your own when `REDIS_HOST` is set, or the process's own memory when
`MCS_EMBEDDED_CACHE=0` leaves neither. Its job is to collapse the same question asked
by several tabs in the same second, not to be a second index.

## Correlation

Items are never merged. The same episode on three services is three rows; what ties
them is a `MediaMatch` row carrying the strategy and a confidence. Merging would mean
choosing whose title, artwork and file size survive — and losing the differences that
are the entire point.

Strategies, in order of how much each can be trusted:

| Strategy | Certain? | What it gets wrong alone |
|---|---|---|
| checksum | yes | almost never available before a transfer |
| external id | nearly | absent on hand-filed libraries; wrong on mis-tagged ones |
| season + episode | high, under a matched parent | useless without the parent |
| absolute episode | high, and computed rather than declared | only exists where one side runs straight through and the other is cut into seasons |
| normalised title + year | scored | remakes, translated titles, `Part 1` / `Pt. 1` |
| path | weak | only meaningful between services sharing a mount |

Below the configured threshold a match is proposed, not applied, and shows up as
something to confirm rather than as a fact. `confirmedAt` records that a human agreed.

An episode identifier decides before any of that, but only where it names *that*
episode: media servers routinely stamp the series' number onto all four hundred rows,
so an identifier shared by more than one episode of a show on one service proves
nothing about which episode this is and is never compared. That count, taken per
service and per series, is what separates the two — never the key name, since `tvdb`
carries both.

`absolute episode` is the last resort and the only coordinate no server declared. An
absolute number is turned into a season and an episode with the season lengths of the
side that *is* split into seasons, as already indexed — never a formula. It runs only
where the two sides plainly use different conventions and account for the same show end
to end; a hole anywhere on the split side suspends it for the whole series, because a
missing episode shifts every season after it and the pairs past the shift are silently
wrong. Two sides that both number by season and merely disagree are left disagreeing.
See `services/episode-numbering.ts`, which holds every guard and the reasoning.

Normalisation — lowercase, accents folded, article dropped, release noise stripped —
is stored on the row rather than computed per query, because correlation joins on it
and a function call in a `WHERE` clause cannot use an index.

## Quality

A `QualitySummary` is computed for every node from the files below it: variants
grouped and counted, the dominant one named, `mixed` when they disagree. It is stored
on the row and recomputed when a child changes, because a series page shows the
summary of every season and walking the subtree per season turns a list of thirty
series into thousands of queries.

The same comparison answers "is theirs better than mine": height, then codec
efficiency, then bitrate, then size. Size last and only as a tie-break — a bloated
720p rip outweighs a good 1080p encode, and a comparator that believes otherwise will
cheerfully replace the good copy.

## Transfers

```
plan ─▶ chunks in the database ─▶ workers ─▶ verify ─▶ place
                 ▲                    │
                 └──── repair ────────┘
```

A transfer is a row; its pieces are rows. Each piece records its range, its state,
which source served it, how many attempts it took and the hash it should have. That
state is persisted rather than held in memory because a gateway restarted mid-pull has
to know what it already holds — and because the alternative is a forty-gigabyte season
starting over.

From that one structure, everything else falls out without special cases:

- several connections against one source, when it honours ranges;
- several sources for one file, picked by measured throughput;
- pause, resume, and survival across a restart;
- bounded parallelism and global rate limits;
- per-piece verification, so a repair is megabytes rather than a restart.

Progress is pushed over a WebSocket, batched into one frame every half second. One
frame per chunk would be thousands a second on a fast link, and polling would either
lag visibly or hammer the API. The interface reconciles by identifier, so a dropped
frame costs nothing.

### Content identity

`contentId` is derived from a few sampled ranges of the file plus its exact size. Two
gateways holding the same file compute the same value with no communication, which is
what lets them find each other in a swarm. The torrent — the piece hashes — is
generated from the file when a swarm transfer starts and never stored: it is a
function of the file, not a document about it.

Full hashing is reserved for verification, where it is worth its cost. Hashing forty
gigabytes to find out whether a friend has the same episode would cost more than
downloading it.

### Revalidation

A failed range is ambiguous: moved, re-encoded, deleted, or a flaky disk. Guessing
costs a pointless re-download or a good source dropped for nothing, so the gateway
asks the far end to re-read that one item.

| Outcome | Action |
|---|---|
| `CONFIRMED` — still there, same fingerprint | `REPAIR_LOCAL` |
| `MOVED` — same content, new path | `FOLLOW_MOVE` |
| `CHANGED` — different fingerprint | `SWITCH_SOURCE` |
| `GONE` | `ABANDON` if no other source, else `SWITCH_SOURCE` |
| `UNREACHABLE` | `REQUEUE` |

The table is a pure function and is tested exhaustively. Every revalidation is kept as
a row: it is the only trace of why a transfer changed its mind, and without it the
queue shows results nobody can account for.

## Peers

```
gateway A ──┐                        ┌── gateway C
            ├─▶ friend B ◀───────────┤      introduce by fingerprint
            │                        │
            └────── direct link ─────┘      or B carries it, when neither can be dialled
```

Identity is the public key fingerprint, never the address. **Peers are introduced by
the intermediaries they already have**: there is no server in the middle, no address
to look up and nothing to configure. The ladder is the last known address, then an
introduction from a friend both ends have, then that same friend carrying the bytes.

Which friends are asked is `PeerManager.introducersFor`: the peer that told us about
this one first — that is how we know it exists — then the other linked peers, and at
most `MAX_INTRODUCERS_ASKED` of them, because a gateway working through twenty friends
in turn is a screen that hangs.

The very first peer has nobody in the middle by definition, and that is what the
one-shot, expiring invitation is for: it carries the fingerprint, **the issuing
gateway's own address** and a secret, handed over out of band. That address names the
sender and nobody else.

Relaying is the last rung and is gated on the friend advertising `PeerCapability.RELAY`,
which a gateway does only while `Settings.relayForPeers` is on — advertising it is the
promise, so the capability comes from the setting and never from a constant.

The rung exists because of one topology: the carrier's link to the holder is **inbound**.
The holder dialled them, and they cannot dial back, because if they could the puller
could too. So the relayed traffic travels back down that existing socket inside a
multiplexing envelope — a marker that can never be a request identifier, an opcode, a
session and a length — and the carried link then runs the ordinary admission, handshake
and dispatch over a socket that is really a session on somebody else's. See
`peer-relay.model.ts` for the frame and `peer-relay.service.ts` for the sessions.

Three things are bounded, and all three are settled decisions rather than defaults
waiting for a knob: four carried links at once, four megabytes of one session's bytes
waiting on the budget before it is closed, and the relayed bytes charged to
`Settings.uploadRateLimit` rather than to a budget of their own — the uplink does not
care why a byte is leaving. The carrier holds both halves in plaintext and can read
them; nothing here is encryption, which is why direct is tried first and why the peer
card states on the row when a link is relayed.

So two gateways behind two routers with **no** friend in common, or none who agreed to
carry, cannot be connected — a stated limit, reported on the peers screen with the
forwarded port named as the fix.

### One port

A peer link is a WebSocket upgrade on `/api/peer/link`, on the same HTTP port the
interface and the API are served from. There is no second listener and no second port
anywhere in this application.

That is a decision, not an accident of implementation. A second port needs its own
firewall rule, its own entry in whatever reverse proxy sits in front, and its own
certificate to be usable over TLS — three things to get right, per household, for a
link that works perfectly well as an upgrade on a port that is already open and
already has a certificate. BitTorrent here is the *protocol* — the pieces, the swarm,
the piece selection — and none of that has an opinion about the wire it travels on.

The two gateways share one `upgrade` handler chain: each claims a path and returns
when the path is not its own, and a last handler refuses anything neither took. That
last one matters: Node does not close an upgrade nobody answers, so without it a
request to a wrong path sits half open until some timeout somewhere gives up.

### The handshake, and how the protocol grows

Both ends exchange a `PeerHello` — node identity, fingerprint, name, protocol version,
capabilities — before anything else is served. The answer to the first hello carries
the responder's public key and a signature over the initiator's challenge, so the
machine that answered proves it holds the key behind the fingerprint that was asked
for. On the middle rung the address came from an introducer that chose it; that proof
is the whole security argument for connecting first and verifying after.

A version outside `SUPPORTED_PROTOCOL_VERSIONS` is refused outright with
`error.peer.protocol_unsupported`. Before the first release there is one version, and
a mismatch is a flat refusal rather than a downgrade: carrying compatibility for
versions nobody ever ran is weight with no cargo, and it hides the one thing a
changing protocol should make loud.

Everything else the wire gains is a **capability**, named and advertised, under three
rules that are enforced and tested rather than intended:

- an unknown field in a payload is ignored, never fatal;
- an unknown method answers `error.peer.method_unsupported` and the link stays open;
- a feature is used only when the far end advertised its capability.

Together they are why a new method, a new field or a new kind of announcement does not
move the version — which is what lets two friends on different release days keep
talking.

### What one port does not solve

One port is enough **when at least one of the two ends is reachable**: a forwarded
port, a public host, a tunnel, a proxy with a name. Whoever is reachable is dialled.

It does nothing for the case where **both** ends are behind NAT with nothing
forwarded. A WebSocket needs something to connect to, and in that topology neither
side has one. A friend both ends already have can introduce them, which gets past "has
never heard of you" but not past "there is no socket to open". That friend can also
carry the link itself, inside the socket that already joins them to the holder, if
their household turned `relayForPeers` on. **Such a pair, with no friend in common —
or none who agreed to carry — cannot be connected at all** — a stated limit, not a
field somebody left empty, and the fix is a forwarded port on one of the two routers.

The intended answer for the general case is **WebRTC** — ICE with STUN to discover each
end's public address, TURN when it cannot be discovered, signalled over the peer link
that already carries introductions. It is **not implemented**, and nothing in the code
pretends otherwise.

A linked peer can announce that one of *its* peers holds a given `contentId`. That
friend of a friend widens the swarm and is marked as such everywhere, and
`allowFriendsOfFriends` turns the whole mechanism off.

## Sharing

A `SharePolicy` is per library, not per service: series visible, home videos not, both
on the same Jellyfin. **No row means private** — nothing is ever shared by having been
forgotten, which is the only safe default for a mechanism that exposes files to other
households.

Each policy carries a visibility, explicit allow and deny lists that override it, and
a bandwidth cap. The audit view answers the question people actually ask: what would
*this* peer see of me?

There was a middle setting once — show the titles, refuse the files — and it was
dropped. Seeing something you cannot have is not a feature, and anybody who does not
want to serve a library simply does not share it. Keeping it meant every screen, every
filter and every serving path carried a case whose only purpose was to disappoint
somebody.

## Authentication

Authentication is a provider interface:

- **service** — delegate to a registered Jellyfin or Plex; the gateway mirrors the
  user and never holds a password it did not issue. This is the default, because the
  gateway should not be one more password to remember;
- **internal** — local accounts. They exist because the first administrator has to
  exist before any service is registered, and because a gateway whose only service is
  down must still be reachable to fix it;
- **oidc** — the same shape, for anyone who wants it.

Sessions are rows, and the access token is checked against them on every call. A
stateless token would stay valid after sign-out until it expired, whatever the user
pressed.

## Persistence

SQLite by default, PostgreSQL behind an environment variable, the same migrations
either way. The default is deliberate: this is a gateway somebody self-hosts next to
their media server, and requiring a database server to be kept alive to pull a few
episodes would be a tax on every install for the benefit of almost none.

The constraint that follows is real and permanent: every migration must run on both
engines. Tables are built with TypeORM's `Table` objects rather than raw SQL, column
types stay inside the intersection of the two dialects, and primary keys are
application-generated UUIDs stored as an unbounded `varchar` — unbounded because
TypeORM normalises a `uuid` column to exactly that, and a declared `varchar(36)` reads
back as a difference that makes `migration:generate` propose rebuilding the table.

There is one migration, `InitialSchema`, and it stays one until the first release:
before that, a schema change is folded into it and the two development databases are
recreated. After the release it becomes untouchable and every change is a new file
beside it.

## Delivery

One image. The API serves `/api` and the built interface from the same origin, so
there is no CORS, no second container and no reverse proxy to configure. `/data` holds
the SQLite file and the transfer scratch space, and is declared as a volume so that a
`docker run` without `-v` does not silently lose the index on the next pull.

The pipeline runs types, lint, both test suites and the journeys, and publishes only
if all of it passes. `:main` is republished on every merge; anything that must stay
stable carries a version tag.
