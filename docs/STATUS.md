# What is built, and what is not

An honest inventory. A feature list that does not distinguish between finished,
partial and sketched is a feature list nobody can plan against.

Three states are used:

- **built** — implemented and covered by tests;
- **partial** — the structure is there and works, with a named limit;
- **seam** — a deliberate interface with a minimal implementation behind it, marked as
  such in the code.

## Services and indexing

| | |
|---|---|
| Register any number of services, local and remote | built |
| Jellyfin handler | built |
| Plex handler | built |
| Adding a service type without touching anything else | built — one class plus one enum value |
| Probe before registering | built |
| Full scan | built |
| Incremental refresh on what a service reports as new | built |
| Scheduled full rescan, manual rescan | built |
| The interface reads the gateway's index, never a media server | built |
| Short-lived cache in front of service calls | built — in-process, Redis optional |

## Correlation

| | |
|---|---|
| Checksum, external id, season/episode, normalised title, path | built |
| Confidence score and a threshold below which a match is proposed | built |
| Matches stored with their strategy, confirmable and undoable | built |
| Same content under names that disagree, flagged rather than renumbered | built |
| Metadata provider identifiers | built — but the lab cannot exercise them, see `LAB.md` |

## Quality

| | |
|---|---|
| Aggregated summary per node, `mixed` when children disagree | built |
| Every variant with counts and sizes, for the tooltip | built |
| Better-than comparison: resolution, codec, bitrate, then size | built |
| HDR and channel counts | partial — read off the filename, shown, never ranked on |

## Syncing

| | |
|---|---|
| Plans: manual, scheduled, on new | built |
| Ordered sources, falling back to the configured priority | built |
| Preview that runs the same planning code as the run | built |
| Placement: beside the existing copy, a default library, a fixed path | built |
| Naming: source, imitate the local library, standard | built |
| Artwork, subtitles and `.nfo` pulled alongside | built |
| Jobs with counters, cancellable | built |

## Transfers

| | |
|---|---|
| Chunked, with per-piece state in the database | built |
| Resume across restarts | built |
| Several connections against one source | built |
| Several sources for one file, chosen by measured rate | built |
| Pause, resume, cancel, retry | built |
| Rate limits, bounded parallelism | built |
| Per-piece verification and targeted repair | built |
| Verifying an already-placed file | built |
| Ask-the-far-end revalidation, and the decision it drives | built |
| Live progress, pushed and batched | built |

## Peers

| | |
|---|---|
| Identity by public key fingerprint | built |
| One-shot expiring invitations | built |
| Direct link | built |
| Relayed link through the rendezvous | built |
| Friend-of-a-friend discovery | built |
| Sharing per library, with allow and deny lists | built |
| Catalogue-only sharing | built |
| Per-library bandwidth caps | built |
| Audit: what would this peer see of me | built |
| **The rendezvous server itself** | **not included** — the gateway is a client of one |

## Swarm

The peer set, rarest-first piece selection, request pipelining and failure accounting
are real and tested. The wire behind them is a seam: `SwarmWire`, implemented as point
to point requests over the authenticated peer link.

| | |
|---|---|
| Content identity computed independently by each gateway | built |
| Torrent generated from the file, never stored | built |
| Several peers feeding one transfer | built |
| Rarest-first selection | partial — informs prefetch order, not yet request order |
| Choke, unchoke, tit-for-tat | seam — absent, marked in the code |
| Endgame mode | seam — absent |
| Seeding pieces back out | seam — absent |

A gateway can therefore pull from several peers at once today; it does not yet behave
as a good citizen of a swarm it did not start. That distinction is deliberate and
written where it matters.

## Accounts

| | |
|---|---|
| Sign in through a registered media service | built |
| Internal accounts | built |
| Rights per route, roles as bundles of rights | built |
| Sessions in the database, immediate sign-out | built |
| An external identity provider | seam — the provider interface exists, no implementation |

## Operations

| | |
|---|---|
| One production image, API and interface together | built |
| SQLite by default, PostgreSQL by environment variable | built — both verified |
| In-process cache by default, Redis optional | built |
| Migrations that run on both engines | built |
| Health check that fails when the database is unreachable | built |
| Library mount checking | built |
| A lab with two real media servers | built — see `LAB.md` |
| Unit, functional and browser journeys, all in the pipeline | built |
