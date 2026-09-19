# The lab

Two real media servers, one Jellyfin and one Plex, each holding a library that
disagrees with the other on purpose.

```bash
make lab/media   # generate the fixtures, about a megabyte
make lab/up      # start both servers and configure Jellyfin
make lab/setup   # re-run the configuration on its own
make lab/down    # remove everything, fixtures included
```

It is not part of the development stack and never starts with it.

## Why it exists

Correlation, quality comparison and transfers cannot be proven against mocks. A
handler that maps a recorded payload correctly still has to survive a real server's
pagination, its idea of what a season is, the fields it leaves out, and the way it
answers a range request. Those are the parts that break, and none of them are visible
from a fixture file.

The libraries are generated rather than downloaded: a few seconds of test pattern, at
the real resolution the filename claims. That last point matters — the quality
comparator reads the stream, so a file named `2160p` that is really 720p would make
the lab prove the opposite of what it appears to prove.

## What is in it, and what each case is for

Library A is filed the way a media server renames things. Library B is filed the way a
release lands on a disk.

| Case | A | B | What it should show |
|---|---|---|---|
| `S01E01` | 1080p x265 | 720p x264 | in sync — ours is better, nothing to do |
| `S01E02` | 720p x264 | 1080p x265 | outdated — theirs is better |
| `S01E03` | — | 1080p x265 | missing |
| `S01E04` | — | 2160p x265 | missing, and the odd one out in the season |
| `S01E05` | 1080p x265 | **the same bytes**, unrelated name | matched on content, not on title |
| Sintel | 720p x264 | 2160p x265, differently spelled | normalisation, then outdated |
| Films | one shared, one only theirs | | a library that is not a show |

The season in A is deliberately not uniform, so the quality summary has something real
to call `mixed` rather than a tidy row that proves nothing.

**The identical pair is the important one.** Nothing about the two names would let a
title comparison call them the same episode with any confidence: the show is spelled
differently, the release tags differ, and only the episode number agrees. Only the
content answers — which is the whole argument for deriving an identity from the file
rather than from what it is called. It is also the case that catches a correlation
quietly built on names: a run where `S01E05` comes out as two unrelated items has a
bug that the other six cases would never have revealed.

## Setting the servers up

**Jellyfin is configured for you.** `make lab/up` runs the wizard, creates the account
`lab` / `lab`, adds the two libraries and mints an API key, then prints it. A lab you
have to click through is a lab nobody re-creates.

The cost is that the script speaks to the startup endpoints of one Jellyfin
generation, which is why the version is pinned in the compose file. If it breaks after
a bump, the wizard changed — and the handler probably did too, which is worth knowing.

**Plex still needs a hand**, at `http://localhost:32400/web`: the container runs
unclaimed, which is what lets it answer on the local network without a Plex account,
but an unclaimed server has no token to script against. Add two libraries pointing at
`/media/shows` and `/media/movies`.

Then register both in the gateway as **remote** services — the lab libraries are
mounted read-only, deliberately, so that a media server reorganising the fixtures
cannot make a failing run unreproducible. To exercise a real pull, add a third
**local** library the gateway can write into.

## What it will not tell you

The generated files carry no metadata provider identifiers, so neither server will
find a TVDB or TMDB match for them. Correlation in the lab therefore falls back to
content and to normalised titles, which is the interesting half but not all of it —
the external-identifier strategy is covered by unit tests instead, and is the one
strategy that cannot be exercised without hitting a real metadata provider.
