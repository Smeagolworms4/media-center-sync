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
| `library-section`, `library-section-count`, `library-section-empty`, `library-section-open`, `library-section-all` | `Library.vue` | one band per merged category: its heading (which opens the category, and is the only door that is always there), its total, the note it shows when empty, and the button offered when the band shows less than it holds |
| `library-section-latest`, `library-section-local` | `Library.vue` | that a band is capped to the newest of its category, and that some of the category is ours |
| `media-breadcrumb`, `media-breadcrumb-step`, `media-breadcrumb-current` | `MediaBreadcrumb.vue` | where you are, from the category down, and the steps back out |
| `media-card`, `media-poster`, `media-poster-placeholder` | poster wall | one tile, its artwork, and what stands in when there is none |
| `source-marks`, `source-mark-local`, `source-mark-remote`, `source-mark-none` | poster wall, list | who holds a media, in the marks a tile has room for; each mark carries `data-origin`, and the group carries `data-origins` |
| `media-missing-count` | poster wall | how many children are missing under a tile |
| `media-select`, `media-select-all` | library pages | picking one media, and everything on the page |
| `library-select-mode`, `library-selection-bar`, `library-selection-clear`, `library-sync-selected` | `Library.vue` | selecting on a grid, and what can be done with a selection |
| `library-view-toggle`, `library-view-grid`, `library-view-list` | `Library.vue` | posters or the dense list |
| `library-everything` | `Library.vue` | browsing across every category at once |
| `media-filters`, `media-search`, `media-service`, `media-library`, `media-kind`, `media-states`, `media-sort`, `media-direction`, `media-clear` | `MediaFilters.vue` | the toolbar above the wall; `media-service` takes several servers at once |
| `media-origins`, `media-origin-<origin>`, `media-sort-fixed` | `MediaFilters.vue` | the four origins — ours, direct, friends, friends of friends — and the note that stands in for the sort control on the overview |
| `item-sync`, `item-sync-missing`, `item-matches`, `item-missing-count` | `LibraryItem.vue` | the actions on one media, and what is missing below it |
| `source-picker`, `source-default`, `group-source`, `group-source-ours`, `group-source-origin` | `LibraryItem.vue` | every server that holds it, ours marked, how far away each one is, and which a pull should use |
| `bandwidth-control`, `bandwidth-panel`, `bandwidth-caps` | app bar | the global caps, the live rate, and the caps in force |
| `bandwidth-download`, `bandwidth-upload`, `bandwidth-download-unit`, `bandwidth-upload-unit`, `bandwidth-download-preset`, `bandwidth-upload-preset`, `bandwidth-apply` | bandwidth panel | the presets, the free fields and their units |
| `transfer-list`, `transfer-row`, `transfer-progress` | transfers page | the queue |
| `companion-marks`, `item-companions`, `item-companions-scan` | library pages | what sits beside the file, and the scan offered when it has never been read |
| `peer-list`, `peer-row`, `peer-invite` | peers page | the peers |
| `peer-status`, `peer-approve`, `peer-incoming-hint` | `PeerCard.vue` | a pending link, and the answer an incoming one needs |
| `invite-tab-create`, `invite-tab-accept`, `invite-tab-fingerprint` | `InviteDialog.vue` | the three ways to link two gateways |
| `peer-fingerprint`, `peer-name`, `peer-address`, `peer-add` | `InviteDialog.vue` | linking by fingerprint, with no code |
| `peer-node-id` | `Peers.vue`, `Peer.vue` | the node identifier — ours, and each peer's |
| `service-library` | `Service.vue` | one library of the service, with everything editable about it |
| `library-name`, `library-alias`, `library-position`, `library-name-save` | `LibraryNameField.vue` | what this gateway calls a library, and where it sits in the order |
| `library-category`, `library-reported-name` | `LibraryNameField.vue` | the category the library merges into, and the name the service reports |
| `category-list`, `category-row`, `category-list-empty` | `CategoryList.vue` | the merged categories, in the order they appear |
| `settings-download-rate`, `settings-upload-rate` | `Settings.vue` | the global caps, where they are actually set |
| `settings-categories-services` | `Settings.vue` | the way from the categories to the screen that edits them |
| `share-rate-summary`, `share-rate-library` | `ShareRateSummary.vue` | the caps actually in force, global and per library |
| `override-dialog`, `override-form`, `override-save`, `override-restore` | `OverrideDialog.vue` | correcting what a media server got wrong, and putting it all back |
| `override-library`, `override-title`, `override-series-title`, `override-year`, `override-season`, `override-episode`, `override-overview`, `override-id-tvdb`, `override-id-tmdb`, `override-id-imdb` | `OverrideDialog.vue` | one correctable field each |
| `override-<field>-was`, `override-<field>-cleared` | `OverrideField.vue` | what the service said about a field, and that it was erased on purpose |
| `dashboard-categories`, `dashboard-category` | `Dashboard.vue` | the merged categories, each opening the wall on its own |
