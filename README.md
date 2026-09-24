# Media Center Sync

[![Build](https://github.com/Smeagolworms4/media-center-sync/actions/workflows/build.yml/badge.svg)](https://github.com/Smeagolworms4/media-center-sync/actions/workflows/build.yml)
[![Image](https://img.shields.io/badge/ghcr.io-media--center--sync%3Amain-0b7285)](https://github.com/Smeagolworms4/media-center-sync/pkgs/container/media-center-sync)
[![Licence](https://img.shields.io/badge/licence-MIT-3d7a3d)](LICENSE)

A gateway that sits next to your media servers and keeps them in step with each
other — and with your friends'.

You register media services: the Jellyfin in your living room, the Plex on the NAS,
a friend's gateway across town. Media Center Sync indexes them all, works out which
items are the same media, shows you at a glance what you are missing, and pulls it
across — resumable, from several sources at once, straight into the library folder
your own server already watches.

*[Version française](README.fr.md)*

![The library: every service's shelves merged into categories, with what you are missing marked on the poster](docs/images/library.png)

Libraries of the same name become one category, however many servers they live on,
and a poster carries what it is worth knowing at a glance: whether you hold it,
where the copies are, and `x265 · 1080p` — or `mixed`, when the sources disagree.

![Media services in three bands: the servers whose folders this gateway reaches, the ones it only talks to over HTTP, and friends' gateways](docs/images/services.png)

A service whose library folders this gateway reaches is a place files can land. One it
only talks to over HTTP is a place to read from and pull out of — yours or somebody
else's, the distinction being the mount and not the ownership. The difference is stated
on the row, because it decides what a sync can do.

Whether a service's libraries are offered to your peers is a separate switch, on by
default, because the commonest case of all is an ordinary server nobody has mapped
folders for and it used to come out invisible to everybody. A friend's gateway sits in
its own band and is not edited here: what it shows, how far it reaches and whether it
may read from you are decisions that live on the peers screen.

---

## Install

One container, one volume, no database server to run.

```yaml
# compose.yaml
services:
  media-center-sync:
    image: ghcr.io/smeagolworms4/media-center-sync:main
    restart: unless-stopped
    ports:
      - 4200:4200   # the interface, the API and peer links — one port, same origin
    environment:
      # Change this. It signs the sessions, and production refuses to start without it.
      MCS_JWT_SECRET: change-me
    volumes:
      # The index, the SQLite file and the transfer scratch space.
      - mcs-data:/data
      # Your libraries. See the warning below — this is the one thing to get right.
      - /mnt/nas:/media

volumes:
  mcs-data:
```

```bash
docker compose up -d
```

Open **http://localhost:4200**. A fresh gateway has no account, so it asks you to
create the first administrator — there is deliberately no default password on
something reachable from your network. Then register your first media service and the
gateway starts indexing.

For an unattended install, set `MCS_ADMIN_USER` and `MCS_ADMIN_PASSWORD` in the
compose file and the account is created on the first start instead.

The schema is brought up to date every time the container starts, including the first,
so there is nothing to run by hand before or after an image update.

> **The `/media` mount is the one thing that has to be right.**
>
> It must point at the same files your media server sees. If Jellyfin has
> `/media/Shows` and the gateway writes somewhere else that merely looks similar,
> every transfer will succeed, the files will really be there, and your library will
> stay empty — with nothing, anywhere, reporting an error. The interface probes this
> and tells you, but it is worth getting right before the first sync.

**There is only one port.** A peer link is a WebSocket upgrade on the same port the
interface is served from, so a reverse proxy and its TLS certificate already cover
peer traffic, and there is nothing extra to forward on a router beyond what you opened
to reach the interface from outside.

If neither end is reachable from outside, a link depends on a friend both gateways
already have: that friend introduces them, and carries the bytes only if they offer
to. See [what one port does not solve](#what-one-port-does-not-solve).

### Environment

| Variable | Default | What it does |
|---|---|---|
| `MCS_JWT_SECRET` | *(none)* | Signs sessions. **Required in production** — there is deliberately no default. |
| `MCS_MEDIA_ROOT` | `/media` | Where your libraries are mounted, as the gateway sees them. |
| `API_PORT` | `4200` | Interface, API and peer links. There is no second port. |
| `DB_TYPE` | `sqlite` | `sqlite` or `postgres`. |
| `DB_FILE` | `/data/media-center-sync.db` | SQLite file. |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | — | Read only when `DB_TYPE=postgres`. |
| `REDIS_HOST` `REDIS_PORT` | *(empty)* | A Redis or Valkey you already run. Set, the image starts none of its own. |
| `REDIS_SOCKET` | *(set by the image)* | Unix socket of the cache. The entrypoint exports it for the embedded one; it wins over `REDIS_HOST`. |
| `MCS_EMBEDDED_CACHE` | `1` | `0` starts no cache process at all and the gateway keeps its live transfer state in memory. |
| `MCS_CACHE_MAXMEMORY` | `128mb` | Ceiling of the embedded cache. Past it, the least recently used keys go. |
| `MCS_CACHE_SOCKET` | `/data/cache.sock` | Where the embedded cache listens. Worth moving only if `/data` is a filesystem that has no sockets. |
| `MCS_TRANSFER_ROOT` | `/data/transfer` | Where pieces accumulate before a file is placed. |
| `MCS_CORS_ORIGINS` | *(empty)* | Comma-separated. Not needed when the interface is served by the API. |
| `MCS_ADMIN_USER` `MCS_ADMIN_PASSWORD` | *(none)* | An unattended first account. Unset, the interface asks for one. |
| `DB_MIGRATE_ON_START` | `true` | Bring the schema up to date at startup. Turn it off where a deployment applies migrations itself. |

SQLite and a cache inside the image are the defaults on purpose: this is a gateway
somebody self-hosts next to their media server, not a multi-tenant service. Neither a
PostgreSQL nor a Redis container should have to be kept alive to pull a few episodes,
so the image carries a three-megabyte Valkey and starts it on a unix socket under
`/data` — nothing to add to a `docker run`, and nothing listening on the host network.

The cache is not the truth: resume points and the library index are in the database,
and what lives here is the live state of transfers. `MCS_EMBEDDED_CACHE=0` therefore
still works and keeps that state in the process — correct on a single node, and the
smallest thing that runs. What it costs is the rate accounting shared between the
workers of one transfer, which is what makes a multi-connection transfer settle rather
than fight itself. `REDIS_HOST` goes the other way and hands the cache to a server you
already run, which is what several gateways sharing a queue need. All three remain one
environment variable away, and the migrations are the same either way.

### Behind a reverse proxy

The API serves the interface, `/api` and the peer endpoint on the same origin, so
there is nothing to split. Two things must survive the hop: the **WebSocket upgrade**,
on `/api/events` — without which every progress bar stays at zero while the files
arrive perfectly well — and on `/api/peer/link`, which is where other gateways
connect; and a **generous read timeout**, because a transfer can run for hours.

The configuration below covers both, because it passes the upgrade for every path.
That is also the whole of the TLS story for peers: the certificate you already have
for the interface is the one a friend's gateway validates.

```nginx
location / {
    proxy_pass http://127.0.0.1:4200;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

---

## Table of contents

- [Install](#install)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
  - [Services, local and remote](#services-local-and-remote)
  - [Adding a Plex server without knowing its address](#adding-a-plex-server-without-knowing-its-address)
  - [Indexing, and why the gateway caches](#indexing-and-why-the-gateway-caches)
  - [Correlation: what is the same media](#correlation-what-is-the-same-media)
  - [When the library is organised in a way your server misreads](#when-the-library-is-organised-in-a-way-your-server-misreads)
  - [Guessing where something belongs, and asking first](#guessing-where-something-belongs-and-asking-first)
  - [Quality at a glance](#quality-at-a-glance)
  - [Syncing](#syncing)
  - [Transfers](#transfers)
  - [When a transfer goes wrong](#when-a-transfer-goes-wrong)
  - [Peers, friends, and friends of friends](#peers-friends-and-friends-of-friends)
  - [What one port does not solve](#what-one-port-does-not-solve)
  - [What the household asked for](#what-the-household-asked-for)
  - [Finding what nobody you know holds](#finding-what-nobody-you-know-holds)
  - [Sharing](#sharing)
  - [Signing in](#signing-in)
- [Development](#development)
- [Testing](#testing)
  - [The lab](#the-lab)
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
  in sync, missing, outdated, conflicting, syncing, local only, unknown — plus the two
  that cover a file the gateway has just put on the disk, *downloaded — resyncing*
  while the media server has not indexed it yet, and *never indexed* once it is clear
  that it never will.
- **Summarises quality** per series or season — `x265 · 1080p`, or `mixed` with every
  variant listed in the tooltip, because a library is rarely uniform and a single
  arbitrary codec would be a summary that lies.
- **Runs syncs**, one-off or scheduled, that pull what is missing into the right
  folder with the right name, metadata and artwork included.
- **Transfers properly**: chunked, resumable, several connections per source, several
  sources per file, pause and resume, live progress, per-piece verification and
  targeted repair.
- **Links gateways peer to peer**, directly when the network allows it and through an
  introduction from a friend they already have when it does not, with
  friend-of-a-friend discovery so several people holding the same file can feed one
  transfer.
- **Reads what the household asked for**, from a Seerr, and says of each ask whether this
  gateway already holds it — all of it, some of it, or none — so the list can be acted on.
  It fetches nothing on that basis: it suggests a search and somebody presses it.
- **Searches an indexer for what nobody you know holds**, groups the answers by what they
  actually are, works out how to cover a gap from them — a season rebuilt out of single
  episodes, or only the missing files taken out of a pack — and drives a torrent client to
  fetch it, keeping it seeding and copying the files into the library.
- **Orders those answers the way the household would**: resolution, codec and group, as
  ordered lists whose own order counts, set globally, per category, or for the one series
  that needs its own.
- **Suggests where a media belongs** — anime, cartoons, animated films, concerts — with
  the evidence that made it say so, and never files anything on the strength of a guess.
- **Lets you decide what you share**, per library, with whom, and at what bandwidth.

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

### Adding a Plex server without knowing its address

Nobody knows the address of their Plex server; plex.tv does. So choosing Plex in "Add a
service" leads with **Sign in with Plex**: plex.tv opens in a new tab, you sign in there
and allow Media Center Sync, and the dialog — which has been waiting — lists every
server the account reaches, yours and those friends share with you, each already tried
from the gateway. Tick the ones you want. The address form is still one click away for a
server not linked to plex.tv.

- **Your password never reaches the gateway.** This is Plex's PIN flow: you approve on
  plex.tv's own page and the gateway only receives an account token, which it keeps
  like its other credentials — never returned by any route.
- **Local network first, the relay last.** Each server's addresses are tried at once and
  the best one that answers *as that server* wins: a LAN address, then the server's
  direct HTTPS name, and Plex's relay only when nothing else answered. The relay is
  capped by Plex — fine for browsing, a crawl for pulling a film — so a service reached
  only through it says so on the services screen. An address that answers as another
  machine (a stale IP now handed to some other box) is refused.
- **It follows the server when it moves.** The server's identity at plex.tv is kept
  with the service. When the stored address stops answering, the next check or refresh
  asks plex.tv where the server is now instead of reporting it down.
- **A friend's server comes in as theirs**: never a destination for a pull, and not
  offered on to your own peers unless you turn that on.

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
4. **absolute numbering**, for a show published as one continuous run against the same
   show cut into seasons;
5. **normalised title** and year, scored by similarity;
6. **path**.

Each match is stored as its own row with the strategy and a confidence between 0 and
1, so a wrong correlation can be explained and undone rather than being an
unaccountable fact. Below the configured threshold a match is *proposed*, not applied.

Items are never merged. The same episode held by three friends is three rows in the
index — merging them would mean choosing whose title, whose artwork and whose file
size to keep, and losing exactly the differences a sync exists to show.

#### One continuous run against seasons

Anime is routinely published straight through — episode 1 to 291 — while the same show
elsewhere is filed as nine seasons. `E153` and `S06E12` then look like two different
things, and the gateway calls missing what you already own under another numbering.

An absolute number can only be turned into a season and an episode with **that show's**
season lengths, and there is no formula for them. So they are read off the side that
*is* split into seasons, exactly as this gateway has already indexed it — never
guessed. Before a single episode is paired, all of this has to hold:

- the two sides plainly use different conventions: one has a single season number, or
  none, and its highest episode number runs past the longest season the other side
  actually has;
- the split side is contiguous from season 1 and every season is complete, because a
  hole makes that season's length unknowable and shifts every season after it;
- the two account for the same show end to end — the season lengths add up to the
  highest absolute number.

Two sides that both number by season and simply disagree are left disagreeing. There
the numbers are the evidence, they say one of the episodes is missing, and a conversion
that "fixed" that would file the wrong episode under the right name for ever. Specials
and season 0 are left out of the arithmetic on both sides for the same reason.

The pair is recorded as its own strategy, `absolute_episode`, so somebody looking at a
correlation that turned out wrong can see at a glance whether a server said it or
arithmetic did. An episode identifier that genuinely names *that* episode still decides
first, whatever the numbering says — and one that appears on more than one episode of a
show is the show's, not the episode's, and proves nothing.

### When the library is organised in a way your server misreads

The gateway mirrors what your media servers declare; it cannot repair one of them and
does not try. It can notice two things that are silent, expensive to work out alone,
and nowhere else reported:

- **A library root one level too high.** Shows at
  `/media/SeriesTV/Marvel Comics/Series TV/<show>/…` with the library root at
  `/media/SeriesTV` make Jellyfin take `Marvel Comics/Series TV` for a *series* and
  every show beneath it for one of its *seasons*. Its season list then reads "Season 1
  … Season 20, Agatha All Along, Agent Carter, Agents of SHIELD, Cloak and Dagger", and
  the shows under it are invisible. A series whose seasons are named like show titles,
  or which claims more seasons than a show plausibly runs for, is said so — with the
  series named, the season names quoted, and the repair spelled out: add the deeper
  folder as a library root, or give the library a content type. It is worded as a
  suspicion to check and never as a verdict, because some real shows do name their
  seasons, and it can be dismissed for good.
- **Nothing mounted.** `missing` means "known elsewhere, not held here", which is true
  of every single row when no server has its folders declared — thirty-one thousand of
  thirty-one thousand two hundred and sixty-five on one development gateway. The
  library and the dashboard say so in one line, with the way to fix it, and the line
  goes on its own the moment one mapping exists. It has no dismissal for that reason:
  it is the one sentence that explains the whole screen.

### Guessing where something belongs, and asking first

Categories come from library names, so a household with an anime shelf and a cartoon shelf
has told the gateway something useful without filling in a form. From there it can look at
a media — its genres, its studio, its original language, the release name, the folder it
sits in — and say *this looks like an anime*, with the evidence that made it say so.

It is a **proposal, never a move**. Accepting one performs exactly the reassignment you
would have made by choosing the library yourself, through the same single mechanism, so a
media that moved moved for a reason that is on the record in one place. And the evidence is
shown rather than hidden behind a disclosure triangle, for a reason worth stating: a
suggestion nobody can check is one people learn to accept without reading, and then it is
automatic after all, by a route nobody chose.

It abstains rather than guesses. Nothing is proposed on a single observation, nothing is
proposed without something saying what the media actually *is* — a folder name only says
where somebody already put it — and when it is plainly animation with nothing trustworthy
saying where it came from, it says so instead of tossing a coin between two shelves that
answer the same question. A documentary about animation is not animation, and a
live-action film with a cartoon character in its title is not a cartoon.

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

**Peers are introduced by the intermediaries they already have.** There is no server
in the middle, no address to look up and nothing to configure: a gateway dials the
address it last knew, and failing that asks a friend both ends have to introduce it.
The friend that told you this peer existed is asked first — it is how you know they
exist at all — and if that one is offline a couple of your other linked friends are
tried, and then the attempt stops rather than working through your whole list while a
screen waits.

The one case with nobody in the middle is the very first peer, and the invitation is
what covers it: a code carrying the fingerprint, **the issuing gateway's own address**,
and a one-shot secret, handed over out of band. It expires, and it burns on use. An
invitation that never expired would be a credential left in a chat log, and whoever
found it would be a friend as far as the gateway is concerned. The address in it is the
sender's own — it names nobody else, and there is nothing there for anybody to run.

A linked friend can tell you that *one of their* peers also holds a file you are
pulling. That friend of a friend is reachable and useful — more bandwidth, another
source — but they are not someone you invited, the interface says so, and the sharing
rules can exclude them entirely.

**The friend in the middle does not carry the bytes unless they have agreed to.** They
sign a short-lived introduction — two minutes, naming who may present it and which
gateway it opens, and never naming a media — you hand it to the holder as a header on
the upgrade, and the holder checks it against the key it already has for its own peer.
From then on the two of you talk directly and the introducer can go offline. That is
what happens whenever either end can be dialled at all, and it is what you want:
nobody in the middle, nobody's upload but your own.

**When neither end can be dialled, that same friend can carry the link.** It is a
switch on their gateway, off until somebody turns it on, and turning it on is the
promise: only then is the capability advertised, and only then does a dial fall through
to it. It costs them their upload for a transfer they get nothing from, and it is not
private — nothing is encrypted above the connection, so their machine really does see
the bytes. The peers screen says so on the row rather than showing a word. They carry
only for two peers they introduced themselves, four links at a time, and the bytes come
out of their own upload cap rather than out of a budget of their own.

Relaying stays real for a remote Jellyfin or Plex somebody shares, which is a different
arrangement again: that server does not speak this protocol and has never heard of you,
so standing in front of it is the whole point rather than a fallback.

Nobody is asked to approve an introduction, and that is deliberate: **how far
introductions travel is the agreement**. The gateway's reach and each peer's own limit
decide how far away somebody may be and still open a link to you, so shortening either
one narrows who can reach you rather than tuning a search. Whether a peer met this way
stays in your list afterwards is one switch — off by default, so a link opened for a
transfer closes with it.

### What one port does not solve

One port is the whole networking story **when at least one of the two ends can be
reached from outside** — a forwarded port, a public host, a tunnel, a reverse proxy
with a name. Whichever end is reachable is dialled, the other dials it, and the link
is the same either way.

It does nothing for the case where **both** gateways are behind NAT with nothing
forwarded. A WebSocket needs somebody to connect *to*, and there is nobody. A friend
both ends already have can introduce them, which gets past "they have never heard of
you" but not past "there is no socket to open". That friend can also carry the link
itself, if their household turned the switch on — the bytes then travel back down the
socket the holder opened to them, inside the same connection that carries the ordinary
peer traffic, because there is no second one to open.

**So two gateways behind two routers with no friend in common cannot be connected.**
That is a stated limit rather than a setting somebody forgot to fill in, and the peers
screen says so on the row: forwarding the interface's port on one of the two routers
is what opens the link without asking anything of anybody. There is no second port to
open.

The answer to the general case is **WebRTC** — ICE, STUN to discover each end's public
address, TURN when it cannot be discovered, signalled over the peer link that already
carries introductions. It is **not implemented**, and that is the honest state of it.

### What the household asked for

Nobody asks a sync gateway for a film. They ask in Seerr — or Overseerr, or Jellyseerr,
which are one API and are read the same way — because that is the screen with a search box
that everybody in the house already has on their phone. So a request source is read here as
a **source of information** and nothing else: it says what people want, and this gateway
says what it can do about it.

The point of the screen is the verdict. A household opens forty asks over a year and most
of them arrive by some other route, so a list of open requests with no idea which are
already satisfied is a list nobody acts on. Each ask is matched to the catalogue on its
metadata identifiers and comes back as one of three answers, kept distinct on purpose: we
hold all of this, we hold some of it, we have never heard of it. The middle one is the one
that matters — a request for seasons two and three is not answered by holding two, and a
screen that said it was would close the ask on half of it.

**A request row carries no title.** This is not a quirk to work around quietly; it is
worth knowing, because it is what the screen would otherwise be. Seerr's request rows are
identifiers and statuses and nothing readable, so the works nobody here holds — which is
exactly what a request usually is — arrive as a column of numbers. The gateway therefore
asks the source itself what each one is, once per unnamed ask, and only for the ones the
catalogue cannot name: a listing that asked about every row would spend a round trip each
to re-learn titles it already has.

Two things can then be pressed:

- **Mark it answered**, which is how an ask stops being open in the place the household
  looks. Offered only when saying so would be true, and refused by the API as well as
  hidden by the interface — told an ask is complete, people stop asking, so closing one
  that delivered nothing ends the asking and delivers nothing. The route takes a
  deliberate `force` for the copy that exists on a shelf this catalogue was never told
  about.
- **Search for it.** Every unsatisfied ask carries the search it implies — the work's
  title, the seasons actually missing — worked out and handed over. Pressing it is a
  person's decision, and that separation is the product's central choice about this
  feature rather than an unfinished edge: wired to a download, an account on somebody
  else's Seerr would spend this gateway's disk.

A media of ours can also be pushed the other way, which is how "we are following this
here" gets said where the household looks.

### Finding what nobody you know holds

A peer is the best source there is, and sometimes nobody you know has it. An **indexer**
(Prowlarr) is read for releases and a **download client** (qBittorrent) moves the bytes,
both behind the same decorator-and-registry pattern as the media handlers — another of
either costs one class and one enum value.

What makes this more than a search box is that a tracker's answers and a household's
question are shaped differently. You want season two; the tracker has episode one in three
qualities from three groups, a season pack, a run of three episodes under a single info
hash, and the complete series in subdirectories. So results are **grouped by what they
actually are** — the same release listed by two trackers is one row, and codec, resolution
and group are part of what makes two listings different rather than folded together — and
the gateway works out coverage from there: a season can be **rebuilt out of single
episodes**, and conversely a season pack can be told to fetch **only the files that are
missing**, through the client's own per-file selection. The download **stays seeding** and
the files are copied into the library, progress and all, which is visible in the transfers
queue beside every other transfer — only the ones this gateway started, with the same
choice of destination a pull has.

Not every suggestion is a tracker's. **A copy on a peer is an answer to the same
question**, and a better one — the file exists, and its quality was measured on the file
rather than read off a name — so peer copies come back in the same ordered list, above the
tracker rows, and a coverage plan that cannot fill a gap says which of them a friend is
holding instead of calling it unobtainable. The two kinds are deliberately **not** dressed
as one shape: a peer copy has no seeders and no magnet, a release has no service and no
path, and the row's own action follows from which it is. Handing a peer copy to a torrent
client would be accepted by the client, move nothing, and report success on every screen —
which is why refusing it is a rule with a test rather than a happy accident.

Order is a household's opinion, so it is a setting rather than a heuristic: resolution,
codec and group, each an ordered list of values, and **the order of the dimensions counts
too**. Preferring 1080p over 2160p and then x265 over x264 is a different answer from
preferring x265 first. It is set once globally, overridden per category, and overridden
again for the one series that needs it — a media carrying its own order says so on its own
page, with one press to cancel it, because the alternative is somebody wondering for a
year why that one show searches differently from every other.

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

### The lab

`make lab/up` builds the thing all three layers eventually have to be believed against:
a complete household on one machine, configured, with nothing reaching the internet.

- **Four media servers** — two Jellyfin and two Plex, one pair yours and one pair a
  friend's. The friend's call their libraries `Séries` and `Films`, because a library
  name that is not ASCII and a correlation across two naming schemes are two of the
  things this exists to break.
- **Three gateways** on one bridge. Two prove that a peer link works; the third is what
  makes the questions about peers answerable at all — which of two peers that both hold
  a file is offered, what a screen does while one is down and another answers, whether a
  lookup picks the right row in a list with more than one element in it.
- **An indexer and a swarm.** Prowlarr, holding a Torznab indexer that lives in this
  repository: a fixed fixture of releases chosen for the names a parser has to get right,
  from three qualities of one episode to a complete series in subdirectories. The same
  process answers `/announce`, and every release points at a real torrent of real lab
  media that a second qBittorrent is really seeding to the first. So a search answers the
  same thing on every machine and on every run, and a grab of any of it completes.
- **A request source.** Seerr, set up unattended against the lab's own Jellyfin, with two
  asks already open. Neither of them carries a title — which is not a quirk of the lab but
  what the API is, and the reason the gateway looks a work up separately before it can put
  anything on a screen.

Why go to this length: the failures this product actually has are not exceptions, they
are **operations that succeed while doing nothing**. A search that answers an empty list
because it asked the wrong category. A magnet handed to a client that fetches nothing and
reports no error. A transfer that finishes with every file written somewhere nobody looks.
None of those throw, none appear in a log, and a test suite built on mocks agrees with all
of them. Three of them were found by this lab and by nothing else.

```bash
make lab/up             # everything, configured, about four minutes the first time
make lab/link           # link the three gateways and report what each agreed on
make lab/register       # register the four servers in a gateway, mapped and scanned
make lab/services       # reprint the addresses, keys and sign-ins
make lab/torrents-check # search, grab, download, and compare the bytes that landed
make lab/requests-check # read Seerr's asks through the gateway and check every verdict
make lab/down           # stop it; the configuration survives
```

The lab is committed, and **what it becomes when you run it is not**: everything under
`var/` — the generated media, the servers' own databases, the keys, the torrents — is
state, and none of it belongs in a commit.

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
