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
| `login-username`, `login-password`, `login-submit` | `Login.vue` | the sign-in form |
| `form-main-error` | `FormMainError.vue` | the form-level error |
| `notify` | `Notify.vue` | a notification |
| `page-title` | `PageHeader.vue` | the current page title |
| `empty-state` | `EmptyState.vue` | the "nothing here" block |
| `service-list`, `service-row`, `service-add`, `service-probe` | services page | the registered services |
| `service-name`, `service-url`, `service-token` | service form | the fields of the add/edit dialog |
| `media-list`, `media-row`, `sync-state`, `quality-chip` | library pages | the index, in either view |
| `library-section`, `library-section-count`, `library-section-empty`, `library-section-all` | `Library.vue` | one band per registered library: its heading, its total, the note it shows when empty, and the "see all" that opens it on its own |
| `media-card`, `media-poster`, `media-poster-placeholder` | poster wall | one tile, its artwork, and what stands in when there is none |
| `source-marks`, `source-mark-local`, `source-mark-remote`, `source-mark-none` | poster wall, list | who holds a media, in the marks a tile has room for |
| `media-missing-count` | poster wall | how many children are missing under a tile |
| `media-select`, `media-select-all` | library pages | picking one media, and everything on the page |
| `library-select-mode`, `library-selection-bar`, `library-selection-clear`, `library-sync-selected` | `Library.vue` | selecting on a grid, and what can be done with a selection |
| `library-view-toggle`, `library-view-grid`, `library-view-list` | `Library.vue` | posters or the dense list |
| `library-everything` | `Library.vue` | browsing across every library at once |
| `media-filters`, `media-search`, `media-service`, `media-library`, `media-kind`, `media-states`, `media-sort`, `media-direction`, `media-clear` | `MediaFilters.vue` | the toolbar above the wall |
| `item-sync`, `item-sync-missing`, `item-matches`, `item-missing-count` | `LibraryItem.vue` | the actions on one media, and what is missing below it |
| `source-picker`, `source-default`, `group-source`, `group-source-ours` | `LibraryItem.vue` | every server that holds it, ours marked, and which one a pull should use |
| `bandwidth-control`, `bandwidth-panel`, `bandwidth-caps` | app bar | the global caps, the live rate, and the caps in force |
| `bandwidth-download`, `bandwidth-upload`, `bandwidth-download-unit`, `bandwidth-upload-unit`, `bandwidth-download-preset`, `bandwidth-upload-preset`, `bandwidth-apply` | bandwidth panel | the presets, the free fields and their units |
| `transfer-list`, `transfer-row`, `transfer-progress` | transfers page | the queue |
| `companion-marks`, `item-companions`, `item-companions-scan` | library pages | what sits beside the file, and the scan offered when it has never been read |
| `peer-list`, `peer-row`, `peer-invite` | peers page | the peers |
| `peer-status`, `peer-approve`, `peer-incoming-hint` | `PeerCard.vue` | a pending link, and the answer an incoming one needs |
| `invite-tab-create`, `invite-tab-accept`, `invite-tab-fingerprint` | `InviteDialog.vue` | the three ways to link two gateways |
| `peer-fingerprint`, `peer-name`, `peer-address`, `peer-add` | `InviteDialog.vue` | linking by fingerprint, with no code |
