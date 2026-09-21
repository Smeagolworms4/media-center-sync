# The lab

Four real media servers — two Jellyfin, two Plex — each holding a library that
disagrees with the others on purpose, and two real gateways to run them against.

```bash
make lab/media     # build the fixtures from the committed clip, about 115 MB
make lab/up        # start the servers and both gateways, and configure the servers
make lab/setup     # re-run the media server configuration on its own
make lab/services  # reprint the URLs, keys, scopes and the two gateways
make lab/link      # link the two gateways to each other and print what they agreed
make lab/pull      # pull a range of one file from the other gateway, over the link
make lab/down      # remove everything, fixtures included
```

It is not part of the development stack and never starts with it.

| Service | Port | Library | Whose | Register as |
|---|---|---|---|---|
| `jellyfin-local` | 8096 | A | ours | local |
| `plex-local` | 32400 | B | ours | local |
| `jellyfin-remote` | 8097 | C | a friend's | remote |
| `plex-remote` | 32401 | D | a friend's | remote |
| `gateway-local` | 4300 | — | ours | — |
| `gateway-remote` | 4301 | — | a friend's | — |

## Two gateways

Peer exchange cannot be proven from one node. A unit test pins the framing, a
functional test proves the endpoint answers over a real socket — and neither of them
shows two identities, two databases and two media servers agreeing on a protocol
version and moving bytes between them. Until these two existed, that had never
happened outside a test double.

The one a developer already runs is the **development stack**, and its database is not
somewhere a lab should be writing peers, media services and pulled files. So the lab
brings up both ends itself: `gateway-local` and `gateway-remote`, same image, same
code, different identity.

What makes each of them a distinct participant is its **data directory** — the Ed25519
key pair and the node identifier live there, the fingerprint is derived from the key,
and the fingerprint is the identity. Throw that directory away and the gateway comes
back as somebody else, which is worth knowing before wondering why a link that worked
yesterday is refused today.

They link on the port they serve their interface on. There is no second port: a peer
link is a WebSocket upgrade on `/api/peer/link`, next to the event stream on
`/api/events`.

```bash
make lab/link
#   gateway-local   d9b901352e8c432eb4c04bdf52acb994030150c71dccd565820861251151e38b
#   gateway-remote  c1c1817b439ad497d0aca69010c96477c5f1957783113adbe053a75a02f028b4
#
#   name          Lab friend
#   status        linked
#   link          direct at gateway-remote:4200
#   protocol      1
#   capabilities  content, catalogue, revalidate, announce, swarm
```

`lab/link` is the two calls the interface makes — each gateway is told the other's
fingerprint, then one of them dials — rather than an invitation, which is one-shot and
expiring and therefore wrong for something that has to be re-runnable.

**They run on PostgreSQL, and that is not a preference.** `better-sqlite3` is a native
binding; one compiled on a glibc workstation does not load in an Alpine container, and
the error names a missing `ld-linux-x86-64.so.2` while saying nothing about where the
install came from. The lab mounts whatever `node_modules` the repository happens to
hold, so the one engine it can rely on either way is the one whose driver is pure
JavaScript. The side effect is welcome: the lab is the only thing that routinely runs
against the engine the README says is supported.

**A gateway needs something of its own to share.** `gateway-remote` is the one to
register `jellyfin-remote` in — as *its* local service, since it is that household's
own server — and then share its libraries. Inside the lab the containers reach each
other by service name (`http://jellyfin-remote:8096`); `localhost` is the workstation,
and a service registered at a localhost URL is a service the gateway cannot reach.

### Pulling across the link

```bash
make lab/pull
#   catalogue     8 entries they let us see
#   pulled        Big Buck Bunny
#   range         0-162172 of 162173 bytes
#   received      162173 bytes in 50 ms
```

`lab/pull` asks the far end for its catalogue, picks the first entry with a file, and
pulls a range of it over the link. It goes through `PeerLinkService` rather than
through the transfer engine, and that is not laziness: the engine needs a plan, a
source and a target, and a peer's catalogue is **not imported as services and items on
our side** — the link answers `catalogue.list` and nothing in the application calls
it. That gap is real, it is the next thing peer syncing needs, and this is where it is
visible rather than assumed.

## Why it exists

Correlation, quality comparison and transfers cannot be proven against mocks. A
handler that maps a recorded payload correctly still has to survive a real server's
pagination, its idea of what a season is, the fields it leaves out, and the way it
answers a range request. Those are the parts that break, and none of them are visible
from a fixture file.

**Why four and not two.** Two servers can show that two catalogues differ. They cannot
show a season nobody local holds, a group whose quality chip has to aggregate three
sources, or a real choice of where to pull from — and those are the screens that
break. Two of the four are ours and may be written into; two are a friend's and may
only be read. Nothing in the containers says which: that is decided at registration,
which is exactly the point.

Every file is built from one committed source: thirty seconds of *Big Buck Bunny*
(Blender Foundation, CC BY 3.0 — `docker/lab/fixtures/ATTRIBUTION`), scaled and
re-encoded to the real resolution and codec the filename claims. The resolution
matters — the quality comparator reads the stream, so a file named `2160p` that is
really 720p would make the lab prove the opposite of what it appears to prove. The
single source matters for the runtime. The lab used to generate a few seconds of test
pattern per file, two copies of one film came out at 3.0 s and 4.0 s, and the
different-cut rule split them into two cards. Now every file runs for the clip's
thirty seconds, except three pairs whose runtimes are chosen on purpose (below).

`seed-media.sh` only ever creates: a path that already exists is left alone, whoever
put it there, and a file is written under a hidden name and renamed into place, so an
interrupted run never leaves a truncated file behind. No fixture may be named
*Animatrix* — the script refuses it — because the owner keeps a real eight-gigabyte
film of that name in the live lab, and a generated one would correlate with it.

## What is in it, and what each case is for

Library A is filed the way a media server renames things. Library B is filed the way a
release lands on a disk. Library C is tidy like A and yet not the same tidy — no year
on the folder, no leading zero on the season. Library D drops release names into a
folder per show. Three conventions were not enough to catch a handler that reads one
shape only; four is where the shapes stop being a coincidence.

Everything below is The Expanse unless it says otherwise.

| Case | A | B | C | D | What it should show |
|---|---|---|---|---|---|
| `S01E01` | 1080p x265 | 720p x264 | — | — | in sync — ours is better, nothing to do |
| `S01E02` | 720p x264 | 1080p x265 | — | — | outdated — theirs is better |
| `S01E03` | — | 1080p x265 | — | — | missing |
| `S01E04` | — | 2160p x265 | — | — | missing, and the odd one out in the season |
| `S01E05` | 1080p x265 | **the same bytes**, unrelated name | — | — | matched on content, not on title |
| `S01E06` | 1080p x265 | 720p x264 | — | 1080p x264 | three of the four — one chip over three sources |
| `S01E07` | 480p x264 | 720p x264 | 1080p x264 | 2160p x265 | four sources, four encodings — a real choice |
| `S02E01` | — | 1080p x265 | — | — | a season answered entirely from our own side |
| `S03E01–03` | — | — | 1080p / 1080p / 720p | — | **a season nothing local holds** |
| Cowboy Bebop `S01E01` | 720p x264 | 2160p x265, spelled apart | — | — | normalisation, then outdated |
| Samurai Champloo `S01E01` | 480p x264, 400 s | — | 480p x264, 435 s | — | **conflict** — two cuts, neither better |
| Tears of Steel | 1080p x265 | 1080p x265, spelled apart | — | — | a film we already share |
| Cosmos Laundromat | 1080p x265, 30 s | — | — | 480p x264 MKV, 180 s | **two cuts of one film** — one card, conflict |
| Elephants Dream, Sintel | — | 1080p | — | — | films only the other local holds |
| Big Buck Bunny | — | — | 1080p x264, 30 s | 2160p x265, 42 s | **a film both remotes hold and we do not**, micro-cut |

The season in A is deliberately not uniform, so the quality summary has something real
to call `mixed` rather than a tidy row that proves nothing.

**`S01E07` is the one that makes the fourth server worth its memory.** Four sources,
four resolutions, ours the worst of them. "Which source do I pull from" only becomes a
question when there is more than one answer and the obvious one is wrong; with two
servers it is never more than a formality.

**`S03` is the mirror image.** Three episodes, one source, nothing held by anything
the gateway may write into. A season card in that state has to read differently from
an empty season and from a season fully held, and there is nowhere else to see it.

**The runtime pairs pin the different-cut rule from both sides.** A difference over
two minutes, or over thirty seconds *and* over five percent of the longer runtime, is
two cuts (`QualityService.isConflicting`). Big Buck Bunny, 30 s against 42 s, is one
film: twelve seconds is far over five percent, and only the thirty-second floor keeps
it one card — a trimmed credit or a studio logo must never split a film. Cosmos
Laundromat, 30 s against 180 s, is two cuts of one film, and it is **one card in
`CONFLICT`**: both copies carry the film's real TMDB and IMDb numbers, a shared work
identifier proves they are the same work, and the runtime then decides that they are
two versions of it. The identifier decides the work; the runtime decides the version.

That used to be the opposite, and the lab is what shows it. The runtime was a veto asked
*before* the identifiers, so two cuts of a film stayed two unrelated cards and
`CONFLICT` — a state of a group — was unreachable for any film. It was also dangerous:
the state was derived only when neither encode ranked above the other, so a 2160p
extended cut read `OUTDATED` against a 1080p theatrical one, and a sync set to replace
outdated copies would have written one cut over the other. The cut is now asked before
the quality.

Samurai Champloo S01E01, 400 s against 435 s, is two cuts of one episode and reads
`CONFLICT` too. Its two copies are still encoded to rank level with each other — close
bitrates and sizes — which was once what made `CONFLICT` reachable at all. It no longer
matters for the verdict; it is kept so the pair reads `CONFLICT` under either rule, and
a regression shows. `lab/media` measures all three and refuses to finish when one lands
on the wrong side; do not tidy them to thirty seconds.

**The identical pair is still the important one.** Nothing about the two names would
let a title comparison call them the same episode with any confidence: the show is
spelled differently, the release tags differ, and only the episode number agrees. Only
the content answers — which is the whole argument for deriving an identity from the
file rather than from what it is called. It is also the case that catches a
correlation quietly built on names.

There is **exactly one** such pair across the four libraries, and `lab/media` counts
them and refuses to finish if it finds another. A fixture added later under a seed that
was already taken would come out byte-identical to an existing file, the lab would grow
a second content match nobody meant, and the case that proves content identity would
quietly stop proving it — because two extra identical files break nothing that fails.

## The library names are a fixture too

| | shows | movies |
|---|---|---|
| `jellyfin-local` | `Shows` | `Movies` |
| `plex-local` | `Shows` | `Movies` |
| `jellyfin-remote` | `Séries` | `Films` |
| `plex-remote` | `TV` | `Movies` |

Libraries of the same name are one category. So `Shows` folds two services and
`Movies` folds three, while `Séries`, `TV` and `Films` each stand alone although all
of them mean the same thing as one of the others. Both halves are the point: the merge
works, and it is a merge by name and nothing cleverer. Filter a screen by `Shows` and
the friend's episodes vanish from it while remaining in the same groups — which is
either the intended behaviour or a bug, and the lab is where that gets decided rather
than argued.

This is also why the library names live in the `Makefile` and are passed to the setup
scripts as arguments. A script that knew what to call a library could not be the same
script on all four servers, and two copies of a Jellyfin wizard is two wizards to fix
the next time Jellyfin moves one.

## Setting the servers up

**Both Jellyfin servers are configured for you.** `make lab/up` runs each wizard,
creates the account `lab` / `lab`, adds that server's libraries and mints an API key. A
lab you have to click through is a lab nobody re-creates.

The cost is that the script speaks to the startup endpoints of one Jellyfin
generation, which is why the version is pinned in the compose file. If it breaks after
a bump, the wizard changed — and the handler probably did too, which is worth knowing.

**Both Plex servers are configured too.** They run unclaimed and `ALLOWED_NETWORKS`
covers the Docker bridge, which is what lets a lab exist without a Plex account — and,
as it turns out, lets their sections be created without a token. A claimed server would
need one, and a fresh claim token on every run, since they expire in minutes.

Two things to know, both of which cost a debugging session to find:

- Plex answers `/identity` while it is still starting its plugins and refuses to create
  a section until it is not. The script waits on `startState` rather than on the port,
  which is the difference between it working and failing with a `400` that explains
  nothing.
- Jellyfin accepts a connection before it can answer, and replies `503` with an empty
  body. `curl` reports no error for that, because it is a valid HTTP response — so a
  wait on the port, or on `curl` succeeding, lets the script through seconds too early.
  Under `pipefail` the `grep` that then finds nothing aborts the run before printing a
  single line. With four servers booting at once this stopped being the rare case it
  was with one, so the wait is on the field, not on the connection.

At the end, `lab/up` prints every URL, every key and which services to register as
local and which as remote. `make lab/services` prints it again.

The lab libraries are mounted read-only, deliberately, so that a media server
reorganising the fixtures cannot make a failing run unreproducible. Registering
`jellyfin-local` and `plex-local` as local services is still right — that is what says
the gateway may pull into them — but a real transfer needs a writable path, so point
their library `localPath` at a directory of your own.

## What the lab has already caught

Two ways for Plex to have a file and never show it, both found while building this,
and neither visible from anything but a real server.

**A name whose words run together.** `BigBuckBunny.S01E05.1080p.mp4` yields no show
title to Plex's TV scanner, and the file simply never appears. The same file named
`Bunny.Big.Buck.S01E05.1080p.mp4` is picked up at once.

**A release group Plex reads as an extras suffix.** A file ending `-OTHER` is treated
as a local extra, exactly like `-trailer` or `-featurette`. Plex finds it, opens it,
analyses it, gives it an identifier — and attaches it to nothing. It is absent from the
library, no error is logged anywhere, and the only trace is a single scanner-log line
reading `found local extra`. `-OTHER` is a real release group name, so this is not a
contrived case.

Both are worth remembering before blaming a handler for a missing item: the first
thing to check when something is absent is whether the media server ever saw it.

**A library name that comes back spelled differently.** Jellyfin writes non-ASCII into
its JSON escaped: the library created as `Séries` is reported as `S\u00E9ries`. Both
setup scripts used to decide a library was already there by comparing that name with
the one they had just sent, which for this one library never matched — so every run of
a target advertised as re-runnable added another: `Séries2`, then `Séries3`, each
mounting the same directory, each appearing in the gateway as its own category. They
now recognise a library by its path, which is ASCII, is the thing that must not be
mounted twice, and does not depend on anybody's idea of an encoding.

**And one about the lab's own plumbing.** `.env` sets
`COMPOSE_PROJECT_NAME=media-center-sync`, and the makefiles export every key of `.env`
into every recipe — where an environment variable outranks the `name:` written in a
compose file. Every lab command therefore used to run against the *development stack's*
project: `make lab/down` stopped and removed the API, the interface and the database,
said so in its output, and left the lab itself running. The project name is now pinned
with `-p` in `LAB_COMPOSE`, which is the only thing that outranks the variable.

## Why the titles are real

The names are of real shows and real films, and that is the point rather than
decoration. Both servers reach their metadata agents and come back with real artwork
and real identifiers — `tvdb=280619 tmdb=63639` for The Expanse on Jellyfin,
`plex://episode/5d9c0d34e264b7001fc6d894` for `S01E05` on Plex. Without that, the lab
could exercise neither the poster wall — every card a placeholder — nor the
external-identifier strategy, which is the second most trusted signal correlation has
and the one no fixture of invented titles can reach.

The four films are open-licensed Blender shorts, so their names and their metadata are
honestly theirs. The series names carry nothing but a name.

One consequence worth expecting: the agents renumber as well as identify. Cowboy Bebop
`S01E01` comes back titled *Stray Dog Strut* on both Jellyfin and Plex, whatever the
filename says. That is a real disagreement between a release's numbering and a
provider's, both servers make it the same way, and correlating across it is the job.
