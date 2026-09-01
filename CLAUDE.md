# CLAUDE.md

Guidance for Claude Code working in this repository.

## Read this first

**Phases 0 to 4 are complete and approved. The next task is Phase 5 (the in-app
announcement inbox), and it needs the operator's go-ahead before you start.**

Phase 4 added `d:\app\modules\announcements\` and eighteen lines across three
existing RUŌOD Lab files. Nothing else there has been touched, and nothing else
may be.

This project was designed and built in a previous session that ran from the
RUŌOD Lab folder (`d:\app`). That session produced an architecture review, then
Phase 0, then Phase 1. Everything decided there is written down here and in
`docs/` — you do not need that conversation, and you should not go looking for
it. If something seems undecided, it is genuinely undecided: ask.

## Project

**RUŌOD Announcement Manager** — the authoring, validation and publishing
tooling for RUŌOD Lab's remote announcements.

```
        ME
         │
         ▼
  Announcement Manager  ──▶  announcements repository  ──▶  GitHub Pages
  (this project)              content/  →  dist/                 │
                              one git commit per publish      Internet
                                                                 │
                                                            RUŌOD Lab
                                                         local state + cache
```

RUŌOD Lab is an offline-first Expo/React Native app for perfumers, living in a
**separate folder** (`d:\app`) and a **separate repository**. It has no
accounts, no backend and no analytics, which is the constraint behind most of
the decisions here.

## The three rules everything else follows from

1. **A remote announcement problem must never break RUŌOD Lab.** No internet,
   bad JSON, an unknown field, a missing image — the app carries on exactly as
   before. An announcement is never a dependency for the app starting.
2. **One validator, two consumers.** The Manager and the app both validate
   through `@ruood/announcement-schema`. They cannot drift, because they are the
   same code. `verifyPublishable` makes this operational: publishing runs the
   *client's own parser* over the exact bytes about to be written.
3. **Publishing is one git commit.** Manifest and images land together or not at
   all, so a partial publication is not a failure mode to handle — it cannot
   occur. Rollback is `git revert`; history is `git log`; auth is whatever git
   already has.

## Status

| Phase | What | State |
| --- | --- | --- |
| **0** | Schema, validator, id rules, version comparison | **Complete** |
| **1** | CLI + core: build, image pipeline, git publish, diff, revert | **Complete** |
| **2** | Manager UI (Vite + React over `core`) | **Complete** |
| **3** | Hardening: Ed25519 signing, staging channel, CI validation | **Complete** |
| **4** | RUŌOD Lab integration: fetcher, eligibility, local state, presenter | **Complete** |
| **5** | In-app announcement inbox (Settings → Announcements) | **NEXT — needs approval** |

**RUŌOD Lab now contains `modules/announcements/`** plus a mount in
`app/(tabs)/_layout.tsx`, two dependencies, and a Jest transform rule. Nothing
else under `d:\app` has been changed, and Phase 5 should keep it that way.

## Commands

```bash
npm install                  # once, at the workspace root
npm run build                # schema → core → cli → ui, in that order (required)
npm test                     # every package
npm run typecheck            # builds first, then typechecks all packages

# signing and channels
node packages/cli/dist/bin.js keygen --repo <path>          # once, per repository
node packages/cli/dist/bin.js publish --repo <path> --sign
node packages/cli/dist/bin.js publish --repo <path> --channel staging --sign
node packages/cli/dist/bin.js verify --repo <path>          # what CI checks

# the CLI, from the workspace root
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js <command> --repo <path to announcements repo>

# the Manager UI, from the workspace root
npm run ui -- --repo <path to announcements repo>     # http://127.0.0.1:4874

# the UI with reloading, in two terminals
npm run ui:api -- --repo <path>    # the API, trusting the Vite origin
npm run ui:web                     # Vite on http://localhost:5173
```

A full check before calling work done:

```bash
npm run build && npm test && npm run typecheck
```

Currently **557 tests across 17 suites** — 306 schema, 159 core, 43 cli, 49 ui.
Each package's suite is counted in its own run; `npm test` runs all four.

RUŌOD Lab has **97 announcement tests across 5 suites** of its own, run there
with `npx jest modules/announcements`.

**Build order is load-bearing.** `core`, `cli` and the `ui` server resolve
`@ruood/announcement-schema` through its built `dist/*.d.ts`, not its source, so
schema must be built first. `npm run build` does this explicitly rather than
relying on npm's workspace ordering.

## Layout

```
packages/
  schema/   @ruood/announcement-schema — the contract. ZERO dependencies,
            platform-neutral, node-testable. Ships into RUŌOD Lab's RN bundle.
  core/     @ruood/announcement-core — build, images, git publish, diff.
  cli/      @ruood/announcement-cli — every operation, headless. `announce`.
  ui/       @ruood/announcement-ui — the Manager. `src/server` is Fastify over
            `core`; `src/web` is the React client; `src/shared` is the wire
            contract both import. Local only, loopback only.
workspace/  gitignored. Holds cloned/scratch announcement repos. `demo/` is a
            working example built end-to-end during Phase 1.
docs/
  ARCHITECTURE.md   the decisions and why. Read before changing any of them.
  SCHEMA.md         every field, every rule, v1.
```

## Invariants — do not break these

### `packages/schema` is zero-dependency and platform-neutral

No `react`, no `react-native`, no `fs`, no `Buffer`, no `process`, no
`Date.now()`. `src/__tests__/isolation.test.ts` sweeps for all of it and fails
if any appears. This is what lets the same validator run under a node-only jest
config and inside a Hermes bundle — break it and "one validator, two consumers"
stops being true.

### `now` is always injected

Nothing anywhere reads the clock. Scheduling rules that read the clock cannot be
pinned to a fixed instant, so they cannot be tested. Every function takes `now`.

### Ids are permanent and never reused

An id keys impression state on every device, and that state outlives the
announcement by up to a 60-day grace period. A reused id inherits the previous
announcement's impression counters, so the replacement silently fails to show
for exactly the users paying attention. `content/retired-ids.json` is the
ledger; a corrupt ledger refuses the build rather than reading as "nothing is
retired".

`checkIdAvailable` reports **retired before duplicate** — an id can be both, and
that is the broken state where a retired id was recreated.

### Fail closed on the unknown, tolerate unknown fields

- Unknown enum value (`surface`, `trigger`, `dismiss`, `category`, `platform`,
  `action.type`), or a `minSchema` from the future → **skip that record**. Never
  substitute a default.
- Unknown *optional field* → **keep the record**. Forward compatibility requires
  it, or a v2 field would strand every v1 install.
- The one exception: a missing `paused` reads as `false`, because failing to the
  suppressed side would let a dropped field silence every announcement.

### `action.target` is a closed enum, never a URL

`ROUTE_TARGETS` in `packages/schema/src/routes.ts` is the complete set of places
an announcement may send a user. A compromised repository can then only reach a
screen that already exists. Nothing destructive is on that list and nothing
destructive may be added — an announcement points at a place, never at an
operation. External links are `https:` only, no embedded credentials, to an
allowlisted host.

### Announcement text is plain text

The validator refuses angle brackets and control characters so stored text can
never read as markup, whatever a future renderer does. No HTML, no
markdown-with-links, no WebView.

### The kill switch is sticky

`paused` at the manifest root suppresses everything. When a build does not
specify it, the **currently published value carries forward**. Defaulting to
`false` meant publishing a fix during an incident silently turned the switch
back off for every install at once.

### Derived, never stored

`scheduled` / `active` / `expired` are computed from the dates by
`deriveLifecycleStatus`. Only `draft`, `published`, `paused` and `archived` are
stored. A stored copy would disagree with the dates the moment one was edited.
(Same discipline as `usedInFormulas` in RUŌOD Lab.)

### `rev` is the re-show switch, and it is separate from every other edit

Bumping `rev` resets impression counters on every device. Correcting a typo and
deciding a million devices should see the message again are different
intentions; the CLI keeps them as different commands and the publish diff calls
a `rev` change out in capitals.

### The UI is a second front end, never a second implementation

Every operation the Manager performs is a `core` function the CLI already
calls. The server maps HTTP onto `core` and back; it decides nothing. If the UI
needs behaviour `core` does not have, it goes into `core` and gets a CLI command
too — `applyEdits` / `announce edit` and `attachImage` are both that rule being
followed, not exceptions to it.

The consequence worth protecting: you can always publish when the UI is broken,
and the two front ends cannot disagree about what "archive" means.

### The editable field set is closed

`applyEdits` in `packages/core/src/content/edit.ts` is the only way a form
writes a record, and it **refuses** anything outside its list rather than
dropping it — a caller that sends `status` has a bug, and a silent drop looks
like a successful save. The three that are excluded each have their own
operation, and each for its own reason:

| Field | Why not editable | Use |
| --- | --- | --- |
| `id` | keys impression state on every device | nothing; it is immutable |
| `status` | the legal moves are a table | `applyTransition` |
| `rev` | bumping it re-shows to everyone | `bumpRevision` |

`rev` is deliberately absent from the editor form and behind its own
confirmation. The whole point of it being a separate field is lost the moment it
can be changed while editing a typo.

### The Manager server is loopback-only, and checks who is calling

It can write `content/`, commit, and push to the repository every install reads,
so it binds `127.0.0.1` and nothing else. `packages/ui/src/server/guards.ts`
adds the two checks that matter for a port a browser can reach: the `Host`
header must name loopback (a DNS-rebinding request arrives carrying the
attacker's hostname), and `Origin`, when present, must be one we serve. Mutations
must be `application/json` or `application/octet-stream` — neither is a type an
HTML form can produce, so a cross-site form post cannot reach a route at all.

There is no token and no session, deliberately: those would be state to store,
and the checks above do not need any.

### The preview is approximate, and says so on screen

`packages/ui/src/web/theme/ruood.css` holds RUŌOD Lab's tokens **copied**, with
the source files named in the comment. It is not a shared component and must not
become one — that would be a dependency between two repositories with different
release cycles, to buy pixel fidelity in a preview. Four frames always: 360 and
430 wide, light and dark.

It renders body text as text, never as HTML. The validator refuses angle
brackets so stored text can never read as markup, and the preview is the one
place that could quietly make that false.

### The signature covers the whole manifest, not each record

`signature` and `keyId` sit on the manifest envelope, and the covered bytes are
`manifestSigningInput` — the canonical COMPACT form of the envelope with
`signature` removed and `keyId` left in.

The per-record `signature` field is still reserved and still unused. It is not
what secures the file, because the three highest-impact tampering targets are
not inside any record:

| Target | What a per-record signature would allow |
| --- | --- |
| `paused` | flip the kill switch on or off for every install |
| `revision` | replay an old manifest as a current one |
| the record set | delete an announcement, forging nothing |

Compact rather than pretty, because `dist/announcements.json` is pretty-printed
so it diffs like source and a signature must not break when a file is
reformatted. Unknown fields are covered too — tolerating an unknown field is a
rule about what a client may still read, never a licence to leave it
unauthenticated.

### The schema package still carries no crypto

`signing.ts` defines *what* is signed and what a verdict means. The Ed25519
itself is injected: `nodeSignatureVerifier` in the Manager, and a
Hermes-compatible implementation in RUŌOD Lab in Phase 4. The isolation sweep
bans `node:crypto` alongside `fs` and `Buffer` for exactly this reason — a
`crypto` import here would end "one validator, two consumers".

### A signature that does not verify refuses the WHOLE file

`parseManifest` checks the signature before it reads a single record. There is
no "signed by an unknown key, so show it anyway" and no salvaging of records
from a file that failed — either would make pinning decorative.

Checking is opt-in on the client having both keys and a verifier, so a build
from before signing behaves exactly as it did. `requireSignature` is separate
again, because "start checking" and "start requiring" roll out at different
times; requiring a signature the build cannot check fails closed.

### The private key never enters a repository

`saveSigningKey` refuses a path inside one, by path containment rather than by
trusting a `.gitignore` — the failure being prevented is precisely the one where
the ignore rule is missing or was added after the first commit. The **public**
key is committed on purpose, and a publish stages `keys/` so it travels with the
first signed manifest rather than waiting to be remembered.

Rotating is an app release: the public key is compiled into RUŌOD Lab, so a new
key means every install on the old build rejects everything until it updates.
`keygen` refuses to overwrite without `--force`.

### Staging is a channel, not a branch

`dist/staging/announcements.json` in the same repository, published by its own
commit. It carries **drafts** as well as everything production gets — that is
what it is for, and a staging manifest that excluded them would be a copy of
production. Archived and expired records stay out of both.

One publish is one channel and therefore one commit. Each stays atomic, each
gets its own line in `git log`, and rolling back staging does not roll back
production.

### CI verifies, it does not re-validate

`scripts/verify-manifest.mjs` is scaffolded into the announcements repository
because what it has to catch is a commit the Manager did not produce. Every
field rule was already enforced at publish time by `verifyPublishable`; CI asks
the one question publish time cannot: *is this still the file that was signed?*

It carries its own `canonicalCompactJson`, and that duplication is deliberate —
its whole value is depending on nothing but the Node CI already has. If the copy
drifts, CI fails on every correctly signed manifest: loud, immediate, and never
quietly permissive.

Revision 0 is the scaffolded placeholder and is skipped by both CI and
`announce verify`. A build always increments, so nothing else can be 0.

### RUŌOD Lab carries a COPY of the schema, and it is checked

`d:\app\modules\announcements\schema/` is `packages/schema/src` verbatim,
copied by `scripts/sync-schema.mjs` and carrying a generated header.

Copied rather than depended on, because RUŌOD Lab is a separate repository that
builds on EAS where this workspace does not exist: a `file:` dependency resolves
on one machine and nowhere else, and the package is not published. "One
validator, two consumers" survives because the copy is byte-identical:

```bash
npm run schema:check -- --to d:/app/modules/announcements/schema   # before shipping
npm run schema:sync  -- --to d:/app/modules/announcements/schema   # after a change
```

Run the check whenever the schema changes. The one way this arrangement fails is
somebody editing the copy.

### The app's crypto is injected, and only verifies

`@noble/ed25519` with `@noble/hashes` for SHA-512, both pure JavaScript with no
dependencies and nothing native. The **synchronous** path, because Hermes has no
`crypto.subtle` and noble's async API reaches for it. Verification only — no key
generation, no signing, so no secure random source is needed.

`modules/announcements/__tests__/verifier.test.ts` deletes `globalThis.crypto`
for its whole run and signs with `node:crypto`, so it proves the two
implementations agree about the covered bytes rather than proving the plumbing.

### Nothing in the app is on the startup path

`useAnnouncements` does nothing until `isAppReady`, then waits for
`InteractionManager.runAfterInteractions`, then reads one key and fetches.
Never awaited by anything. `AnnouncementHost` is mounted beside `AppModalHost` —
NOT in the provider stack, because it has no dependents — and wraps itself in an
error boundary that drops the presenter for the session rather than letting a
render error reach the tab tree.

Every layer below returns values instead of throwing. The boundary is there
because "an announcement broke RUŌOD Lab" is the one outcome the whole design
exists to make impossible.

### The app's storage key is `@perfumery/announcements`

Under that prefix deliberately: `use-factory-reset.ts` already sweeps
`@perfumery/`, so "Factory Reset clears announcements and they re-show" holds
with no wiring and no special case anyone has to remember. It is equally
deliberately absent from the backup's explicit key list — announcement state is
device-and-session shaped, like OAuth tokens and the undo history.

### Sub-targets land on their parent tab

Nine of the fourteen `ROUTE_TARGETS` name things that are not routes. Reports,
Data Management, Backup, Units and the rest are `useState` flags inside
`ToolsScreen` and `SettingsScreen` that open an in-tree modal, so there is
nothing to navigate to.

`modules/announcements/navigation.ts` maps each of them to the tab that owns it.
Opening them properly would mean teaching both screens to accept an external
"open this" signal — a change to two large screens that have nothing to do with
announcements, and one to make deliberately rather than as a side effect.

## Where the complexity lives

| File | What |
| --- | --- |
| `packages/schema/src/validate-record.ts` | The one record validator, `authored` and `published` modes |
| `packages/core/src/build/build.ts` | The build: project → images → serialise → verify |
| `packages/core/src/publish/publish.ts` | Nothing irreversible until everything reversible has succeeded |
| `packages/core/src/publish/diff.ts` | Pure. What a publish would change, in words |
| `packages/core/src/git/repository.ts` | One commit per publish; rebase-once on rejection, never force |
| `packages/core/src/content/edit.ts` | The closed editable set, and why each exclusion is excluded |
| `packages/core/src/images/attach.ts` | Encode, keep exactly one original per id, read bytes back for a preview |
| `packages/ui/src/server/guards.ts` | Who may call a local server that can push |
| `packages/ui/src/web/screens/editor.tsx` | The form; validates live with the app's own validator |
| `packages/ui/src/web/screens/publish.tsx` | Dry run, read the diff, then confirm |
| `packages/schema/src/signing.ts` | What a signature covers, and what a verdict means |
| `packages/core/src/signing/keys.ts` | Making a key, and keeping it out of a repository |
| `packages/core/src/ci/files.ts` | The dependency-free check CI runs in the announcements repo |

In RUŌOD Lab (`d:\app\modules\announcements/`):

| File | What |
| --- | --- |
| `eligibility.ts` | Pure. Which announcement may be shown, and why one may not |
| `state.ts` | Pure. The one storage key, and the 60-day retention rule |
| `fetcher.ts` | Conditional GET, the 6-hour window, a raced timeout |
| `service.ts` | fetch → verify → store, in that order, never the reverse |
| `verifier.ts` | Ed25519 for Hermes, and the two encoders it needs |
| `navigation.ts` | The closed target table, and where each one actually lands |
| `use-announcements.ts` | Off the startup path, and never awaited |

Two things in `git/repository.ts` are non-obvious and were bugs once:

- `isRepository()` must ask `CheckRepoActions.IS_REPO_ROOT`, not plain
  `checkIsRepo()` — the latter is true for any *subdirectory* of any repository,
  so scaffolding inside an existing checkout skipped `git init` and every later
  publish committed into the enclosing project.
- A rejected push is rebased once and retried. Never `--force`.

## The Manager UI (Phase 2, built)

A **local** web app. Not deployed, not public, run on the operator's own machine
against one repository chosen at startup — there is no route that takes a path,
so no request can point the Manager at another checkout.

```
browser  ──HTTP──▶  Fastify (src/server)  ──▶  @ruood/announcement-core  ──▶  the repo
   │                        │
   └── src/web (React)      └── the only things a browser cannot do:
       imports the schema       the filesystem, git, sharp
       package directly and
       validates as you type
```

**Screens.** Dashboard (counts by derived lifecycle state, publication state,
git state), the record list with search and filter, the editor, the image attach
and preview, the publish flow with its dry-run diff and confirmation, and the
repository screen with `git log`, push and revert.

**Endpoints.** `GET /api/state` answers the whole shell in one round trip;
records are `GET|POST|PATCH|DELETE /api/records[/:id]` plus `/transition`,
`/bump` and `/image`; publishing is `POST /api/validate`, `/api/build`,
`/api/publish`, and `/api/git/{log,push,revert}`. `POST /api/publish` **defaults
to a dry run** — a malformed request must never be the one that commits.

**Dates** are authored in local time, stored as UTC instants, and displayed back
with the offset they are being shown in (`src/web/format.ts`).

Postponed deliberately: rich content, localisation (the schema leaves room —
`title`/`body` stay plain strings in v1 and an optional `i18n` map is a
non-breaking v2 addition), templates, A/B testing, analytics.

Not built, and worth knowing you have not got: no undo beyond `git revert`, no
concurrent-operator handling (one Manager against one checkout is the assumption
throughout), and no auth (the loopback bind and the guards are what stand in for
it).

## Known issues

### `sharp` carries a high-severity advisory (inherited from Phase 1)

`npm audit` reports `sharp <0.35.0` with inherited libvips CVEs
(CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591). The fix is
`sharp@0.35.x`, a **breaking major bump** to the one dependency the image
pipeline is built on.

Deliberately not fixed yet, and not a blocker: `sharp` runs only in the
operator's own Manager process, over images the operator chose themselves. It
is never in RUOOD Lab, never on a device, and never fed anything from the
network. Revisit it as its own piece of work — bump, then run the image tests
in `packages/core/src/__tests__/pipeline.test.ts`, which encode real bytes and
assert on the output — rather than folding it into an unrelated phase.

## Conventions

- Files are kebab-case; exports are named. Pure logic separated from I/O so it
  can be unit-tested — the split in `core` between `build/project.ts`,
  `publish/diff.ts`, `content/authoring.ts` (pure) and everything else (impure)
  is the pattern to copy.
- Tests live in `__tests__/` beside what they test. Fixtures build **valid**
  records so a test asserting "exactly one error" has a clean baseline.
- Comments explain *why*, especially where a decision looks arbitrary or where
  something was a bug. Match the surrounding density.
- Dev environment is Windows/PowerShell. Scope recursive searches to `packages/`
  — a repo-wide search walks `node_modules/`.

## When in doubt

`docs/ARCHITECTURE.md` records the reasoning behind every structural choice, and
`docs/SCHEMA.md` is the field-by-field contract. If a change would contradict
either, that is a conversation with the operator, not a refactor.
