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

## Libraries

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/libraries` | — | `Library[]` | `LIBRARY_READ` |
| GET | `/libraries/:id` | — | `Library` | `LIBRARY_READ` |
| PATCH | `/libraries/:id` | `UpdateLibraryDto` | `Library` | `LIBRARY_MANAGE` |
| GET | `/libraries/check` | — | `LibraryCheck[]` | `LIBRARY_READ` |

`/libraries/check` probes each declared `localPath`: does it exist, can it be read,
can it be written, how much room is left. This is the answer to the failure that
reports nothing — a library where the gateway's path and the media server's path do
not designate the same directory accepts transfers the server will never see.

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
| GET | `/media/:id/artwork` | `token` (query, optional) | image bytes | `MEDIA_READ` |

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
| DELETE | `/sync/plans/:id` | — | `204` | `SYNC_MANAGE` |
| POST | `/sync/preview` | `RunSyncDto` | `SyncPreview` | `SYNC_READ` |
| POST | `/sync/run` | `RunSyncDto` | `SyncJob` | `SYNC_RUN` |
| POST | `/sync/companions` | `PullCompanionsDto` | `CompanionPullResult[]` | `SYNC_RUN` |
| GET | `/sync/jobs` | page, limit, state (query) | `ResultList<SyncJob>` | `SYNC_READ` |
| GET | `/sync/jobs/:id` | — | `SyncJob` | `SYNC_READ` |
| POST | `/sync/jobs/:id/cancel` | — | `SyncJob` | `SYNC_RUN` |

`/sync/companions` fetches only what sits beside files already on the disk — the
`.nfo`, the poster, the subtitles. A sync moves what is missing; this fills in what
arrived bare, because it was pulled before the setting was on, or from a source that
had none. Asking somebody to re-pull forty gigabytes to get a description file beside
it is not an answer, and it was the only one they had.

`/sync/preview` takes exactly the same body as `/sync/run` and changes nothing. That
symmetry is the point: what you were shown is what will happen, because the same code
computed both.

## Transfers

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/transfers` | page, limit, state (query) | `ResultList<Transfer>` | `TRANSFER_READ` |
| GET | `/transfers/stats` | — | `TransferQueueStats` | `TRANSFER_READ` |
| GET | `/transfers/:id` | — | `Transfer` | `TRANSFER_READ` |
| GET | `/transfers/:id/chunks` | — | `TransferChunk[]` | `TRANSFER_READ` |
| POST | `/transfers/:id/pause` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/resume` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/cancel` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/retry` | — | `Transfer` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/verify` | — | `TransferVerification` | `TRANSFER_MANAGE` |
| POST | `/transfers/:id/repair` | — | `Transfer` | `TRANSFER_MANAGE` |
| GET | `/transfers/:id/revalidations` | — | `Revalidation[]` | `TRANSFER_READ` |

`verify` re-reads what is on disk and answers what it found without changing anything;
`repair` acts on it. Keeping them apart means you can ask the question without
committing to the answer — which matters when the answer is "fetch nine gigabytes
again".

The revalidation list is why a transfer changed its mind: which source was asked, what
it said, and what was decided. Without it the queue shows outcomes nobody can account
for.

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
| POST | `/peers/:id/block` | — | `Peer` | `PEER_MANAGE` |
| POST | `/peers/:id/unblock` | — | `Peer` | `PEER_MANAGE` |
| POST | `/peers/:id/connect` | — | `Peer` | `PEER_MANAGE` |
| GET | `/peers/:id/services` | — | `MediaService[]` | `PEER_READ` |

**There are two ways to link, and the code is the convenience rather than the rule.**
`POST /peers` takes a fingerprint: you paste your friend's, they get a request showing
yours, they approve it. Nothing secret travels, nothing expires, and the person
accepting sees exactly who is asking. The invitation bundles the same thing into one
code so one person can do the whole job, which is easier and puts a shared secret in a
chat log. Both are offered; neither is mandatory.

`/peers/identity` is what you hand to somebody so they can find you: the fingerprint,
the rendezvous, and whether a direct connection is possible at all. The last one is
worth showing — a gateway whose port is not forwarded works, but every transfer goes
through a relay and it is better to know that before wondering why it is slow.

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

`/shares/audit/:peerId` answers the question people actually ask before saving: what
would *this* peer see of me?

## Settings and accounts

| Method | Path | Body | Answers | Right |
|---|---|---|---|---|
| GET | `/settings` | — | `Settings` | `SETTINGS_MANAGE` |
| PATCH | `/settings` | `UpdateSettingsDto` | `Settings` | `SETTINGS_MANAGE` |
| GET | `/users` | — | `User[]` | `USER_MANAGE` |
| GET | `/users/:id` | — | `User` | `USER_MANAGE` |
| PATCH | `/users/:id` | `UpdateUserDto` | `User` | `USER_MANAGE` |
| DELETE | `/users/:id` | — | `204` | `USER_MANAGE` |

Accounts mirrored from a media service cannot have their username or password changed
here — the gateway does not own them. Their role can, because that is ours.

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
