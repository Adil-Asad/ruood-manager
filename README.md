# RUOOD Manager

The administration application for RUOOD Lab, and the tooling behind it.

**Announcements are its first module.** The product is a general
administrative client rather than an announcement tool that grew a UI, and
the shape reflects that: `packages/mobile` is RUOOD Manager, and everything
announcement-specific lives in packages named for announcements. Later
modules - subscriptions, and whatever follows - are additions beside this
one, not a rewrite of it.

This is a **separate project** from RUOOD Lab (`d:\app`). Neither repository
imports the other. The only thing they will ever share is the
`@ruood/announcement-schema` package in this workspace, which is copied or
linked into RUOOD Lab in Phase 4.

> The folder is ASCII-named (`RUOOD-`, not `RUŌOD-`) to match the existing
> project's own convention — `ruood-lab`, `com.ruood.lab`, `RUOOD Lab`. The
> user-facing name is still **RUŌOD**.

## The system

```
   Android Manager                    announcements repository
   (Expo/RN)                          ────────────────────────
     signs in with GitHub  ─────────▶   content/   ← the app commits here
     device flow, no pasted token         │
     never holds a signing key            │  .github/workflows/publish.yml
                                          ▼  sharp → build → verify → SIGN
   CLI (announce)  ────────────────▶    dist/  ──▶  GitHub Pages  ──▶  RUOOD Lab
   local checkout, same core                                       local state + cache
```

**There is no server.** The app writes `content/` through the GitHub API, and a
workflow in the announcements repository encodes the images, builds the
manifest, verifies it with the client's own parser, signs it, and commits
`dist/`. Nothing depends on a particular machine being awake, and a lost phone
is recovered by installing the app and signing in again.

The signing key is a secret of that workflow. It is not on the phone, not in the
app, and not on anybody's laptop — see [docs/OPERATING.md](docs/OPERATING.md).

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
| **6** | The Manager as an Android application (Expo/EAS) | **Complete** |

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
  authoring/  the PURE record operations — createRecord, applyEdits,
              applyTransition — and the repository-relative paths. Shared by the
              phone and the publishing build, so they cannot disagree about what
              an edit means. Zero platform imports, swept.
  core/       build, image pipeline, git publish, diff, revert, SIGNING.
              Server-side only — it reaches for fs, sharp and git.
  client/     the platform-neutral plumbing: the injected HTTP port, the
              credential-store port, base64, and the presentation helpers.
  github/     device flow, the Git Data API, and content/ as announcements.
              Platform-neutral; addresses the repository at runtime, so it holds
              no announcement content and no hard-coded repository.
  cli/        announce: init | new | edit | image | activate | publish | revert | ...
              Also what the publishing workflow runs.
  mobile/     RUOOD Manager for Android — Expo / React Native, a client
              of GitHub. Never holds the signing key.
workspace/    cloned/scratch announcement repos — gitignored
docs/         operating guide, architecture, schema reference, Android/EAS
```

## Commands

```bash
npm install                              # once, at the workspace root
npm test                                 # every package
npm run typecheck                        # every package
npm run build                            # every package

npm test --workspace @ruood/announcement-schema

# the CLI, against an announcements repository. It does everything.
npm run announce -- help
npm run announce -- keygen  --repo <path>          # once, per repository
npm run announce -- publish --repo <path> --sign
npm run announce -- verify  --repo <path>
```

The CLI and the app are front ends over the same functions, so anything one can
do the other can — which is what makes the app safe to be the convenient way
rather than the only way. You can always publish from a terminal, and the two
cannot disagree about what "archive" means, because `applyTransition` is one
function in one package that both import.

### The Android Manager

Setup is one-time and lives in [docs/OPERATING.md](docs/OPERATING.md): create a
GitHub App with **Contents: write** and **Device Flow** enabled (and *not*
Workflows), put the signing key in the announcements repository as
`ANNOUNCEMENT_SIGNING_KEY`, and add the workflow.

```bash
# Everything the app needs is compiled in, and none of it is a secret: a
# device-flow client has no client secret, and the repository is public.
GITHUB_CLIENT_ID=Iv1.xxxx ANNOUNCEMENTS_OWNER=Adil-Asad ANNOUNCEMENTS_REPO=ruood-announcements   npx eas build --profile preview --platform android

# Build, typecheck, lint and validate the app itself:
npm run bundle    -w @ruood/announcement-manager-android   # the shipping JS bundle
npm run prebuild  -w @ruood/announcement-manager-android   # a real AndroidManifest
npm run typecheck -w @ruood/announcement-manager-android
npm run lint      -w @ruood/announcement-manager-android
npm run doctor    -w @ruood/announcement-manager-android
```

**The announcement signing key is never in the Android application.** It stays
at `~/.ruood/announcement-signing.key` on the operator's machine; the app asks
that machine to sign and cannot sign anything itself. Android app signing (EAS
and Play) and RUOOD announcement signing (key id `2bc1e956`) are separate
mechanisms that share nothing — [docs/ANDROID.md](docs/ANDROID.md) is explicit
about both.

A full check before calling work done:

```bash
npm run build && npm test && npm run typecheck
```

Currently **671 tests across 23 suites** — 313 schema, 159 core, 43 cli,
41 client, 75 ui, 40 mobile.

## Reading order

1. [CLAUDE.md](CLAUDE.md) — the working brief, invariants, and what is next.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the decisions and why.
3. [docs/ANDROID.md](docs/ANDROID.md) — the Android app, EAS, Play, and the
   two signings.
4. [docs/SCHEMA.md](docs/SCHEMA.md) — every field, every rule.
5. `packages/schema/src/types.ts` — the contract itself.
