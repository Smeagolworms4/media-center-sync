# Working in this repository

Read `README.md` first — it explains what the product does and why the important
choices were made. This file is about how to work on it.

## Ground rules

- **Everything is in English**: code, comments, identifiers, documentation, commit
  messages. The only French in the repository is `README.fr.md` and the French
  message catalogue, which are translations, not sources.
- **Tabs for indentation**, width 4. Single quotes, semicolons, trailing commas in
  multiline literals. `.editorconfig` and the lint configs enforce it; do not fight
  them.
- **Comments explain why, never what.** Write prose, in full sentences, where a
  reader would otherwise make a wrong assumption or repeat a mistake somebody already
  made: why a default is what it is, what breaks silently if a line is removed, which
  of two plausible approaches was rejected and what it cost. A file with no trap in it
  needs nothing beyond a short doc block saying what it is for. Never narrate what the
  next line obviously does.
- **Error messages are keys, not sentences.** The API answers `error.service.not_found`
  and the interface decides the wording. Every key lives in `ErrorKey` in
  `packages/shared`, and every key has an entry in both message catalogues.

## Layers, and why they are strict

This is the part of the project worth protecting.

### API

```
controllers/   HTTP only: route, validate the DTO, check the right, call a manager,
               return. No business rule, no query beyond the trivial.
managers/      The business layer. Decides. Knows nothing about HTTP — no request,
               no response, no status code.
repositories/  Database access only. Knows how to read and write, never which row
               the caller is allowed to see.
services/      Technical capability: talking to a media server, hashing, moving
               bytes, scheduling. Does what it is asked; does not decide whether it
               should be asked.
entities/      The persistence model.
models/        Request and response shapes (DTOs), validated by class-validator.
```

If you find yourself writing `if (user.role === …)` in a repository, or opening a
`fetch` in a manager, the code is in the wrong file. Rights are tested with
`@Granted(Right.X)` on the route — never a role, anywhere, because the role hierarchy
will change and the routes should not.

### Interface

Components display. Stores hold state and talk to the API. Composables hold reusable
logic. A component never builds a URL or calls `fetch`, and a store never renders.

Keep components small and single-purpose. A state icon, a quality chip, a progress
bar: one component each, used everywhere, so a given state never means two things in
two places.

Forms go through `useForm()`. It gives you `loading`, `mainError`, `field(name)` and
the mapping of backend validation errors onto the right inputs. Pair it with
`FormMainError`. `src/pages/Login.vue` is the reference implementation — copy its
shape rather than inventing a new one.

## Adding things

- **A media service type** (Emby, Kodi, an HTTP index): write one class in
  `src/services/handlers/` implementing the handler interface, decorate it with
  `@MediaHandler(type)`, add the value to `MediaServiceType` in `packages/shared`.
  Nothing else in the application should need to change. If it does, the abstraction
  leaked and that is the bug to fix.
- **A transport** (a new way to move bytes): same pattern under
  `src/services/transport/`.
- **An authentication provider**: same pattern again. Authentication is a provider
  interface precisely so that the answer to "can we sign in with X" is always yes.
- **A setting**: add it to the `Settings` shape in `packages/shared` with a doc
  comment explaining what it is for, and to the defaults in `settings.service.ts`.
  Settings are key/value rows, so this costs a write, not a migration — and a gateway
  running an older image simply finds a key it does not know and uses its default.

## Migrations

`synchronize` is off, always. Every schema change is a migration, and every migration
has to run on **both SQLite and PostgreSQL**:

- build tables with TypeORM's `Table`/`TableIndex` objects rather than raw SQL, so the
  driver renders the right dialect;
- stay inside the column types both understand: `varchar`, `text`, `int`, `float`,
  `bigint`, `boolean`, `datetime`, and `text` for `simple-json`;
- primary keys are application-generated UUIDs stored as `varchar(36)` —
  `uuid_generate_v4()` does not exist on SQLite.

Generate with `make db/migration NAME=AddSomething`, then read what came out. A
generated migration is a draft, not a result.

## Tests

Three layers, three questions:

- **Unit** (`src/**/*.spec.ts`) — mock everything around the unit. A manager is tested
  against fake repositories, so a failure names the rule that broke rather than the
  stack underneath it. This is where the correlation strategies, the quality
  comparator, the chunk planner and the revalidation decision table are pinned down.
- **Functional** (`packages/api/test/**`) — boot the real application over an
  in-memory database, talk to it over HTTP. The only thing that proves the guards, the
  validation pipe and the serialisation actually apply.
- **Journeys** (`packages/front/tests/e2e/**`) — a real browser against the running
  stack. The only place you find out a button stays grey or a stream stopped pushing.

Write tests that assert behaviour, not that a method was called. Mock with `jest.fn()`
or `vi.fn()` and plain objects; no mocking framework. Never hit a real media server or
a real peer in a test.

```bash
make check        # types, lint, unit and functional — what the pipeline runs
make api/test-watch
make e2e          # journeys, against the stack you already have up
```

## Running things

Everything is in containers. `make` with no target lists the lot; the ones you need
daily are in the README. Two habits worth keeping:

- `make doctor` before assuming something is broken — it says what is up, on which
  ports, and whether the API considers itself healthy.
- `make library/check` after touching mounts. A library where the gateway's path and
  the media server's path do not designate the same directory accepts transfers that
  the server will never see, and nothing anywhere reports an error.

## Commits

One coherent change per commit. The subject says what changed, in the imperative or as
a noun phrase; the body says **why**, and what the alternative would have cost. A
commit that only restates its diff has an empty body — that is fine, but most changes
worth making have a reason worth writing down.

Never commit `.env.local`, a token, a library path from your own machine, or anything
under `var/`.
