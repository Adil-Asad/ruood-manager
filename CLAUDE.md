# CLAUDE.md

Guidance for Claude Code working in this repository.

## Read this first

**Phases 0 and 1 are complete and approved. The next task is Phase 2 (the
Manager UI), and it needs the operator's go-ahead before you start.**

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
| **2** | Manager UI (Vite + React over `core`) | **NEXT — needs approval** |
| 3 | Hardening: Ed25519 signing, staging channel, CI validation | Not started |
| 4 | RUŌOD Lab integration: fetcher, eligibility, local state, presenter | Not started |
| 5 | In-app announcement inbox (Settings → Announcements) | Not started |

**Nothing in RUŌOD Lab has been modified, and nothing may be until Phase 4.**
Do not create or change files under `d:\app`.

## Commands

```bash
npm install                  # once, at the workspace root
npm run build                # schema → core → cli, in that order (required)
npm test                     # every package
npm run typecheck            # builds first, then typechecks all packages

# the CLI, from the workspace root
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js <command> --repo <path to announcements repo>
```

A full check before calling work done:

```bash
npm run build && npm test && npm run typecheck
```

Currently **377 tests across 12 suites** — 279 schema, 98 core, 25 cli (the cli
suite is counted in its own run; `npm test` runs all three).

**Build order is load-bearing.** `core` and `cli` resolve `@ruood/announcement-schema`
through its built `dist/*.d.ts`, not its source, so schema must be built first.
`npm run build` does this explicitly rather than relying on npm's workspace
ordering.

## Layout

```
packages/
  schema/   @ruood/announcement-schema — the contract. ZERO dependencies,
            platform-neutral, node-testable. Ships into RUŌOD Lab's RN bundle.
  core/     @ruood/announcement-core — build, images, git publish, diff.
  cli/      @ruood/announcement-cli — every operation, headless. `announce`.
  ui/       (Phase 2 — does not exist yet)
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

## Where the complexity lives

| File | What |
| --- | --- |
| `packages/schema/src/validate-record.ts` | The one record validator, `authored` and `published` modes |
| `packages/core/src/build/build.ts` | The build: project → images → serialise → verify |
| `packages/core/src/publish/publish.ts` | Nothing irreversible until everything reversible has succeeded |
| `packages/core/src/publish/diff.ts` | Pure. What a publish would change, in words |
| `packages/core/src/git/repository.ts` | One commit per publish; rebase-once on rejection, never force |

Two things in `git/repository.ts` are non-obvious and were bugs once:

- `isRepository()` must ask `CheckRepoActions.IS_REPO_ROOT`, not plain
  `checkIsRepo()` — the latter is true for any *subdirectory* of any repository,
  so scaffolding inside an existing checkout skipped `git init` and every later
  publish committed into the enclosing project.
- A rejected push is rebased once and retried. Never `--force`.

## Phase 2 — the Manager UI (what to build when approved)

A **local** web app. Not deployed, not public, run on the operator's own
machine.

- **Vite + React + TypeScript**, with a thin local Fastify server for the things
  a browser cannot do: filesystem, git, `sharp`.
- **It calls `core`. It re-implements nothing.** Every operation already exists
  as a `core` function the CLI calls; the UI is a second front end over the same
  functions. If the UI needs behaviour `core` does not have, add it to `core`
  and expose it in the CLI too.
- Screens: dashboard (counts by lifecycle state), the record list with
  search/filter, the editor, the image attach + preview, the publish flow with
  the dry-run diff and its confirmation, and repository status.
- **The preview is approximate, and says so.** Share RUŌOD Lab's design tokens
  (colours, radii, type scale) by copying them; do NOT build a shared
  React-Native-and-web component. Two widths (360 and 430) and both themes.
- Dates are authored in local time and **displayed back with their offset**,
  stored as UTC instants.

Postponed deliberately: rich content, localisation (the schema leaves room —
`title`/`body` stay plain strings in v1 and an optional `i18n` map is a
non-breaking v2 addition), templates, A/B testing, analytics.

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
