# The lab

Four real media servers — two Jellyfin, two Plex — each holding a library that
disagrees with the others on purpose.

```bash
make lab/media     # generate the fixtures, a few megabytes
make lab/up        # start all four servers and configure all four
make lab/setup     # re-run the configuration on its own
make lab/services  # reprint the URLs, keys and scopes for registration
make lab/down      # remove everything, fixtures included
```

It is not part of the development stack and never starts with it.

| Service | Port | Library | Whose | Register as |
|---|---|---|---|---|
| `jellyfin-local` | 8096 | A | ours | local |
| `plex-local` | 32400 | B | ours | local |
| `jellyfin-remote` | 8097 | C | a friend's | remote |
| `plex-remote` | 32401 | D | a friend's | remote |

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

The libraries are generated rather than downloaded: a few seconds of test pattern, at
the real resolution the filename claims. That last point matters — the quality
comparator reads the stream, so a file named `2160p` that is really 720p would make
the lab prove the opposite of what it appears to prove.

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
| Tears of Steel | 1080p x265 | 1080p x265, spelled apart | — | — | a film we already share |
| Elephants Dream, Sintel | — | 1080p | — | — | films only the other local holds |
| Big Buck Bunny | — | — | 1080p x264 | 2160p x265 | **a film both remotes hold and we do not** |

The season in A is deliberately not uniform, so the quality summary has something real
to call `mixed` rather than a tidy row that proves nothing.

**`S01E07` is the one that makes the fourth server worth its memory.** Four sources,
four resolutions, ours the worst of them. "Which source do I pull from" only becomes a
question when there is more than one answer and the obvious one is wrong; with two
servers it is never more than a formality.

**`S03` is the mirror image.** Three episodes, one source, nothing held by anything
the gateway may write into. A season card in that state has to read differently from
an empty season and from a season fully held, and there is nowhere else to see it.

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
