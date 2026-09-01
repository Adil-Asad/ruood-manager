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
| **1** | CLI + core: build, image pipeline, git publish, diff, revert | **Complete** |
| **2** | Manager UI (Vite + React over `core`) | **Complete** |
| **3** | Hardening: Ed25519 signing, staging channel, CI validation | **Complete** |
| **4** | RUOOD Lab integration: fetcher, eligibility, local state, presenter | **Complete** |
| **5** | In-app announcement inbox (Settings → Announcements) | **Complete** |

RUOOD Lab now contains `modules/announcements/`, which carries a checked copy
of the schema package:

```bash
npm run schema:check -- --to d:/app/modules/announcements/schema
npm run schema:sync  -- --to d:/app/modules/announcements/schema
```

## Layout

```
packages/
  schema/     @ruood/announcement-schema — the contract. Zero dependencies,
              platform-neutral, node-testable. Ships into RUOOD Lab's bundle.
  core/       build, image pipeline, git publish, diff, revert
  cli/        announce: init | new | edit | image | activate | publish | revert | ...
  ui/         the Manager — a local web UI over core. Loopback only, never
              deployed. server/ is Fastify, web/ is React, shared/ is the
              wire contract.
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

# the Manager UI, against an announcements repository
npm run ui -- --repo workspace/demo        # then open http://127.0.0.1:4874

# signing, once per announcements repository
npm run announce -- keygen --repo <path>
npm run announce -- publish --repo <path> --sign
npm run announce -- verify --repo <path>
```

The UI is a second front end over the same `core` functions the CLI calls, so
anything it can do the CLI can do too — which is what makes it safe for it to be
the convenient way rather than the only way.

A full check before calling work done:

```bash
npm run typecheck && npm test && npm run build
```

Currently **564 tests across 18 suites** — 313 schema, 159 core, 43 cli, 49 ui.

## Reading order

1. [CLAUDE.md](CLAUDE.md) — the working brief, invariants, and what is next.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the decisions and why.
3. [docs/SCHEMA.md](docs/SCHEMA.md) — every field, every rule.
4. `packages/schema/src/types.ts` — the contract itself.
