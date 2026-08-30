# RUOOD Announcement Manager

Authoring, validation and publishing tooling for RUOOD Lab's remote
announcements.

This is a **separate project** from RUOOD Lab (`d:\app`). Neither repository
imports the other. The only thing they will ever share is the
`@ruood/announcement-schema` package in this workspace, which is copied or
linked into RUOOD Lab in Phase 4.

> The folder is ASCII-named (`RUOOD-`, not `RUŌOD-`) to match the existing
> project's own convention — `ruood-lab`, `com.ruood.lab`, `RUOOD Lab`. The
> user-facing name is still **RUŌOD**.

## The system

```
        ME
         │
         ▼
  Announcement Manager  ──▶  announcements repository  ──▶  GitHub Pages
  (this project)              content/  →  dist/                 │
                              one git commit per publish      Internet
                                                                 │
                                                            RUOOD Lab
                                                         local state + cache
```

Three rules the design exists to hold:

- **A remote announcement problem must never break RUOOD Lab.** Every failure
  path — no internet, bad JSON, an unknown field, a missing image — leaves the
  app working exactly as it did before.
- **One validator, two consumers.** The Manager and the app share this
  workspace's schema package, so a manifest the Manager will publish is a
  manifest the app can read. They cannot drift, because they are the same code.
- **Publishing is one git commit.** JSON and images land together or not at
  all, so a partial publication is not a failure mode to handle — it cannot
  occur.

## Status

| Phase | What | State |
| --- | --- | --- |
| **0** | Schema, validator, id rules, version comparison | **Complete** |
| 1 | CLI + announcements repository: build, image pipeline, git publish | Not started |
| 2 | Manager UI (Vite + React) | Not started |
| 3 | Hardening: Ed25519 signing, staging channel, CI validation | Not started |
| 4 | RUOOD Lab integration: fetcher, eligibility, local state, presenter | Not started |
| 5 | In-app announcement inbox | Not started |

Nothing in RUOOD Lab has been modified, and nothing will be until Phase 4.

## Layout

```
packages/
  schema/     @ruood/announcement-schema — the contract. Zero dependencies,
              platform-neutral, node-testable. Ships into RUOOD Lab's bundle.
  core/       (Phase 1) build, image pipeline, git publish
  cli/        (Phase 1) validate | build | publish | revert | status
  ui/         (Phase 2) the local web UI
workspace/    (Phase 1) the cloned announcements repo — gitignored
docs/         architecture and schema reference
```

## Commands

```bash
npm install                              # once, at the workspace root
npm test                                 # every package
npm run typecheck                        # every package
npm run build                            # every package

npm test --workspace @ruood/announcement-schema
```

A full check before calling work done:

```bash
npm run typecheck && npm test && npm run build
```

Currently **255 tests across 7 suites**, all in `packages/schema`.

## Reading order

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the decisions and why.
2. [docs/SCHEMA.md](docs/SCHEMA.md) — every field, every rule.
3. `packages/schema/src/types.ts` — the contract itself.
