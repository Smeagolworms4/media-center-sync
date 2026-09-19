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
| `media-list`, `media-row`, `sync-state`, `quality-chip` | library pages | the index |
| `transfer-list`, `transfer-row`, `transfer-progress` | transfers page | the queue |
| `peer-list`, `peer-row`, `peer-invite` | peers page | the peers |
