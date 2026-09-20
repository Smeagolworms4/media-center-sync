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

## The gateway nobody has claimed yet

`setup.spec.ts` is the one file that cannot run against the stack the others use. The
setup screen exists only while no account exists, and that stack has one from its first
minute — every journey pointed at it would be redirected to the sign-in page and would
then pass by asserting nothing. So it runs against a second gateway, named by two
variables, and is skipped when they are absent.

Raise one beside the running stack — a spare port, its own database file, and nothing
that would create an administrator for it:

```bash
cd packages/api
API_PORT=4321 PEER_PORT=4311 DB_FILE=var/journey-setup.db MCS_JWT_SECRET=journeys \
	npm exec ts-node -- -r tsconfig-paths/register src/main.ts

cd packages/front
FRONT_PORT=3321 API_PROXY_TARGET=http://localhost:4321 npm exec vite -- --host 0.0.0.0
```

```bash
E2E_SETUP_BASE_URL=http://localhost:3321 E2E_SETUP_API_URL=http://localhost:3321/api \
	npx playwright test setup.spec.ts
```

Claiming is what the third journey does, and it is the last thing that can ever be done
on that gateway: deleting `packages/api/var/journey-setup.db` is what makes the file
runnable a second time. Delete it when you are done — a database file left behind is a
gateway with an administrator nobody chose.
