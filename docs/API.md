# HTTP surface

Every path below is prefixed with `/api`. Shapes come from `@mcs/shared`; this file
says which shape appears where, and nothing else — when the two disagree, the package
wins.

Conventions:

- **Errors are keys.** A failure answers `{ statusCode, message: 'error.some.key', error }`
  and the interface decides the words. Validation failures answer
  `{ statusCode, message: string[], error }`, each entry prefixed with the property it
  concerns, which is what lets the form layer put it under the right input.
- **Lists that can grow are paginated** and answer `ResultList<T>`. Lists that are
  bounded by the number of things somebody registered — providers, services,
  libraries, peers, sync plans — answer a bare array. Paginating six rows is a
  wrapper nobody reads around a list nobody scrolls.
- **Rights**, not roles: each route names the `Right` it needs. A route with no right
  listed is public, deliberately.
- Identifiers are UUIDs. Times are ISO 8601 strings in UTC.

## Sessions

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/auth/setup` | — | `SetupState` | *public* |
| POST | `/auth/setup` | `SetupDto` | `TokenPair` | *public* |
| GET | `/auth/providers` | — | `AuthProvider[]` | *public* |
| POST | `/auth/login` | `LoginDto` | `TokenPair` | *public* |
| POST | `/auth/refresh` | `RefreshDto` | `TokenPair` | *public* |
| POST | `/auth/logout` | — | `204` | *session* |
| GET | `/auth/me` | — | `SessionUser` | *session* |
| POST | `/auth/password` | `ChangePasswordDto` | `204` | *session* |

`/auth/setup` is the one moment this API lets somebody in without credentials, and the
only thing that makes it safe is that it refuses the instant any account exists — a
guest account is enough to close it, because the question is whether this gateway has
been claimed, not whether it has an administrator. A fresh install has no account at
all: shipping `admin` / `admin` would put a default password on something reachable
from the network, and printing a generated one in the logs assumes somebody reads logs,
which whoever just ran `docker compose up` in a web interface did not. An unattended
install sets `MCS_ADMIN_USER` and `MCS_ADMIN_PASSWORD` instead and never passes through
here.

`provider` in `LoginDto` is one of the keys `/auth/providers` returned: `internal`, or
`service:<uuid>` for a registered media service. The interface never guesses it — which
ways in exist depends on what has been registered, and a gateway with no service yet
must still let its administrator in.

A provider whose `credentials` is false is a redirect flow: the interface sends the
browser to `redirectUrl` instead of showing a form.

## Live events

| Path | Protocol |
|---|---|
| `/events?token=<accessToken>` | WebSocket, text frames of `ServerEvent` |

Both WebSocket endpoints — this one and `/peer/link` below — are upgrades on the HTTP
port the API and the interface are served from. There is no second port anywhere in
this application, and an upgrade to a path neither endpoint claims is refused with a
`404` rather than left half open.

The token travels as a query parameter because a browser cannot set a header on a
WebSocket handshake. It is the same short-lived access token, and the connection is
closed when it expires — the interface reconnects with a fresh one.

Progress is pushed, never polled, and `transfer.progress` frames are batched: one
frame carries every moving transfer, at a fixed interval. One frame per chunk would be
thousands a second on a fast link.

## Media services

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/services` | — | `MediaService[]` | `SERVICE_READ` |
| POST | `/services` | `CreateMediaServiceDto` | `MediaService` | `SERVICE_MANAGE` |
| GET | `/services/:id` | — | `MediaService` | `SERVICE_READ` |
| PATCH | `/services/:id` | `UpdateMediaServiceDto` | `MediaService` | `SERVICE_MANAGE` |
| DELETE | `/services/:id` | — | `204` | `SERVICE_MANAGE` |
| POST | `/services/probe` | `ProbeMediaServiceDto` | `MediaServiceProbe` | `SERVICE_MANAGE` |
| POST | `/services/:id/probe` | — | `MediaServiceProbe` | `SERVICE_READ` |
| POST | `/services/:id/scan` | — | `202` | `SERVICE_MANAGE` |
| POST | `/services/:id/refresh` | — | `202` | `SERVICE_READ` |
| GET | `/services/:id/libraries` | — | `Library[]` | `LIBRARY_READ` |

`POST /services/probe` tests a connection **before** it is registered, which is what
lets the form tell somebody their token is wrong while they are still typing it rather
than after they have saved a service that does not work.

Scans and refreshes answer `202` and report through `scan.progress` events: a full
scan of a large library takes minutes, and a request that waited for it would time out
somewhere in between.

Secrets are write-only. A token sent in a create or update is never returned by any
route — a token that leaks through a list opens somebody's whole library, and nothing
in the response would say so.

`remoteRoot` and `localRoot` are one statement in two halves: the prefix the service
reports about itself, and the same directory as this gateway reaches it. Stated once,
every library under the service derives its own local path from them, which is what a
server with six libraries used to spell out six times. They are refused one at a time —
either half on its own derives nothing while leaving a service that looks configured —
and both must be absolute, for the reason any path stored here must be: a relative one
designates a different directory in the container, in a development shell and in a
command. Sending both as null withdraws the mapping.

The mapping also decides `filesMounted`, and through it `mode`. Whether this gateway
reaches a service's files is **derived**, never declared: it is true once a root is
stated here or a library under the service carries a path of its own, and it is
re-derived on every registration, probe, mapping change and library path change. A
service registered before anybody mapped its folders is `remote` and becomes `local`
the moment the mapping lands, without being re-registered. Only a `local` service can
be a destination — a pull has to land where the media server actually scans.

**A registration that stands for a linked peer cannot be updated at all**: `PATCH`
answers `409 error.service.peer_not_editable`. Their files are on their machine, so a
root mapping here could never resolve while making the service look configured; the
link authenticates by key fingerprint, so there is no token; and the address is
`peer://<uuid>`. The name, the hop limit, forbidding reading, removing and banning are
all peer routes — the row follows the peer rather than being configured beside it.
Probing, scanning and refreshing it still work.

`shared` is the other half and is the opposite kind of thing: a decision somebody
declares, absent means `true`. It says whether this service's libraries are offered to
peers, and carries no level of its own — see **Sharing**. The two used to be one
`scope` column with the values `local` and `remote`, which read as a statement about
the network and therefore answered both questions wrongly at once.

## Libraries

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/libraries` | — | `Library[]` | `LIBRARY_READ` |
| GET | `/libraries/:id` | — | `Library` | `LIBRARY_READ` |
| PATCH | `/libraries/:id` | `UpdateLibraryDto` | `Library` | `LIBRARY_MANAGE` |
| GET | `/libraries/categories` | — | `MediaCategory[]` | `LIBRARY_READ` |
| GET | `/libraries/check` | — | `LibraryCheck[]` | `LIBRARY_READ` |
| GET | `/libraries/keywords` | — | `CategoryKeyword[]` | `LIBRARY_READ` |
| POST | `/libraries/categories/:key/keywords` | `AddCategoryKeywordDto` | `CategoryKeyword` | `LIBRARY_MANAGE` |
| PATCH | `/libraries/keywords/:id` | `MoveCategoryKeywordDto` | `CategoryKeyword` | `LIBRARY_MANAGE` |
| DELETE | `/libraries/keywords/:id` | — | `204` | `LIBRARY_MANAGE` |

**Categories are what a library screen is built from.** A household with two servers
has two libraries called `Shows`, and a friend makes a third; they are one category to
whoever is looking at them, and three bands all called `Shows` shows somebody the
plumbing rather than their media. So libraries merge on the name a person reads — the
alias when one was set, compared without case or accents, because `Animes` and `animés`
are not two categories. Aliasing one of two identically named libraries is therefore
how somebody separates them on purpose.

The lowest `position` among the merged libraries decides the order categories appear
in, and answers which category wins when the same media is filed in two of them.
`MediaGroupQuery.categoryKey` filters a browse to one category; `libraryId` still
names exactly one library, which is a different question and worth keeping.

**A keyword is a name plugged into one of our categories.** A friend's gateway brings
twenty shelves — `Séries`, `Series TV`, `TV`, `Émissions TV` — and folding each of them
into our `Shows` meant typing the same alias once per library, again for every peer that
ever appears. A keyword says it once: any library whose name folds to it is read as part
of that category, on whoever's server it sits, from the moment it is discovered.

Matching is an exact comparison of the folded form and nothing more. Case, accents,
punctuation and runs of whitespace collapse, so `Series TV`, `Séries TV` and `series-tv`
are one shelf; `Animes - Films` and `Films` are not. There is no stemming, no distance
and no score, deliberately: a near-match that fires wrongly files somebody's media under
a name they never chose with nothing on screen saying why, whereas a keyword that does
not fire is visible the moment they look at the screen. A keyword that folds to nothing
is refused with `error.library.keyword_invalid`, and one another category already holds
with `error.library.keyword_taken` — two categories claiming `tv` would file a shelf
into whichever row came back first, an answer that differs between two identical
requests.

**Nothing is written on a library when a keyword catches it.** The fold is recomputed on
every read, so `DELETE /libraries/keywords/:id` is an exact undo: the shelves go back to
reading as their own names in the very next request, with no alias to guess at. That is
also why **an `alias` somebody typed always wins over a keyword** — `PATCH
/libraries/:id` is the repair for a mapping that filed something wrongly, and a keyword
able to override it would make the repair last one request.

A keyword row is anchored on a **library**, not on a `MediaCategory.key`. A category is
derived from the names libraries read as, so its key moves the instant one is renamed; a
list stored under `shows` would be orphaned by exactly the rename it exists to survive.
A library identifier survives a rename and survives a rescan, which matches rows on
`(serviceId, externalId)` and updates them in place. `CategoryKeyword.categoryKey` is
therefore computed at read time, and the row is removed with its library.

`/libraries/check` probes each declared `localPath`: does it exist, can it be read,
can it be written, how much room is left. This is the answer to the failure that
reports nothing — a library where the gateway's path and the media server's path do
not designate the same directory accepts transfers the server will never see. Each
entry also says whether that path was `derived`, because the two are corrected in
different places: a typed path is wrong on its own, a derived one is wrong for every
library of the service at once.

**Most libraries never need a `localPath` of their own.** A service carries
`remoteRoot` and `localRoot` — the prefix it reports, and the same directory as the
gateway reaches it — and every library under it derives its own path by replacing the
one with the other. A library's explicit `localPath` always wins: that field is for
the exceptions the mapping cannot express, and clearing it hands the library back to
the mapping rather than leaving it with no path at all.

## Media

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/media` | `MediaSearchDto` (query) | `ResultList<MediaItem>` | `MEDIA_READ` |
| GET | `/media/:id` | — | `MediaNode` | `MEDIA_READ` |
| GET | `/media/:id/children` | `MediaSearchDto` (query) | `ResultList<MediaItem>` | `MEDIA_READ` |
| GET | `/media/:id/matches` | — | `MediaMatch[]` | `MEDIA_READ` |
| POST | `/media/:id/matches/:matchId/confirm` | `ConfirmMatchDto` | `MediaMatch` | `SYNC_MANAGE` |
| DELETE | `/media/:id/matches/:matchId` | — | `204` | `SYNC_MANAGE` |
| GET | `/media/groups` | `MediaGroupQuery` (query) | `ResultList<MediaGroup>` | `MEDIA_READ` |
| GET | `/media/groups/:id` | — | `MediaGroup` | `MEDIA_READ` |
| GET | `/media/groups/:id/children` | `MediaGroupQuery` (query) | `ResultList<MediaGroup>` | `MEDIA_READ` |
| PUT | `/media/:id/override` | `MediaOverrideDto` | `MediaItem` | `MEDIA_READ` |
| DELETE | `/media/:id/override` | — | `MediaItem` | `MEDIA_READ` |
| GET | `/media/:id/artwork` | `token` (query, optional) | image bytes | `MEDIA_READ` |

**An override corrects what a media server got wrong, here and only here.** A
documentary filed under Films, an anime numbered by absolute order against a library
that expects seasons, a show under a name nobody in the house uses: correcting it on
the server means moving files and fighting the next scrape. The correction is written
into the fields everything reads, so it reaches correlation, filing and the category
the item appears under — one that only changed a label would be worse than none. The
instruction is kept beside it so a rescan re-applies it instead of undoing it, and the
service's own answer is kept so the change can be shown and reverted.

An absent field leaves the service's answer alone; an explicit `null` clears it. That
is how somebody removes a year a scraper invented, so the two cannot be collapsed.

Artwork is proxied rather than linked: the remote service's URL usually needs that
service's token, and an `<img>` tag carries no `Authorization` header. The gateway
caches what it fetches.

For the same reason the artwork route — and the event stream — accept the access token
as a `token` query parameter as well as a header. An `<img>` cannot send a header, and
fetching a poster through `fetch` to build an object URL would defeat the browser's own
image cache on a page showing two hundred of them. Only the short-lived access token is
accepted this way, never the refresh token, and these responses are marked private.

`rootsOnly` on the grouped query asks for media at the top of their tree — a series, a
film, a collection — which is what a poster wall wants rather than every episode laid
beside its series. Deriving it from the library's kind works for films and shows and
breaks on anything else: a library of concerts or audiobooks has no kind this model
names, and would show its parents and its children together.

**The grouped routes are what a library screen reads.** The index keeps one row per
service — the same episode on three servers is three rows — because merging them would
mean choosing whose title and whose file size survive. Browsing wants the opposite: one
poster per media, with the servers that hold it listed underneath. A group is that view,
computed from the match graph rather than stored, and two rows only join when a match
was actually applied: a proposal below the threshold stays two posters, which is the
honest rendering of "we are not sure these are the same thing".

Confirming or deleting a match is how a human overrules the scoring. Both are recorded
— a correlation nobody can undo is one nobody will trust.

## Syncing

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/sync/plans` | — | `SyncPlan[]` | `SYNC_READ` |
| POST | `/sync/plans` | `CreateSyncPlanDto` | `SyncPlan` | `SYNC_MANAGE` |
| GET | `/sync/plans/:id` | — | `SyncPlan` | `SYNC_READ` |
| PATCH | `/sync/plans/:id` | `UpdateSyncPlanDto` | `SyncPlan` | `SYNC_MANAGE` |
| POST | `/sync/plans/:id/estimate` | — | `SyncEstimate` | `SYNC_READ` |
| DELETE | `/sync/plans/:id` | — | `204` | `SYNC_MANAGE` |
| POST | `/sync/preview` | `RunSyncDto` | `SyncPreview` | `SYNC_READ` |
| POST | `/sync/run` | `RunSyncDto` | `SyncJob` | `SYNC_RUN` |
| POST | `/sync/companions` | `PullCompanionsDto` | `CompanionPullResult[]` | `SYNC_RUN` |
| GET | `/sync/jobs` | page, limit, state, view (query) | `ResultList<SyncJob>` | `SYNC_READ` |
| GET | `/sync/jobs/:id` | — | `SyncJob` | `SYNC_READ` |
| GET | `/sync/jobs/:id/items` | page, limit (query) | `ResultList<SyncJobItem>` | `SYNC_READ` |
| POST | `/sync/jobs/:id/cancel` | — | `SyncJob` | `SYNC_RUN` |

`/sync/companions` fetches only what sits beside files already on the disk — the
`.nfo`, the poster, the subtitles. A sync moves what is missing; this fills in what
arrived bare, because it was pulled before the setting was on, or from a source that
had none. Asking somebody to re-pull forty gigabytes to get a description file beside
it is not an answer, and it was the only one they had.

`/sync/preview` takes exactly the same body as `/sync/run` and changes nothing. That
symmetry is the point: what you were shown is what will happen, because the same code
computed both. It extends to the ceilings and to the free space: a preview reports the
same `stoppedBy` and the same `targets` a run would, so a plan cut short is visible
before it is started rather than afterwards.

### What a sync covers

A plan carries a `SyncScope`, and it is a first-class part of it rather than something
reconstructed from the filter — because a schedule that says only "synchronise" honestly
reads as "move an entire media library", and that is measured in terabytes. Its fields
intersect: naming a category and a subtree means the part of that subtree in that
category. `categoryKeys` are merged categories, which is the unit people think in — "keep
my Shows in step" is one intent, and naming the four libraries called Shows across three
servers stops being true the moment somebody adds a fourth server.

A scope that names nothing means everything, and a plan with one cannot be **enabled**
without `acknowledgeUnbounded`: `409 error.sync.scope_unbounded`. An empty form produces
exactly that plan, and almost nobody means it.

`/sync/plans/:id/estimate` recomputes what the scope currently comes to, in items and
bytes. It is a `POST` although it changes nothing: it walks every source and resolves a
placement per item, which is not something a list of plans should pay for on every read.
`SyncPlan.estimate` is therefore `null` everywhere else — an estimate stored against a
plan would not go stale, it would be believed.

### Where a plan prefers to file things

A plan carries a `preferredLibraryId`. It is a preference and not a target, and the
difference is where it sits in the placement rule: **below** the folder a series we
already hold lives in, and **above** the category's library and the global default. A
preference that outranked the existing copy would file the fourth season of a show into
the preferred shelf while the first three stayed where they were, and no media server
shows a series split across two folders as one series — a worse outcome than landing
somewhere unexpected, which is at least whole. So it decides where anything genuinely
new goes, and never splits a show.

It lives on the plan rather than on a run because a run is one execution of a standing
intent: a destination attached to a single run is a decision with nowhere to live
afterwards, and the next run would quietly go back to the old shelf with nothing
connecting the two. `RunSyncRequest.targetLibraryId` still overrides it for one run and
is stored nowhere; somebody wanting one file elsewhere re-points that transfer.

A library that is not one of this gateway's own, or whose files it does not hold, is
refused when the plan is saved — `409 error.transfer.destination_invalid`, `404
error.library.not_found` for one nobody has — rather than at four in the morning when
the schedule fires. The disk itself is deliberately not probed: a plan may not run for a
week, and refusing to save it because a NAS is asleep this evening is a refusal about
the wrong moment. A preference that cannot be written into when the run comes is simply
passed over, which is what the rest of the rule is for. Clearing it is always allowed.

Each planned line records which step decided, in `PlacedBy`: `plan_preference` for the
plan's, `requested` for a run that named one, `chosen_by_hand` for a transfer somebody
re-pointed afterwards. Three values rather than one because the thing to do about each
is different — the first is changed on the plan, the second died with its run, and the
third touched no rule at all.

### Room on the destination

`SyncPreview` and `SyncJob` both carry a `TargetSpace` per destination: what it has, what
this would write into it, and the reserve from `Settings.diskReserveBytes`. Both numbers
are known before a byte moves — every source announces the size of its files and every
library is probed for free space — and filling a disk is not an error that reports itself:
the transfer dies at ninety per cent with `ENOSPC`, the media server indexes the truncated
file as a real one, and somebody finds out days later.

A run is therefore answered before it starts:

| Verdict | `/sync/run` |
|---|---|
| `fits` | starts |
| `tight` — fits, but crosses the reserve | `409 error.sync.space_not_acknowledged`, unless `acknowledgeSpace` |
| `unknown` — no local path, or the probe failed | the same. Never read as "it fits" |
| `insufficient` — it does not fit | `409 error.sync.not_enough_space`, whatever the caller acknowledges |

The refusal is arithmetic, which is why no flag gets past it. The comparison is made over
the whole run rather than per file: three films that each fit on their own and do not fit
together is the case a per-file check cannot see.

`maxItemsPerRun` and `maxBytesPerRun` cut a run short — on the plan, or in the body of one
run — and set `stoppedBy`. They stop at the first item that does not fit rather than
packing the remaining room with smaller ones, so the order the plan chose is kept and
tomorrow's run continues where today's ended.

### Half a list, and what happens to the other half

Both list routes take `view`: `live`, `finished`, or `all`, which is the default. A
run or a transfer is *finished* once it is done, failed or cancelled; everything else
— including a paused transfer, which somebody stopped and will resume — is live.

`all` is the default deliberately, although the sync and queue screens both ask for
`live`. The home screen reads the same two routes for recent activity and for the
failed transfers it reports, and a default that had started dropping finished rows
would have emptied that panel with nothing anywhere saying so.

Finished rows are eventually deleted rather than archived, by a cleanup that runs once
a day. Two windows govern it, both in the settings: `transferHistoryDays` (thirty days
by default) for work that succeeded, `failedHistoryDays` (a hundred and eighty) for
what failed or was cancelled. The split is the whole point — a transfer that failed
three weeks ago is the answer to "why is this series incomplete", and a success is
already described by the file it produced. Nothing that has not finished is ever
removed, whatever the windows say.

### The lines of a run

`/sync/jobs/:id/items` serves a run line by line. A job that reports "412 of 900" and
nothing else is a number to watch, not something to act on: the two questions anybody has
are which item is stuck and where it is being written. Each line carries its `transferId`
once something is moving it, so opening a progress reaches the bytes on the event stream;
a line a ceiling dropped is kept as `skipped`, which is what makes `stoppedBy` legible
afterwards.

## Transfers

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/transfers` | page, limit, state, view (query) | `ResultList<Transfer>` | `TRANSFER_READ` |
| GET | `/transfers/stats` | — | `TransferQueueStats` | `TRANSFER_READ` |
| GET | `/transfers/unconfigured` | — | `UnconfiguredPlacement[]` | `TRANSFER_READ` |
| GET | `/transfers/:id` | — | `Transfer` | `TRANSFER_READ` |
| GET | `/transfers/:id/chunks` | — | `TransferChunk[]` | `TRANSFER_READ` |
| POST | `/transfers/:id/pause` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/resume` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/cancel` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/retry` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/verify` | — | `TransferVerification` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/repair` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/destination` | `{ libraryId }` | `Transfer` | `TRANSFER_MANAGE` |
| GET | `/transfers/:id/revalidations` | — | `Revalidation[]` | `TRANSFER_READ` |

`verify` re-reads what is on disk and answers what it found without changing anything;
`repair` acts on it. Keeping them apart means you can ask the question without
committing to the answer — which matters when the answer is "fetch nine gigabytes
again".

The revalidation list is why a transfer changed its mind: which source was asked, what
it said, and what was decided. Without it the queue shows outcomes nobody can account
for.

`/transfers/unconfigured` is the only thing anywhere that mentions a file placed by a
step nobody configured — the global destination library, the fallback folder, or the
last-resort walk of whatever was writable. The transfer succeeded, so there is no
error, no failed state and no log line to go looking for; the only other symptom is a
folder somebody did not plan, found months later. Each row carries the category whose
destination is unset, because "no destination is set for the category Animés" names
the setting to change and "fallback" names nothing.

`/transfers/:id/destination` sends one transfer somewhere else, and the two cases cost
wildly different things. While the file is still downloading the bytes are piling up in
the scratch directory and `targetPath` is not read until the very end, so the change is
one row write. Once the file has landed it is a real move of real bytes, usually across
two filesystems, reported as `placing` on the progress stream so it is visible while it
runs. The body takes a library identifier and never a path: a destination has to be a
library on one of this gateway's own services, because a folder nothing scans accepts
the file, reports success and shows it to nobody.

Two consequences of the second case are worth stating. A transfer the engine is placing
at that exact second is refused with `409 error.transfer.being_placed` rather than
queued: the mover can be cancelled and resumed, so interrupting it was buildable, but
between the abort being asked for and being observed both destinations hold part of the
file, and a crash in that window leaves half a film in each with the row naming only
one. A half-moved file is the outcome this whole area is designed against, and waiting
for a copy already running is the cheaper price. And the landing recorded in
`media_landings` follows the file: it is resolved by path, so a move that left it naming
the old one would have the next reconciliation decide the file had been deleted, put the
media back to `missing` with a perfectly good copy on disk, and offer a download of it.
Re-recording it also asks the *new* library's media server to look, which nothing else
would do.

A destination somebody sets by hand this way is recorded as `PlacedBy.chosen_by_hand`,
which is deliberately not `requested`: it is a correction to one file, no rule underneath
it moved, and the next episode of the same show still goes wherever the rules send it.

## Peers

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/peers` | — | `Peer[]` | `PEER_READ` |
| GET | `/peers/identity` | — | `PeerIdentity` | `PEER_READ` |
| POST | `/peers` | `AddPeerDto` | `Peer` | `PEER_MANAGE` |
| POST | `/peers/:id/approve` | — | `Peer` | `PEER_MANAGE` |
| POST | `/peers/invites` | `CreatePeerInviteDto` | `PeerInvite` | `PEER_MANAGE` |
| POST | `/peers/accept` | `AcceptPeerInviteDto` | `Peer` | `PEER_MANAGE` |
| GET | `/peers/:id` | — | `Peer` | `PEER_READ` |
| PATCH | `/peers/:id` | `RenamePeerDto` | `Peer` | `PEER_MANAGE` |
| DELETE | `/peers/:id` | — | `204` | `PEER_MANAGE` |
| PATCH | `/peers/:id/reading` | `SetPeerReadingDto` | `Peer` | `PEER_MANAGE` |
| PATCH | `/peers/:id/max-depth` | `PeerMaxDepthDto` | `Peer` | `PEER_MANAGE` |
| POST | `/peers/:id/ban` | `BanPeerDto` | `BannedPeer` | `PEER_MANAGE` |
| GET | `/peers/bans` | — | `BannedPeer[]` | `PEER_READ` |
| POST | `/peers/bans` | `BanFingerprintDto` | `BannedPeer` | `PEER_MANAGE` |
| DELETE | `/peers/bans/:fingerprint` | — | `204` | `PEER_MANAGE` |
| POST | `/peers/:id/connect` | — | `Peer` | `PEER_MANAGE` |
| POST | `/peers/:id/introductions` | `RequestIntroductionDto` | `Peer` | `PEER_MANAGE` |
| POST | `/peers/:id/release` | — | `204` | `PEER_MANAGE` |
| GET | `/peers/:id/services` | — | `MediaService[]` | `PEER_READ` |

**Three ways to withdraw from a peer, and they do not overlap.**

- `PATCH /peers/:id/reading` with `{"forbidden": true}` **forbids them from reading**.
  They stay a peer, the link stays open, and they are served nothing of ours whatever
  the per-library visibilities say — one flag on the row, honoured in
  `ShareManager.visiblePolicies`, which every peer-facing route already goes through.
  It sits a cut above a share policy's `deniedPeerIds`, which is per library and so
  cannot express "this person sees nothing of mine" without being written into every
  policy that exists. Reversible with the same call and `false`.

  **The link is deliberately not closed.** The status this replaces, `blocked`, closed
  the socket in both directions, so punishing somebody also cut off our own access to
  *their* library. The consequence to accept is that they remain connected on their
  side and find an empty catalogue.
- `DELETE /peers/:id` **removes** them: the link goes, their services, libraries, rows
  and matches go, and nothing of ours does. They may ask again, which is what somebody
  nearly always means when a friend rebuilds their gateway. It takes no body; the
  checkbox that used to offer a ban here is gone, because the standalone action below
  was a second way to reach the same outcome.
- `POST /peers/:id/ban` **refuses the key for good** and unlinks them. A ban outlives
  the row, so the same fingerprint cannot come back through a request, an invitation or
  an introduction by a friend. `POST /peers/bans` refuses a key nobody ever linked to.

**Links dial themselves.** Every linked peer is dialled shortly after boot, and a link
that drops is redialled with a capped exponential backoff — five seconds, doubling, to
a ceiling of fifteen minutes. A peer that *refused* us — a banned key, a rejected
handshake, a protocol version neither end speaks — is never redialled on a timer,
because from the far end a gateway that keeps knocking after being told no is
indistinguishable from one trying to get in. `POST /peers/:id/connect` therefore means
"try now rather than wait for the next attempt" rather than "connect"; it answers `503
error.peer.unreachable` when the attempt fails, whichever way it failed.

**A friend of a friend is introduced, never relayed.** `POST /peers/:id/introductions`
asks the peer in the middle for a signed token naming the gateway they told us about —
`holderId` is their own identifier for it, as an announcement already carries — and the
gateway then opens a link straight to that holder, presenting the token as a header on
the upgrade. The holder checks it against the public key it already holds for its own
peer, which is why it needs to know nothing about us in advance. The token lives two
minutes, names who may present it and which gateway it opens, and never names a media:
the introducer is not to be holding the sentence "A wanted this film". Nobody is asked
to approve it — how far introductions travel is the agreement, and `peerMaxDepth` with
each peer's `maxDepth` is where it is written down; both ends enforce it, so a gateway
beyond the limit is never introduced and never admitted. It answers `404
error.peer.introduction_refused` for every reason it can be refused, deliberately: a
caller able to tell "not my peer" from "further than I allow" could map out somebody's
friends and their reach by asking.

**The dial ladder has three rungs and nothing to configure**: the last known address,
then an introduction from a friend both ends have, then that same friend carrying the
bytes. Which friends are asked is decided by `PeerManager.introducersFor` — the peer
that told us about this one first, since that is how we know it exists, then the other
linked peers, and at most `MAX_INTRODUCERS_ASKED` of them, because a gateway that asked
twenty friends in turn before reporting failure is a screen that hangs. An introduction
is asked for by fingerprint on the ladder and by holder identifier when a
`catalogue.holders` answer named one; both reach the same `peer.introduce`.

The last rung is only taken when the friend in the middle advertises
`PeerCapability.RELAY`, which this gateway deliberately never does. Nothing is
encrypted above the transport, so on a relayed link that friend's machine really does
carry the bytes, and the interface says so in one line. **Two gateways behind two
routers with no friend in common therefore cannot be connected**, which is a stated
limit rather than a setting: the peers screen says so on the row and names the
forwarded port as the fix. Relaying stays the whole arrangement for a remote Jellyfin
or Plex somebody shares: that server does not speak this protocol and has never heard
of the friend, so standing in front of it is the point rather than a fallback.

`POST /peers/:id/release` lets go of a peer met that way. Whether it survives the
transfer is `keepDiscoveredPeers`, off by default: off, the row carries `discovered`
and goes with the link — including on the holder's side, when their session closes, and
at boot for a gateway that stopped mid-transfer; on, it joins the list like any other
peer and release does nothing to it.

**There are two ways to link, and the code is the convenience rather than the rule.**
`POST /peers` takes a fingerprint: you paste your friend's, they get a request showing
yours, they approve it. Nothing secret travels, nothing expires, and the person
accepting sees exactly who is asking. The invitation bundles the same thing into one
code so one person can do the whole job, which is easier and puts a shared secret in a
chat log. Both are offered; neither is mandatory.

`/peers/:id/approve` settles a request **somebody made of us**, and answers `409
error.peer.rejected` on one we made ourselves. Approving our own would declare a link
the far end never agreed to, and the first pull would then fail with an authentication
error rather than with the honest answer, which is that they have not answered yet.

`/peers/identity` is what you hand to somebody so they can find you: the node
identifier, the fingerprint, and whether a direct connection is possible at all. The
last one is worth showing — a gateway whose port is not forwarded works, but only for
as long as somebody in the middle is willing to introduce it, and it is better to know
that before wondering why a link never opens.

`/peers/invites` mints the one address the design still carries, and it is the issuing
gateway's own `publicUrl`. The URL spells it `address=`; an invitation minted before
the rename spells it `rendezvous=` and is still read, since one lives in somebody's
chat window for an hour. It is not a third party's directory: two gateways that have
never met have nobody in the middle by definition, and this is the case that covers.

`/peers/accept` takes the whole `mcs://invite/…` URL. The bare code parses, but it
carries neither the secret that proves the invitation nor the fingerprint that says who
to link to, so it can only ever be refused — `error.peer.invite_invalid` when the code
is unusable, `error.peer.invite_expired` when it is merely stale, because those are two
different things to do next.

## Sharing

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/shares` | — | `SharePolicy[]` | `SHARE_MANAGE` |
| PUT | `/shares/:libraryId` | `UpdateSharePolicyDto` | `SharePolicy` | `SHARE_MANAGE` |
| DELETE | `/shares/:libraryId` | — | `204` | `SHARE_MANAGE` |
| GET | `/shares/audit/:peerId` | — | `ShareAudit` | `SHARE_MANAGE` |

`PUT`, not `POST`: a library has at most one policy, and the absence of one means
private. Deleting a policy makes a library private again, which is the same thing as
never having shared it.

**What a library with no policy exposes is decided on its service, not here.**
`MediaService.shared` is the switch: on means the gateway's `defaultShareVisibility`
applies to every library on that service nobody has overridden, off means private. A
policy written here always wins over it, in both directions.

Whether this gateway holds the files does not enter into it. Serving a library we only
reach over HTTP works — the content route opens a stream against the media server and
never looks for a local file — so our friends pull *through* us, at the cost of our
connection. `ShareAudit.throughUs` says which libraries those are; nothing refuses them.
The previous shape had a per-library `relay` consent and a `SHARE_RELAY_NOT_AGREED`
refusal for exactly this case, which gated something that already worked and pointed at
a control the interface never had. Both are gone, along with the read-only `relays`
field.

Libraries reached through a linked peer are the one exception and are never offered
onward, whatever any row says.

`/shares/audit/:peerId` answers the question people actually ask before saving: what
would *this* peer see of me?

## Notifications

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/notifications/channels` | — | `NotificationChannel[]` | `SETTINGS_MANAGE` |
| POST | `/notifications/channels` | `CreateNotificationChannelDto` | `NotificationChannel` | `SETTINGS_MANAGE` |
| GET | `/notifications/channels/:id` | — | `NotificationChannel` | `SETTINGS_MANAGE` |
| PATCH | `/notifications/channels/:id` | `UpdateNotificationChannelDto` | `NotificationChannel` | `SETTINGS_MANAGE` |
| DELETE | `/notifications/channels/:id` | — | `204` | `SETTINGS_MANAGE` |
| POST | `/notifications/channels/:id/test` | — | `NotificationTestResult` | `SETTINGS_MANAGE` |

A channel is how the gateway says something happened while nobody was looking — a sync
that finishes at four in the morning must not need a browser tab open to be useful. Two
kinds exist, `ntfy` and `smtp`, and adding a third is a class in `services/notifications/`
and nothing else: `config` is an opaque object here precisely so that no route, DTO or
screen grows a case per kind.

`config` is therefore validated by the handler for the chosen type, not by the DTO, and
a refusal answers `400 { key: 'error.notification.config_invalid', field }` — the field
being the only part somebody looking at a form can act on.

**Credentials never come back.** The handler strips its own — an ntfy token, a mailbox
password — before the channel is serialised, so what a list returns is the address, the
port and the topic. The consequence is on writes: a `config` that leaves a credential out
keeps the stored one, because the interface fills its form from a response that never had
it. Sending a credential as an empty string is what clears it.

`events` empty means *every* event, which is also what keeps an event added in a later
version reaching the channels that already exist.

`POST …/test` answers `200` with `{ delivered, error, sentAt }` whatever happens, the way
a media service probe does: a refused password and an unreachable host are results a
settings screen renders, and the far end's own words are the diagnosis. The attempt is
recorded on the row — `lastError`, `lastSentAt` — because a channel that fails silently is
a channel nobody can trust.

Nothing else in the API ever fails because a notification did: dispatch resolves whatever
a channel does, and the failure ends in `lastError`. A notification that breaks a transfer
is worse than no notification.

## Settings and accounts

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/settings` | — | `Settings` | `SETTINGS_MANAGE` |
| PATCH | `/settings` | `UpdateSettingsDto` | `Settings` | `SETTINGS_MANAGE` |
| GET | `/users` | — | `User[]` | `USER_MANAGE` |
| GET | `/users/:id` | — | `User` | `USER_MANAGE` |
| PATCH | `/users/:id` | `UpdateUserDto` | `User` | `USER_MANAGE` |
| DELETE | `/users/:id` | — | `204` | `USER_MANAGE` |

`PATCH /settings` is a merge: only the keys in the body are written, so two screens
saving at once cannot overwrite each other's unrelated fields.

Three of the settings say where this gateway is and where files land, and all three are
normalised before they are stored — an empty string means *cleared*, not "an empty
value":

| Field | Accepted | Stored |
|---|---|---|
| `publicUrl` | any `http`/`https` URL | its origin — no path, no query, no trailing slash, no default port |
| `peerAddress` | `host:port` | the same, lowercased |
| `defaultTargetPath` | an absolute path with no `..` | the same, without a trailing slash |

`publicUrl` is how this gateway is reached from outside, and it exists because the
gateway has no other way of knowing: behind a reverse proxy `Host` is whatever the proxy
chose to forward, so an invitation, a share link and a torrent announce cannot be built
from the request that asked for them. It is refused with `error.settings.public_url_invalid`
when it is not a URL or its scheme is not one a browser dials.

`peerAddress` is only needed when peer traffic does not arrive at the public URL's host
— a separate name, a different port in front of the same gateway. There is no peer port
of its own: a link is an upgrade on the API's port. Empty derives it from `publicUrl`. It is refused with `error.settings.peer_address_invalid`, and a URL written
in this field is the usual slip.

`defaultTargetPath` is where a pull lands when nothing else decides: a media whose
category has no writable library. It is **not** `fixedPath`, which only applies under the
fixed-path strategy and means "everything goes here whatever it is". Like a library's
local path it is probed and refused when it cannot be written
(`error.settings.target_path_not_writable`), because a fallback the gateway cannot write
into is discovered at the end of a completed download.

**`categoryTargets` names a category as well as placing its files.** Pointing `Séries`
at the `Shows` library says that Séries *is* Shows on this gateway, so the write also
gives every library of that category the destination category's name as its `alias` —
which is what `GET /libraries/categories` merges on. Without it the setting moved
placement only, the library screen went on showing two categories, and nothing said
why. Every library of the category is renamed, **including the ones on servers that are
not ours**: the alias is local, never leaves this gateway and changes nobody's server,
so saying a friend's `TV` is our `Séries` is exactly the sentence the field exists to
write. Three cases write no alias: a destination whose category cannot be read, a
destination already in that category, and a destination the gateway cannot write into.
**Clearing a mapping keeps the alias**: it is indistinguishable from one somebody typed
on the libraries screen, and emptying a destination must not destroy a name. `PATCH
/libraries/:id` with `alias: null` is how a category is split again.

**The entry moves with the rename it causes.** A category key is folded from the name
people read, so renaming the libraries of `series` to `Shows` makes the category `shows`
— and an entry left under `series` then named a category that no longer existed.
Placement looked it up, found nothing, fell back to the default library and filed the
episode in a folder nobody chose, with no error and nothing on screen; from the outside
that reads as files landing unpredictably. So the answer comes back re-keyed, and a
`PATCH /settings` sending `{ "series": "<library>" }` may well answer
`{ "shows": "<library>" }`. An entry already standing at the merged key wins over the
one being moved: it is either the same answer or a choice made in the same patch.

An entry whose key no category answers to is warned about rather than deleted —
categories vanish while a service is offline, and dropping the row would lose a
deliberate choice to a temporary outage. What it files still lands, in the default
library, recorded with a `PlacedBy` in `UNCONFIGURED_PLACEMENTS`, which is what puts it
in the zone that offers to file it properly.

The four field refusals above — `publicUrl`, `peerAddress`, `defaultTargetPath` and
`categoryTargets` — answer `400` with `{ key, field }` rather than a plain key: they are
saved from one form, and without the field the interface can only say that something was
refused.

Accounts mirrored from a media service cannot have their username or password changed
here — the gateway does not own them. Their role can, because that is ours: it says what
this gateway lets somebody do, and nothing outside knows about it. `UpdateUserDto`
offers no `username` at all, so the route renames nobody, mirrored or internal.

The last administrator can be neither demoted nor deleted: both answer `409
error.user.last_admin`. Its own key rather than a generic refusal, because "forbidden"
on the screen where you *are* the administrator reads as a bug rather than as the
safeguard it is — and there is no screen for recovering from a gateway nobody can
configure any more.

## The peer link

| Path | Protocol |
|---|---|
| `/peer/link` | WebSocket, the peer protocol |

Where another gateway connects. The credential is presented on the upgrade itself, in
four headers, and a socket that cannot produce all four is refused with `401` before
anything is allocated for it:

| Header | What it carries |
|---|---|
| `x-mcs-fingerprint` | who they claim to be |
| `x-mcs-public-key` | the key behind that fingerprint, PEM, base64 |
| `x-mcs-challenge` | `<their fingerprint>:<epoch millis>` |
| `x-mcs-signature` | that challenge, signed |

The key has to hash to the fingerprint, the signature has to verify, and the challenge
has to be recent — without the last one a signature lifted off the wire would open a
link forever. An unknown fingerprint is recorded as a pending request and refused, the
same answer a key on the ban list gets: telling them apart would let somebody discover
they are refused by watching what happens. A peer forbidden from reading is *not*
refused here — the link is theirs to keep, and it is every answer over it that is
empty.

### The handshake

The first frame either end sends is `peer.hello`, and nothing else is served before it
— a method sent earlier answers `error.peer.rejected`.

```jsonc
// →  { "id": 1, "method": "peer.hello", "params": { "challenge": "…", "hello": PeerHello } }
// ←  { "id": 1, "result": { "hello": PeerHello, "publicKey": "…", "signature": "…" } }
```

The answer's signature is over *their* challenge, which is what proves the machine
that answered holds the private key behind the fingerprint that was asked for — on the
middle rung the address came from an introducer that chose it, so that proof happens
before a single catalogue row crosses.

`PeerHello` carries `nodeId`, `fingerprint`, `name`, `protocol` and `capabilities`. A
`protocol` not in `SUPPORTED_PROTOCOL_VERSIONS` is answered with
`error.peer.protocol_unsupported` and the link is closed. Before the first release
there is exactly one version and a mismatch is a flat refusal: carrying compatibility
for versions nobody ever ran is weight with no cargo. The agreed version and the
advertised capabilities are stored on the peer.

**Three rules let the wire grow without the version moving**, and all three are tested:

- an unknown field in a payload is ignored, never fatal;
- an unknown method answers `error.peer.method_unsupported` and the link stays open;
- a feature is used only when the far end advertised its capability — a peer that has
  not advertised `swarm` is not asked for pieces at all.

### Methods

| Method | Answers | Capability |
|---|---|---|
| `catalogue.list` | `{ entries: CatalogueEntry[] }`, filtered by the share policies; takes `page`, `since` and `libraryId` | `catalogue` |
| `catalogue.libraries` | `{ libraries: PeerLibrary[] }` — the shared libraries, by the handle their rows carry | `libraries` |
| `catalogue.holders` | `{ holders: ContentHolder[] }` for a `contentId`, ourselves first | `announce` |
| `media.describe` | `{ size, resumable, entry }` for one published identifier | `content` |
| `media.range` | bytes | `content` |
| `media.revalidate` | `{ externalId, file }`; `file: null` means gone | `revalidate` |
| `swarm.bitfield` | `{ pieces: null }` — this gateway holds whole files only | `swarm` |
| `swarm.piece` | bytes | `swarm` |

A peer is a media service on the other side of the link: `catalogue.libraries` is what
lets its shared libraries be registered as libraries here rather than as one bag of
files, and every `CatalogueEntry` carries the `libraryId` it belongs to. Both are
additions rather than a version change — a gateway that advertises `catalogue` and not
`libraries` answers `error.peer.method_unsupported`, its rows arrive without a library
handle, and everything it shares is filed under one library called `Shared`.

What crosses is our own row identifiers — the item's and its library's — and never a
path or the identifier the media server underneath keys its rows by.

A value answer is `{ id, result }` or `{ id, error: <ErrorKey> }`. A byte answer is a
sequence of binary frames, each prefixed with the four-byte big-endian identifier of
the request that asked for them, terminated by `{ id, end: true }` — only an explicit
end closes a stream, because one that merely stopped is indistinguishable from a
complete one.

`externalId` on this wire is the identifier *we* published for an item, which is our
own row identifier. A peer never learns a path, a library identifier or the identifier
the media service underneath uses.

## Peer-facing routes

These are not for browsers. They carry the peer credential rather than a user session,
and are marked `@PeerRoute()`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/peer/catalogue` | what we share with the calling peer, filtered by its policies |
| GET | `/peer/items/:id` | one item's descriptor |
| GET | `/peer/items/:id/content` | the bytes, ranged |
| POST | `/peer/revalidate` | re-read one item and report what we actually hold now |
| GET | `/peer/announce/:contentId` | do we hold this content, and do our peers |

`/peer/revalidate` is the far end of the ask-before-guessing protocol described in
`ARCHITECTURE.md`. Answering it honestly — including "gone" — is what keeps the other
gateway from re-downloading something that has not changed.

## Health

| Method | Path | Answers |
|---|---|---|
| GET | `/health` | `Health`, with `503` when a check fails |

`503` rather than a `200` carrying `ok: false`, because the container healthcheck
tests the status code. The media root is reported but does not flip the status:
restarting a container over a missing mount takes away the interface you would use to
diagnose it.
