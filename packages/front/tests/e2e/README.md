# Journeys

These run against a stack that is already up — `make e2e` locally, `make e2e/ci` on a
runner. They never start a server themselves: a journey that boots its own stack tests
a stack nobody else has, and passes while the real one is broken.

## The `data-test` contract

Journeys address elements through `data-test` attributes only. A Vuetify class changes
with a minor version and a label changes the day somebody improves the wording — or the
moment the interface is read in French. Either would break a journey for a reason that
has nothing to do with what it verifies.

Pages must therefore carry these attributes. Adding one is cheap; renaming one is a
change to this contract and breaks journeys on purpose.

**Fields are marked on the field, reached through to the control.** A Vuetify input
puts unknown attributes on its root, which is a `div` wrapping the real `<input>`.
Marking the field is the right thing for a page to do — one attribute, on the
component somebody actually wrote — so journeys use `field0(name)` rather than
`test0(name)` to type into one. A journey that forgets fails with "Element is not an
<input>", naming Playwright rather than the mismatch.

| Attribute | Where | What it marks |
|---|---|---|
| `app-shell` | `App.vue` | the shell, visible only once a session exists |
| `app-nav` | `App.vue` | the navigation drawer |
| `nav-<route>` | navigation | one entry per top-level route |
| `account-menu`, `account-logout` | app bar | the account menu and its sign-out entry |
| `login-provider` | `Login.vue` | the provider selector |
| `setup-form`, `setup-display-name`, `setup-username`, `setup-password`, `setup-confirmation`, `setup-submit` | `Setup.vue` | the first administrator, on a gateway no account has claimed yet |
| `setup-version` | `Setup.vue` | the version the setup screen says it is about to configure |
| `setup-claimed` | `Setup.vue` | what stands there instead once the gateway has an account |
| `login-username`, `login-password`, `login-submit` | `Login.vue` | the sign-in form |
| `form-main-error` | `FormMainError.vue` | the form-level error |
| `notify` | `Notify.vue` | a notification |
| `page-title` | `PageHeader.vue` | the current page title |
| `empty-state` | `EmptyState.vue` | the "nothing here" block |
| `service-list`, `service-row`, `service-add`, `service-probe` | services page | the registered services |
| `service-name`, `service-url`, `service-token` | service form | the fields of the add/edit dialog |
| `service-add-type`, `service-add-type-<type>` | `ServiceAdd.vue` | the kind chosen first in "Add a service"; a kind with a directory (Plex) then leads with signing in |
| `directory-sign-in`, `directory-start`, `directory-waiting`, `directory-open`, `directory-cancel`, `directory-expired`, `directory-failed`, `directory-retry`, `directory-listing`, `directory-empty`, `directory-add`, `directory-failures`, `directory-failure`, `directory-created`, `directory-manual`, `directory-back`, `directory-unavailable`, `directory-popup-blocked` | `DirectorySignIn.vue`, `ServiceAdd.vue` | signing in to plex.tv: each state of the wait, what failed and why, and the way back to the address form. The root carries `data-phase` |
| `discovered-servers`, `discovered-group`, `discovered-server`, `discovered-select-<identifier>`, `discovered-registered`, `discovered-relay-note`, `discovered-unreachable-note` | `DiscoveredServerList.vue` | the servers the account reaches, grouped as ours (`data-group="owned"`) or shared; a row carries `data-identifier` |
| `connection-route`, `service-relay-note` | `ConnectionRouteChip.vue`, services page | how a server found through plex.tv is reached — `data-route` is `local`, `remote`, `relay` or `unreachable` — and the sentence a relay-only service carries |
| `media-list`, `media-row`, `sync-state`, `quality-chip` | library pages | the index, in either view |
| `library-section`, `library-section-count`, `library-section-empty`, `library-section-open`, `library-section-all` | `Library.vue` | one band per merged category: its heading (which opens the category, and is the only door that is always there), its total, the note it shows when empty, and the button offered when the band shows less than it holds. The band carries `data-category` and `data-total` — the category's whole count, not what fits on the row |
| `library-section-latest`, `library-section-local` | `Library.vue` | that a band is capped to the newest of its category, and that some of the category is ours |
| `media-breadcrumb`, `media-breadcrumb-step`, `media-breadcrumb-current` | `MediaBreadcrumb.vue` | where you are, from the category down, and the steps back out |
| `media-card`, `media-open`, `media-poster`, `media-poster-placeholder` | poster wall | one tile, the link that opens it, its artwork, and what stands in when there is none |
| `source-marks`, `source-mark-local`, `source-mark-remote`, `source-mark-none` | poster wall, list | who holds a media, in the marks a tile has room for; each mark carries `data-origin`, and the group carries `data-origins` |
| `media-missing-count` | poster wall | how many children are missing under a tile |
| `media-select`, `media-select-all` | library pages | picking one media, and everything on the page |
| `library-select-mode`, `library-selection-bar`, `library-selection-clear`, `library-sync-selected` | `Library.vue` | selecting on a grid, and what can be done with a selection |
| `library-view-toggle`, `library-view-grid`, `library-view-list` | `Library.vue` | posters or the dense list |
| `library-everything` | `Library.vue` | browsing across every category at once |
| `media-filters`, `media-search`, `media-service`, `media-library`, `media-kind`, `media-states`, `media-sort`, `media-direction`, `media-clear` | `MediaFilters.vue` | the toolbar above the wall; `media-service` takes several servers at once |
| `media-origins`, `media-origin-<origin>`, `media-sort-fixed` | `MediaFilters.vue` | the four origins — ours, direct, friends, friends of friends — and the note that stands in for the sort control on the overview |
| `item-sync`, `item-sync-missing`, `item-matches`, `item-override`, `item-missing-count` | `LibraryItem.vue` | the actions on one media — pulling it, pulling what is missing below it, explaining why two copies were correlated, correcting what the service got wrong — and what is missing below it |
| `source-picker`, `source-default`, `group-source`, `group-source-ours`, `group-source-origin` | `LibraryItem.vue` | every server that holds it, ours marked, how far away each one is, and which a pull should use |
| `bandwidth-control`, `bandwidth-panel`, `bandwidth-caps` | app bar | the global caps, the live rate, and the caps in force |
| `bandwidth-download`, `bandwidth-upload`, `bandwidth-download-unit`, `bandwidth-upload-unit`, `bandwidth-download-preset`, `bandwidth-upload-preset`, `bandwidth-apply` | bandwidth panel | the presets, the free fields and their units |
| `transfer-list`, `transfer-row`, `transfer-progress` | transfers page | the queue |
| `companion-marks`, `item-companions`, `item-companions-scan` | library pages | what sits beside the file, and the scan offered when it has never been read |
| `peer-list`, `peer-row`, `peer-invite` | peers page | the peers; a row carries `data-status` and `data-direction`, which is what tells a request we are waiting on from one somebody here owes an answer to |
| `peer-status`, `peer-approve`, `peer-incoming-hint` | `PeerCard.vue` | a pending link, and the answer an incoming one needs |
| `peer-trust`, `peer-link-mode`, `peer-reading-forbidden`, `peer-reading-hint`, `peer-unreachable-hint`, `peer-connect`, `peer-rename`, `peer-forbid-reading`, `peer-allow-reading`, `peer-remove`, `peer-ban` | `PeerCard.vue` | who this is, how the bytes travel, and everything that can be done about it — the three outcomes do not overlap: forbidding reading keeps the link, removing lets them ask again, banning refuses the key for good |
| `invite-tab-create`, `invite-tab-accept`, `invite-tab-fingerprint` | `InviteDialog.vue` | the three ways to link two gateways |
| `invite-dialog`, `invite-create`, `invite-code`, `invite-name`, `invite-accept` | `InviteDialog.vue` | handing out an invitation, and using one somebody handed you |
| `peer-fingerprint`, `peer-name`, `peer-address`, `peer-add` | `InviteDialog.vue` | linking by fingerprint, with no code |
| `peer-node-id`, `peer-identity`, `peer-reachability` | `Peers.vue`, `Peer.vue` | the node identifier — ours, and each peer's — what somebody needs to link to this gateway, and whether it can be reached directly or only through a relay |
| `service-library` | `Service.vue` | one library of the service, with everything editable about it; `data-library` says which |
| `library-name`, `library-alias`, `library-position`, `library-name-save` | `LibraryNameField.vue` | what this gateway calls a library, and where it sits in the order |
| `library-category`, `library-reported-name` | `LibraryNameField.vue` | the category the library merges into — carrying `data-category` and `data-merged`, how many libraries are in it — and the name the service reports |
| `category-list`, `category-row`, `category-list-empty` | `CategoryList.vue` | the merged categories, in the order they appear; each row carries `data-category`, `data-libraries` and `data-services` — what merged into it |
| `settings-download-rate`, `settings-upload-rate` | `Settings.vue` | the global caps, where they are actually set |
| `category-mapping`, `category-pool`, `category-pool-entry`, `category-pool-empty`, `category-pool-chip-<key>`, `category-pool-map-<key>-<target>` | `CategoryMapping.vue` | one strip of chips: the shelves no category of ours claims yet, each carrying `data-category`, each draggable and each its own menu's activator so the keyboard road starts where the drag does. Nine of them take a line, not nine rows — as blocks they pushed the categories this screen is about off the viewport. The strip says it is empty rather than going blank, which is precisely when the screen has done its job |
| `category-mapping-row`, `category-keyword`, `category-keyword-<normalized>`, `category-keyword-move-<key>`, `category-keyword-remove-<normalized>`, `category-keyword-input-<key>`, `category-keywords-empty` | `CategoryMapping.vue` | one of our categories as a drop target — `data-category` says which — with the names filed into it as closable chips. Moving one is a single gesture, dropped or chosen from its menu, never a removal and an addition; taking one out puts it back on the strip above. The add field is a combobox: it suggests what is unfiled and still takes a name no library answers to yet |
| `category-mapping-undo`, `category-mapping-undo-action`, `category-mapping-error` | `CategoryMapping.vue` | what the last mapping did and the one click that takes it back; plugging a name in writes no alias, so the undo is a deletion and it is exact |
| `category-mapping-order`, `category-mapping-order-toggle` | `CategoryMapping.vue` | the order, the rename and the reorder, kept reachable one fold down — still the repair for a mapping that filed something wrongly, since an alias always wins over a keyword |
| `settings-categories-services` | `CategoryMapping.vue` | the way from the categories to the screen that edits them |
| `settings-public-url`, `settings-public-url-suggested`, `settings-peer-address` | `Settings.vue` | where this gateway is reached from outside and where peers connect — the caption appears only while the address is still the browser's own origin and nothing has been stored, which is what makes it an offer rather than an assumption |
| `settings-placement-rule`, `settings-placement-rule-existing` | `Settings.vue` | the whole rule deciding where a pulled file lands, in order, and its first step — the one nothing on the screen can turn off |
| `settings-default-target-library`, `settings-destination-none` | `DestinationLibraryField.vue` | the destination for anything no category names, and the reason the menu is empty when no library can receive a file at all |
| `settings-default-target`, `settings-default-target-browse` | `Settings.vue` | the fallback folder, for the case a library cannot express, and the picker that assists the field without replacing it |
| `settings-fixed-path-active`, `settings-fixed-path-clear` | `Settings.vue` | a gateway still pinned to the old fixed path, which overrules the whole section, and the one action that ends it |
| `category-target-<key>`, `category-target-fallback`, `category-target-merges` | `CategoryMapping.vue` | where one of our categories sends its media, on the category itself rather than in a table of its own — the row carries `data-configured`, so a category nobody has answered for can be told from one that was, and it names what it falls back to instead of sitting blank. A library that cannot receive anything stays in the menu, unselectable, with the reason. The merge consequence is stated once for the screen: printed under every select it was three identical paragraphs in one viewport |
| `share-rate-summary`, `share-rate-library` | `ShareRateSummary.vue` | the caps actually in force, global and per library |
| `share-library`, `share-library-open`, `share-visibility-chip` | `SettingsShares.vue` | one library's sharing, the way to open it, and what it exposes today — `data-library` says which library, `data-visibility` what it exposes |
| `share-policy`, `share-visibility`, `share-allowed`, `share-denied`, `share-rate-limit`, `share-save`, `share-remove` | `SharePolicyForm.vue` | the rule, the peers it is bent for either way, the cap, and the two ways out: saving, or making the library private again |
| `override-dialog`, `override-form`, `override-save`, `override-restore` | `OverrideDialog.vue` | correcting what a media server got wrong, and putting it all back |
| `override-library`, `override-title`, `override-series-title`, `override-year`, `override-season`, `override-episode`, `override-overview`, `override-id-tvdb`, `override-id-tmdb`, `override-id-imdb` | `OverrideDialog.vue` | one correctable field each |
| `override-<field>-was`, `override-<field>-cleared`, `override-<field>-clear` | `OverrideField.vue` | what the service said about a field, that it was erased on purpose, and the eraser that erases it and puts it back |
| `dashboard-categories`, `dashboard-category` | `Dashboard.vue` | the merged categories, each opening the wall on its own |

## Three phases: install, data, journeys

`playwright.config.ts` runs the suite as three projects, each depending on the one
before — Playwright's `dependencies`, so a failed install stops the run with its reason
instead of thirty journeys failing one by one on a sign-in page:

1. **install** — `setup.spec.ts`. The installation is a journey, tested by being done:
   against the gateway under test while it is still empty, it creates the first
   administrator through the setup screen. That administrator is `ADMIN` in
   `helpers.ts` (`E2E_ADMIN_USER`, `E2E_ADMIN_PASSWORD`) — the account every later
   journey signs in as, so the password must pass the setup screen's floor of eight.
2. **data** — `data.spec.ts`. Every journey builds its own fixtures and removes them,
   so there is no shared catalogue to load; this phase proves the installed gateway is
   ready (its administrator signs in, its API answers, its settings read) and, on a
   complete run, that what journeys would otherwise skip without is present.
3. **journeys** — every other file.

On a gateway that is already claimed — the development stack `make e2e` runs against —
the three install journeys that need an empty gateway skip and say so, and the fourth
(a second administrator is refused) still runs.

`make e2e/ci` is the complete run. It raises a stack of its own (`docker/ci/`: its own
compose project, no published port, dependencies installed into volumes, every file
the gateway writes under `var/e2e-ci/`), never seeds it, brings up a lab of its own
beside it, and sets `E2E_COMPLETE=1` — under which a claimed gateway, a landing
directory the gateway cannot write, or a lab that is not named fails the install or
data phase rather than letting a journey skip. Playwright's artefacts go to
`var/e2e-ci/results/` and the servers' output to `var/e2e-ci/logs/`, never to the
`test-results/` other runs share. Everything else it created is removed when it ends.

## Synchronisation and transfers

Attributes added for `sync.spec.ts`, `sync-plan.spec.ts` and `transfers.spec.ts`, kept
here rather than threaded into the table above so that several people appending at
once do not edit the same lines.

| Attribute | Where | What it marks |
|---|---|---|
| `plan-list`, `plan-row`, `plan-create`, `plan-run`, `plan-toggle`, `plan-edit`, `plan-remove`, `plan-disabled` | `Sync.vue` | the plans, what can be done to each from its row, and the chip saying a plan will not run on its own |
| `job-list`, `job-view`, `job-view-<view>`, `job-see-finished`, `job-history-hint` | `Sync.vue` | the runs, the live/finished/all control, and the two roads to the finished half: the button inside the empty state, the caption under a non-empty list |
| `job-row`, `job-state`, `job-cancel`, `job-error` | `JobRow.vue` | one run; the row carries `data-state` |
| `plan-form`, `plan-name`, `plan-enabled`, `plan-trigger`, `plan-schedule`, `plan-root`, `plan-kinds`, `plan-min-year`, `plan-max-bytes`, `plan-title-matches`, `plan-missing-only`, `plan-replace-outdated`, `plan-preview`, `plan-save` | `PlanForm.vue` | every field of a plan the form renders. `plan-max-bytes` is the largest *file*, a filter — not a ceiling on a run |
| `plan-max-items-per-run`, `plan-max-bytes-per-run` | `PlanForm.vue` | the ceilings on one run |
| `plan-acknowledge-unbounded` | `PlanForm.vue` | the explicit choice to enable a plan whose scope names nothing — present only while the plan is enabled and names nothing, which is exactly when the gateway would refuse without it |
| `plan-root-more` | `PlanForm.vue` | the subtrees a plan covers beyond the one the form edits, kept through a save |
| `plan-add-source-option` | `PlanForm.vue` | one server offered as a source, carrying `data-value` |
| `plan-trigger-option`, `plan-kind-option` | `PlanForm.vue` | one menu option, carrying `data-value`, so a journey picks by value and never by a translated label |
| `plan-source`, `plan-source-up`, `plan-source-down`, `plan-source-remove`, `plan-add-source`, `plan-source-add` | `PlanForm.vue` | the ordered sources, and adding one |
| `plan-target`, `plan-target-option`, `plan-target-none`, `plan-target-rejected` | `PlanForm.vue` | the preferred library: each offered one carries `data-library`; the note when nothing can receive a file; one line per library left out, with its reason |
| `sync-preview`, `preview-row`, `sync-run` | `SyncPreviewDialog.vue` | what a run would do, and the button that must stay grey when it would do nothing |
| `transfer-view`, `transfer-view-<view>`, `transfer-see-finished`, `transfer-history-hint`, `transfer-state-filter`, `transfer-state-option` | `Transfers.vue` | the same split on the queue; a state option carries `data-value` |
| `transfer-retarget`, `retarget-hint`, `retarget-library`, `retarget-option`, `retarget-none`, `retarget-rejected`, `retarget-confirm` | `TransferActions.vue`, `Transfers.vue` | sending a pull elsewhere: the explanation that differs between re-pointing and moving, the offered libraries (each carrying `data-library`), the ones left out, and the confirm whose label differs too |

Three things about these journeys a reader would otherwise get wrong:

- **Which half of the history is showing is read off the request, not the toggle.** A
  Vuetify button group marks its selection with a class and nothing else, so the
  journeys assert the `view=` the page asked the gateway for.
- **One describe in `transfers.spec.ts` serves its own queue** through `page.route`: a
  transfer still downloading and one being placed cannot be held on demand, so the
  wording of the re-point dialog and the absence of the control while placing are
  checked against three transfers the journey answers. The move itself is proven for
  real in the same file, with the fake server of `fake-jellyfin.ts` and a landing
  library of the journey's own — which needs `E2E_LANDING_PATH` when the gateway sees
  the repository under another path than the journeys do.
- **A server registered after the tab was opened must be named, and offered.** The
  plan screens used to show it as a raw identifier; they now ask again on entry, and a
  page already open hears `service.changed` on the event stream. The journey checks
  both, so it needs the stream as much as the page.

## Media pages, and the media they need

Attributes added for `keep-in-sync.spec.ts`, `media-states.spec.ts`, `dashboard.spec.ts`
and `library-item.spec.ts`, appended here for the same reason as the section above.

| Attribute | Where | What it marks |
|---|---|---|
| `item-keep`, `item-plan-link` | `LibraryItem.vue` | keeping a series, a season or a collection in sync — absent on a film — and the chip leading back to the plan that already covers the media |
| `keep-in-sync`, `keep-estimate`, `keep-estimate-truncated`, `keep-form`, `keep-mode`, `keep-plan`, `keep-name`, `keep-trigger`, `keep-schedule`, `keep-sources`, `keep-create`, `keep-run-once` | `KeepInSyncDialog.vue` | the dialog, what its scope comes to before anything is saved, the plan it would create or extend, and the one-off run that remembers nothing. Triggers are picked by position: `manual`, `schedule`, `on_new` |
| `keep-covered`, `keep-open-plan` | `KeepInSyncDialog.vue` | what stands instead of the form when a plan already covers the media, naming it, and the way to it |
| `tile-services`, `tile-missing`, `tile-awaiting`, `tile-transfers`, `tile-peers`, `stat-tile-value` | `Dashboard.vue`, `StatTile.vue` | the figures, the line under the missing one for what has landed and is waiting, and the figure itself inside a tile |
| `dashboard-refresh`, `dashboard-problems`, `dashboard-problem`, `dashboard-jobs` | `Dashboard.vue` | re-reading everything, what needs somebody, and the latest runs |
| `dashboard-unconfigured`, `dashboard-unconfigured-row`, `dashboard-unconfigured-reason`, `dashboard-unconfigured-dismiss` | `UnconfiguredPlacements.vue` | files placed by a step nobody chose; a row carries `data-placed-by` and `data-transfer`, which is how a journey finds its own among somebody's |
| `transfer-destination`, `transfer-destination-library`, `transfer-destination-move`, `transfer-destination-remember`, `transfer-destination-renames`, `transfer-destination-none` | `TransferDestination.vue` | answering one of those rows: the library, moving this file there, or sending the category's next ones there — and the line saying that the category then takes that library's name |
| `notify` | `Notify.vue` | now carries `data-type` — `success` or `error` — so a journey can tell a refusal from a confirmation without reading either |

### Where the media come from

A clean stack holds no media, and no route creates a library or a media item — they
exist only because a scan found them. So `fake-jellyfin.ts` makes the journey the media
server: it raises the smallest Jellyfin the gateway's handler will talk to, in the
Playwright process, on the network the containers share, and `createMediaFixture`
registers it, scans it and hands back a series, its season, three episodes and a film.
`fixture.remove(request)` deletes the service, which takes every row it produced with
it. Nothing depends on the lab, and nothing asserts against a catalogue somebody
happened to have loaded.

A journey that *pulls* something first calls `useOwnDestination`: two libraries of its
own, in a directory under `var/e2e-landing/`, with the default destination pointed at
the first for the length of the journey. Without that, a pull lands wherever the
placement rule reaches — on a real gateway, somebody's own shelf. The gateway and the
journeys see that directory under two names; in CI both are `/app`, and on a
workstation whose gateway runs outside the containers, `E2E_LANDING_PATH` gives the
gateway's name for it:

```bash
docker compose -f docker/docker-compose.yml --profile e2e run --rm --no-deps \
	-e E2E_LANDING_PATH=$PWD/var/e2e-landing e2e npx playwright test
```

When the gateway cannot write there, the pulling journeys skip and say so rather than
pull somewhere else. Two things a reader should know:

- **A pull leaves a transfer row behind.** No route deletes a transfer, and deleting the
  service keeps its transfers as history — so on a shared gateway every run adds a few
  rows to the transfers screen. They leave the dashboard's unconfigured zone as soon as
  the fixture's libraries are removed, which `dashboard.spec.ts` checks.
- **`not_indexed` needs a gateway started for it.** A landing goes stale after twelve
  hours unless the API was started with `MCS_LANDING_GRACE_MS` — a test hook, not a
  setting. Set the same variable for the journeys (`-e MCS_LANDING_GRACE_MS=20000` on
  both sides) and the last journey of `media-states.spec.ts` waits it out, lets a scan
  settle the landing and checks the badge, its words and the dashboard's row. Without
  it that journey skips and says why. Keep it short but not tiny: every journey that
  checks `awaiting_index` has to finish before the landing it made goes stale.
- **`placing` needs a gateway started for it too.** On a same-filesystem gateway a
  placement is one rename, so nothing can re-point a transfer during it — which is
  exactly the refusal `transfers.spec.ts` wants to see. `MCS_PLACING_HOLD_MS` (a test
  hook in the file mover; `make e2e/ci` sets 3000 on both sides) holds every placement
  that long; without it that journey skips and says why.

## Forms: users, notification channels, caps, destination, sharing, the picker

Every form outside the media pages has a journey: `users.spec.ts`,
`notifications.spec.ts`, `bandwidth.spec.ts`, `destination.spec.ts`,
`share-policy.spec.ts`, `picker.spec.ts` and `invite.spec.ts`. Each checks the refusals
as carefully as the successes — visible where somebody is looking, naming what is
wrong — because a refusal that marked nothing is the defect this product has shipped
four times.

| Attribute | Where | What it marks |
|---|---|---|
| `confirm-accept`, `confirm-cancel` | `Confirm.vue` | the two buttons of every confirmation, marked once rather than by each caller |
| `user-list`, `user-row`, `user-role`, `user-remove`, `user-mirrored` | `SettingsUsers.vue` | the accounts; a row carries `data-user`, its identifier — never find one by name, since a mirrored name that is taken is suffixed and `lab` also matches `lab-1` |
| `user-error` | `SettingsUsers.vue` | a refusal, kept on the page after the toast has gone, carrying the API's key in `data-key` (`error.user.last_admin`) so a journey can say *which* refusal without reading the translated sentence |
| `notification-channels`, `notification-empty`, `notification-add`, `notification-channel-<id>`, `notification-test-<id>`, `notification-edit-<id>`, `notification-remove-<id>` | `NotificationChannels.vue` | the channels pane and one row per channel |
| `notification-last-error`, `notification-last-sent`, `notification-never-sent` | `NotificationChannels.vue` | what a row says about its last send — the failure stays on the row, not only in the toast |
| `notification-dialog`, `notification-name`, `notification-type`, `notification-config-<field>`, `notification-clear-<field>`, `notification-enabled`, `notification-event-<event>`, `notification-save`, `notification-cancel` | `NotificationChannels.vue` | the channel form; the config fields are drawn per kind, so `notification-config-topic` exists for ntfy and `notification-config-host` for a mailbox |
| `share-origin-note` | `SharePolicyForm.vue` | whether the rule was chosen here or is the default applying, in `data-origin` |
| `library-path-browse` | `LibraryPathField.vue` | the icon that opens the directory picker on a library path |
| `service-mappings`, `service-mappings-empty`, `service-mapping`, `service-mapping-remote`, `service-mapping-local`, `service-mapping-remote-browse`, `service-mapping-local-browse`, `service-mapping-remove`, `service-mapping-add`, `service-mapping-suggestion` | `RootMappingList.vue` | where a service's files are, for us: the list, what it says when empty, one row per disk (`data-index` says which) with its server side and gateway side, the pickers on each side, removing a row, adding one, and a server folder the probe reported offered as a row |
| `browse-server`, `browse-server-hint`, `browse-server-entry`, `browse-server-enter`, `browse-server-up`, `browse-server-no-deeper`, `browse-server-unsupported`, `browse-server-empty`, `browse-server-unavailable`, `browse-gateway-title` | `DirectoryPicker.vue` | the server's half of the picker: its folders, the sentence relating them to this disk, the step in and back out, the note kept beside the folders when the server cannot walk deeper, and what the server's side of a mapping says when the server could not be asked |
| `browse-crumbs`, `browse-list`, `browse-entry`, `browse-empty`, `browse-error`, `browse-choose`, `browse-cancel` | `DirectoryPicker.vue` | this gateway's half |
| `invite-result`, `invite-expiry` | `InviteDialog.vue` | an invitation just handed out, and when it stops working |

**Reading a hint.** A field's hint and the refusal that replaces it are read through the
control's `aria-describedby` (`describedBy` in `share-policy.spec.ts`), not through a
Vuetify class — a hint a screen reader cannot find is one a journey should not find
either. Where the field has no such link, the journeys compare the field's text with
what it said a moment earlier, as `setup.spec.ts` does.

**Settings are put back only when a journey changed them.** A journey that must not
write proves it by the absence of a request from its page, and restores nothing: on a
stack other runs share, "restoring" a value this journey never touched overwrites
whatever somebody else set meanwhile. A journey that does write reads the value first
and puts it back in a `finally`, and writes nothing when nothing moved — settings are
sparse, and writing a default back turns it into a choice nobody made.

### plex.tv, which no journey may call

`plex-discovery.spec.ts` signs in to plex.tv, lists the servers of the account and
registers two. plex.tv is `fake-plex-tv.ts`, run inside the journey — the real one would
need an account, somebody approving the request, and the internet. The gateway has to
have been started pointing at it, `MCS_PLEX_TV_URL=http://e2e:32499`, which only the CI
stack does; the journey reads where it listens from `E2E_FAKE_PLEX_TV_PORT` and
`E2E_FAKE_PLEX_TV_URL`, and skips without them. The port is fixed and the name is the
`e2e` service's, given to the journeys' container by `--use-aliases` in `e2e.sh`, because
the gateway is told the address before that container exists.

### What needs a real media server

Almost nothing. The server-structure half of the picker and every library these
journeys need come from `fake-jellyfin.ts`. Three journeys need behaviour only a real
server has, take it from the lab (`docker/lab/`, `make lab/up`) through `lab.ts`, and
skip with the reason when it is not named:

| Journey | Needs | Variables |
|---|---|---|
| `picker.spec.ts` — a Jellyfin walks into a folder it reported | a Jellyfin whose libraries have sub-folders | `E2E_JELLYFIN_URL`, `E2E_JELLYFIN_TOKEN` |
| `picker.spec.ts` — a Plex that cannot walk deeper keeps its folders | a Plex (the lab's is unclaimed and answers without a token) | `E2E_PLEX_URL`, optionally `E2E_PLEX_TOKEN` |
| `users.spec.ts` — somebody signing in through a Jellyfin | an account on that Jellyfin | the two Jellyfin variables, `E2E_JELLYFIN_USER`, `E2E_JELLYFIN_PASSWORD` |

`make e2e/ci` provides them itself, from a Jellyfin and a Plex of its own. By hand:
the addresses are as the *gateway* reaches them, and must be ones no other registration
on that gateway already uses — the gateway refuses one server twice. Give Plex an IP
address or `localhost`, never a container name: it refuses a `Host` it does not know
(its guard against DNS rebinding) with a 401 that reads like a missing token. On a gateway that
has the lab registered as `localhost`, spell it `127.0.0.1`:

```bash
docker compose -f docker/docker-compose.yml --profile e2e run --rm --no-deps \
	-e E2E_JELLYFIN_URL=http://127.0.0.1:8096 -e E2E_JELLYFIN_TOKEN=$(cat var/lab/keys/jellyfin-local.key) \
	-e E2E_JELLYFIN_USER=lab -e E2E_JELLYFIN_PASSWORD=lab -e E2E_PLEX_URL=http://127.0.0.1:32400 \
	e2e npx playwright test picker.spec.ts users.spec.ts
```

The users journey promotes the account it creates to administrator, so its cleanup is an
`afterEach` rather than a `finally`: a `finally` in the body gets no usable request
context once the test has timed out, which is how an early version left two
administrators nobody chose on the gateway it ran against.
