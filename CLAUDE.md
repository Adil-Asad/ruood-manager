# CLAUDE.md

Guidance for Claude Code working in this repository.

## Read this first

**Phases 0 to 8 are complete. Phase 8 — the GitHub-native rebuild — replaced the
Manager server entirely and is the largest architectural change since Phase 0.
The plan ends here: anything further is new scope and needs deciding with the
operator rather than assuming.**

## Phase 8, and why it exists

Phases 6 and 7 built the Manager app as a client of a server running on the
operator's PC. That worked, and it had one property the operator would not
accept: **the product depended on one machine being awake**, and a lost phone
needed re-pairing against it.

The re-evaluation asked whether GitHub's own authentication could provide
recovery and publishing while preserving announcement signature verification.
It can, and the finding that made it possible is this:

> `Contents` and `Workflows` are **separate** fine-grained permissions. A token
> that can write `content/` cannot edit `.github/workflows/`.

So the phone can change what is published and cannot change what publishing
*does* — which is what lets the signing key be a secret of a workflow rather
than a file on somebody's laptop.

```
  phone ──device-flow sign-in──▶ GitHub
        ──commits content/────▶ announcements repo
                                     │ publish.yml (pinned toolchain)
                                     ▼ sharp → build → verifyPublishable → SIGN
                                   dist/ ──▶ Pages ──▶ RUOOD Lab
```

### What this bought

| | |
| --- | --- |
| Recovery | reinstall the app, sign in again. There is nothing to restore. |
| No single-device dependency | nothing waits on a particular machine. |
| Revocation | GitHub's, with an audit trail this project would have had to build. |
| Less code | the server, accounts, sessions, throttling, pairing and the Scheduled Task are **gone**. |

### What it cost, stated plainly

**The signature now proves "this came through the pipeline", not "a human with
an offline key approved it".** Anyone who can push to `main` can cause a signed
publish.

That is unavoidable in any design where a phone publishes without a particular
machine being awake: the ability to sign has to be reachable by automation the
phone can trigger. No key hierarchy fixes it — a device key would still need
something to vouch for it, which is the complexity the operator ruled out.

It still defeats a hostile network, a compromised CDN and a tampered Pages host.
It no longer defeats repository compromise.

**The upgrade path is a SETTING, not a rewrite.** `publish.yml` already names an
`announcements` environment. Moving `ANNOUNCEMENT_SIGNING_KEY` to an environment
secret and adding a required reviewer gates every publish on approval, with no
code change. That was deliberate.

### The two repositories, and the boundary between them

| | |
| --- | --- |
| **Manager repository** (this one) | builds the Android app and the CLI. Contains no announcements. |
| **announcements repository** | source of truth for content and publication. Contains no app. |

`publish.yml` lives in the announcements repository and checks this one out as a
build tool **at a pinned ref**. A dependency in one direction only. Neither is a
submodule of the other, and `packages/github` addresses the announcements
repository by `{owner, repo, branch}` at runtime — there is no hard-coded
default in the app and nothing that would break if it were replaced.

**Never vendor one into the other.** A submodule would couple their histories;
a checked-in copy would make "the source of truth" ambiguous.

**`managerRef` must never be a branch.** On `main`, a change here would silently
change what every publish signs. Upgrading the toolchain is a commit in the
announcements repository, visible beside the manifests it produced.

### What was removed, and what replaced it

| Removed | Replaced by |
| --- | --- |
| `packages/ui` (Fastify server + browser client) | the CLI, and the app talking to GitHub |
| `accounts.ts`, `sessions.ts`, `throttle.ts`, `identity.ts` | GitHub as the identity provider |
| pairing (`pairing.ts`, the pairing blob, `--new-token`) | OAuth **device flow** |
| `--lan`, `--tailnet`, `MANAGER_URL`, cleartext HTTP | `api.github.com` over TLS |
| `scripts/install-manager-service.ps1` | nothing — there is no server to start |
| `packages/client/api.ts`, `wire.ts` | `packages/github` |

**`packages/ui` going means the browser Manager is gone.** The fields the phone
deliberately does not expose — `rev`, `priority`, `category`, the staging
channel — are now CLI-only. (`targeting` was on that list and is not any more:
platform and version are what an operator most often means by "who is this
for", and both are asked for on the phone now, written into the `targeting` the
schema already had.) That is a real loss of a UI and no loss of
capability; every one of those operations is a CLI command, and the CLI is what
CI runs.

### Two packages arrived

| Package | Why |
| --- | --- |
| `@ruood/announcement-authoring` | `createRecord`, `applyEdits`, `applyTransition` and the repository-relative paths, extracted from `core` so the **phone and the publishing build run identical code**. They were already pure; what trapped them was living beside `fs`, `sharp` and `simple-git`. |
| `@ruood/announcement-github` | device flow, the Git Data API, and `content/` as announcements. Platform-neutral, transport injected. |

This project was designed and built in a previous session that ran from the
RUŌOD Lab folder (`d:\app`). That session produced an architecture review, then
Phase 0, then Phase 1. Everything decided there is written down here and in
`docs/` — you do not need that conversation, and you should not go looking for
it. If something seems undecided, it is genuinely undecided: ask.

## Project

**RUŌOD Manager** — the administration application for RUŌOD Lab, and the
tooling behind it.

**Announcements are the FIRST MODULE, not the whole product.** The app is a
general administrative client; announcements are what it currently
administers. Future modules (subscriptions, and whatever follows) are
additions beside this one. The naming follows that split: the product is
RUŌOD Manager, and the packages that are specifically about announcements
are named for announcements.

```
        ME
         │
         ▼
     RUŌOD Manager      ──▶  announcements repository  ──▶  GitHub Pages
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
| **5** | In-app announcement inbox (Settings → Announcements) | **Complete** |
| **6** | The Manager as an Expo/React Native Android application | **Complete** |
| **7** | The product redesign: login, three tabs, animated GIF, images in the app | **Complete** |
| **8** | GitHub-native: device flow, commits over the API, signing in CI | **Complete** |

**RUŌOD Lab now contains `modules/announcements/`.** Everything else Phases 4
and 5 touched there is small and additive — a mount and the Settings tab icon in
`app/(tabs)/_layout.tsx`, one section in `modules/settings/screens/settings-screen.tsx`,
two dependencies, and a Jest transform rule. Nothing else under `d:\app` has been
changed, and further work should keep it that way.

## Commands

```bash
npm install                  # once, at the workspace root
npm run build                # schema → authoring → core → client → github → cli
npm test                     # every package
npm run typecheck            # builds first, then typechecks all packages

# the CLI, from the workspace root. It does EVERYTHING, and it is what the
# publishing workflow runs.
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js <command> --repo <path to announcements repo>

# signing and channels, locally. The workflow does this in CI from a secret;
# these still work for an operator with a checkout and the key.
node packages/cli/dist/bin.js keygen  --repo <path>          # once, per repository
node packages/cli/dist/bin.js publish --repo <path> --sign
node packages/cli/dist/bin.js publish --repo <path> --channel staging --sign
node packages/cli/dist/bin.js verify  --repo <path>          # what CI checks

# In CI the key comes from the ENVIRONMENT and never touches a disk:
#   ANNOUNCEMENT_SIGNING_KEY=<PEM> announce publish --repo . --sign --accept-warnings
# An explicit --key still wins, because that is somebody naming a file.

# the Android Manager
npm run bundle    -w @ruood/announcement-manager-android  # the shipping JS bundle
npm run prebuild  -w @ruood/announcement-manager-android  # a real AndroidManifest
npm run typecheck -w @ruood/announcement-manager-android
npm run lint      -w @ruood/announcement-manager-android

# EVERY expo and eas command runs from packages/mobile. That is the Expo
# project; the workspace root is not one, and running eas there is what broke
# the preview build. See "There is exactly ONE Expo project" below.
#
# GITHUB_CLIENT_ID, ANNOUNCEMENTS_OWNER and ANNOUNCEMENTS_REPO come from
# eas.json's `env`, NOT from this shell -- a cloud build never sees it. See
# "A cloud build is given nothing by your shell" below.
cd packages/mobile
npx eas build --profile preview --platform android

# A LOCAL release build does read the shell, and needs all four exported:
export APP_VARIANT=preview GITHUB_CLIENT_ID=Iv23li... \
       ANNOUNCEMENTS_OWNER=Adil-Asad ANNOUNCEMENTS_REPO=ruood-announcements
npm run prebuild -w @ruood/announcement-manager-android
npm run bundle   -w @ruood/announcement-manager-android
```

**The EAS upload is governed by `.easignore`, not `.gitignore`.** Once that file
exists EAS stops reading `.gitignore` entirely, so every exclusion has to be
restated in it -- a `.easignore` listing only "extra" things makes the archive
BIGGER. Without one the archive was ~458 MB, carrying `node_modules/` (1.4 GB),
`packages/mobile/node_modules/` (1.2 GB) and `packages/mobile/android/` (1.5 GB
of Gradle output). With it, 1.5 MB: the source and manifests the build reads.

What must stay in it, because EAS runs `npm ci` at the workspace root and then
bundles `packages/mobile`: every package MANIFEST (npm resolves the whole
workspace graph or the install fails, `core` and `cli` included), the lockfile,
and the SOURCE of the four packages the app imports. `easignore.test.ts` pins
both halves of that.

A full check before calling work done:

```bash
npm run build && npm test && npm run typecheck
```

Currently **879 tests across 37 suites** — 317 schema, 207 mobile, 161 core,
68 github, 59 authoring, 43 cli, 24 client.

Two of the mobile suites are about the BUILD rather than the app, and both pin
something that otherwise fails only in the cloud: `metro-resolution.test.ts` (7)
that the shared packages resolve to source and never to `dist`, and
`easignore.test.ts` (32) that the upload keeps every manifest and every source
the bundler reads while leaving out `node_modules/` and the generated Android
project.

Phase 8 added `packages/github` (66 — the device flow against a scripted GitHub,
and the Git Data API asserted on SHAPE: one commit, `base_tree` present, a
non-forcing ref update), `packages/authoring` (59 — 46 moved from `core`, plus a
platform-neutrality sweep), `core/src/__tests__/publish-workflow.test.ts`
(16 — the generated workflow parsed as YAML, and pinned on the two properties
that make a plain signing secret safe: `contents: write` and no `workflows`),
`core/src/__tests__/repository-separation.test.ts` (5 — the two repositories
stay two, asserted structurally because nothing else fails when it stops being
true), and `mobile/src/__tests__/crop.test.ts` (31 — the crop arithmetic, swept
over every image × format × zoom × extreme offset, plus the source sweep that
keeps the editor and the manipulator measuring in the same pixels).

Phase 7 added: `core/src/__tests__/animation.test.ts` (18 — an animated GIF
survives the pipeline, asserted on the frame count of the OUTPUT bytes) and
`mobile/src/__tests__/product.test.ts` (41 — the words an administrator reads,
and the id they never have to invent). It also added an auth suite to
`packages/ui`, which went with that package in Phase 8.

The mobile suite includes two that read **built artefacts** rather than source:
`bundle.test.ts` sweeps the JavaScript bundle Gradle embeds in the APK/AAB for
secrets, and `manifest.test.ts` reads the prebuilt `AndroidManifest.xml`. Both
**skip loudly** when the artefact is absent, because `android/` is gitignored and
regenerated, and a test that fails on a fresh clone is a test people learn to
ignore. Produce them first when it matters:

```bash
npm run bundle   -w @ruood/announcement-manager-android
npm run prebuild -w @ruood/announcement-manager-android
```
Each package's suite is counted in its own run; `npm test` runs all seven.

**`manifest.test.ts` FAILS rather than skips in one specific window**, and it is
worth knowing before it wastes an hour: it reads the *merged* AndroidManifest
out of `android/app/build/intermediates/`, which only a Gradle build produces.
Immediately after `expo prebuild --clean` the prebuild SOURCE manifest exists
and the merged one does not, so the "is this merged, not the source" assertion
fails instead of skipping. Run a build, or run `npm run prebuild` and then
`npm run bundle`, before reading anything into it. It is not a regression in the
app.

RUŌOD Lab has **250 announcement tests across 16 suites** of its own, run there
with `npx jest modules/announcements`. Its full suite is 1668 across 72.
`image-only.test.ts` (10) is the newest: an announcement that is a picture and
nothing else, read by the app's own copy of the validator, chosen for the modal,
and kept through all four frames.

Phase 7 added `images.test.ts` (19) and `image-cache.test.ts` (17), which are
the module's first image tests — because Phase 4 shipped with `imageUri={null}`
hard-coded and there were no images to test.

**Build order is load-bearing.** `core`, `cli` and the `ui` server resolve
`@ruood/announcement-schema` through its built `dist/*.d.ts`, not its source, so
schema must be built first. `npm run build` does this explicitly rather than
relying on npm's workspace ordering.

## Layout

```
packages/
  schema/    @ruood/announcement-schema — the contract. ZERO dependencies,
             platform-neutral, node-testable. Ships into RUOOD Lab's RN bundle.
  authoring/ @ruood/announcement-authoring — the PURE record operations:
             createRecord, applyEdits, applyTransition, and the
             repository-relative paths. Extracted from `core` in Phase 8 so the
             phone and the publishing build run identical code. Zero platform
             dependencies; swept by `__tests__/isolation.test.ts`.
  core/      @ruood/announcement-core — build, images, git, SIGNING. Reaches for
             fs, sharp and simple-git, so it never goes near an RN bundle.
             Re-exports `authoring`, so every existing import path resolves.
  client/    @ruood/announcement-client — the platform-neutral plumbing: the
             injected `Http` port, the credential-store port, base64 (both
             alphabets), and the pure presentation helpers.
  github/    @ruood/announcement-github — how the app reaches the announcements
             repository: OAuth device flow, the Git Data API, and `content/` as
             announcements. Platform-neutral, transport injected. Addresses the
             repository by {owner, repo, branch} at RUNTIME — it contains no
             announcement content and no hard-coded repository.
  cli/       @ruood/announcement-cli — every operation, headless. `announce`.
             What the publishing workflow runs.
  mobile/    @ruood/announcement-manager-android — the Expo/React Native
             Android Manager. A client of GITHUB now, not of a Manager server.
workspace/   gitignored. Cloned/scratch announcement repos.
docs/
  ARCHITECTURE.md   the decisions and why. Read before changing any of them.
  OPERATING.md      day-one setup: the GitHub App, the signing secret, the
                    workflow, access, and the build.
  ANDROID.md        the Android app, EAS, Play, and the two separate signings.
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

### An original with no reference is an image the BUILD attaches

`content/media/<id>.<ext>` is the original; `record.image` is the published
WebP's path, size, byte count and sha256. Only an encode can produce the second,
so only something with `sharp` can write it — and the Android Manager has no
sharp, no checkout and no filesystem. All it can do is commit the original
beside a record with no `image`.

Nothing joined the two, and the result was silent: `resolveImages` skipped every
record without an `image`, an announcement with no picture is perfectly valid,
and so six announcements authored on the phone published without the pictures
that had been chosen for them. The only one that ever shipped an image had been
attached from a laptop with `announce image`.

So the build attaches it — `attachPendingOriginal` in `build/build.ts`, which is
the same division of labour the publishing workflow is built on: the phone
writes content, the pipeline does what needs a real machine. Three rules it
keeps:

- **`content/` is not written.** The `image` object is stamped onto the
  PROJECTED record, which is derived. A build that edited the authored record
  would be an author, and the next diff would show a change nobody made.
- **The alt text is the announcement's title.** `alt` may not be empty, the
  phone does not ask for one, and the title is the only honest answer available.
  It is already validated as single-line plain text within 60 characters.
- **An original that will not encode FAILS the publish.** Somebody attached a
  picture; publishing quietly without it is the bug this replaced.

The other half is removal: `saveRecord` takes `removeImage`, because clearing
`record.image` no longer removes anything on its own — an original left in
`content/media/` is a picture that comes straight back on the next publish.

### An announcement may be a picture and nothing else

`title` and `body` are both OPTIONAL, and absent, `null` and `""` all mean the
same thing — there is no text. An image-only announcement is a real thing an
administrator means: the picture IS the message, and demanding a caption to go
with it produces a caption nobody needed.

What is still refused is a record carrying NOTHING. No picture, no title and no
message renders as an empty dialog with a Dismiss button — a remote
interruption with no information in it. That is `content-empty`, and it is one
error in `validateText`, not a second validator.

**The authoring-time complication is that the phone's picture is not in the
record yet.** A record committed from the Android Manager has an original at
`content/media/<id>.<ext>` and no `image` object, because only an encode can
produce one (see the section above). So the validator takes a `pendingImage`
option — an authoring-time fact the record cannot express, exactly like
`idRegistry` beside it, stored nowhere and ignored in `published` mode. Every
caller that validates an authored record passes it: `buildManifest` from one
listing of `content/media/`, the CLI's `edit`, `transition` and `list` through
`mediaIds`, and the phone from `form.picked`. **A caller that forgets it refuses
exactly the announcements this rule exists to allow.**

Two consequences are worth knowing:

- **`attachPendingOriginal`'s alt text can no longer be the title.** `alt` may
  not be empty, so it is the title, else the message collapsed to one line, else
  `Announcement image`. A publish that failed over a missing caption would be
  refusing an announcement that is otherwise perfectly valid.
- **An older RUOOD Lab build skips an image-only record**, because its copy of
  the validator still requires both fields. That fails closed and the app is
  unaffected — the same shape as the animated-image budget — but image-only
  announcements only reach installs on the release carrying this schema.

Nothing writes a placeholder into a record. `announcementLabel` in
`packages/mobile/src/language.ts` and `titleCell` in the CLI's `list` are
display-only: a list row needs one line to read, and a blank there looks like
content that failed to load. RUOOD Lab draws no `Text` at all for an empty
field, because an empty one still takes a line height and its margin — which
arrives on screen as a gap nobody put there.

### The frame is the published dimensions, and nothing else

Square, Portrait, Tall and Full screen are cropped on the phone (`crop.ts`), so
the shape is baked into the pixels and the encoder preserves the ratio. There is
**no frame field in the schema and must not be** — a stored name and the bytes
it describes are two facts that can disagree. `frameForSize` reads it back here;
RUŌOD Lab reads it back in `image-frame.ts`. Both previewed and drew a fixed
16:9 for a year, which is why every Portrait and Tall picture arrived as a band
cut from its middle, in both places at once.

`bodyLimitFor` follows from it: the taller the frame, the less screen is left
for words. Those are authoring limits — `BODY_MAX_LENGTH` is still 500 and every
published record is still valid at 500.

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

### A UI is a front end, never a second implementation

Every operation the Manager performs is a `core` function the CLI already
calls. The server maps HTTP onto `core` and back; it decides nothing. If the UI
needs behaviour `core` does not have, it goes into `core` and gets a CLI command
too — `applyEdits` / `announce edit` and `attachImage` are both that rule being
followed, not exceptions to it.

The consequence worth protecting: you can always publish when a UI is broken,
and no two front ends can disagree about what "archive" means.

There are **two** front ends now — the CLI and the Android Manager — and Phase 8
is what made the rule survive them being on different sides of a network.

The CLI runs `core` against a working copy. The app cannot: it has no checkout,
no `sharp` and no git. So the shared part was pulled DOWN rather than duplicated
across: `@ruood/announcement-authoring` holds `createRecord`, `applyEdits` and
`applyTransition`, and both import it. The phone is not producing an
approximation of a record for something else to correct — it is producing the
record, with the same function the publishing build reads it back with.

Where they genuinely differ is only transport: `core/src/content/store.ts`
writes a working copy, `github/src/content.ts` writes over the API. Two
transports for one set of rules. **If a rule appears in one and not the other,
they have started to disagree**, and the symptom is a record that saves on the
phone and is refused by the build with nothing to point at.

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

### The app is a PRODUCT, and the system's vocabulary never reaches it

**Added in Phase 7.** RUŌOD Manager is used by a non-technical administrator.
`git`, `manifest`, `revision`, `commit`, `staging`, `sha256`, `signing key`,
`repository`, `pairing`, `port 4874` and every errno are implementation detail,
and none of them may appear on a screen.

The enforcement is one module, `packages/mobile/src/language.ts`, and that is
deliberate: if the translation lives at each call site, every new screen is a
new chance for `403` to reach a phone, and it only has to happen once for the
app to stop being the product it claims to be.

- `humanise` is the single gate every failure passes through. `safe()` inside it
  is the only place an unrecognised string is allowed out.
- `statusOf` and `explainStatus` are TOTAL over `LifecycleStatus`, so a state
  added to the contract is a compile error rather than a record with no word.
  They are a translation at the edge, not a second state model — the schema
  stays authoritative.
- `product.test.ts` feeds §25's own list of forbidden strings through
  `humanise` and asserts none survives. **It caught three real leaks**, including
  `signature verification failed` and a stack-frame pattern that matched the
  frames that never happen and missed the common one.

**A GitHubError never passes its message through, and that was a real leak.**
`humanise` maps 401, 403/404, 429 and 5xx to sentences; everything else used to
fall to `safe(failure.message)`. 422 is what the Git Data API answers when a
blob, a tree or a commit is refused, and its wording carries no errno, no stack
frame, no bare status and no JSON — so `safe()` did not recognise it and printed
it. `Reference cannot be updated` and `Invalid request. For
'properties/content', nil is not a string.` both reached the screen.

There is no such thing as a GitHubError written for an administrator: the
message is either GitHub's API wording or one of this app's own invariant
messages. So it is not passed through at all — a word list can always be one
word short. The validator's sentence still reaches the operator, because that
arrives as an `ApiFailure`, and that distinction is what the test asserts.

It was missed because `product.test.ts` swept `ApiFailure` — the Manager
SERVER's error type, from an architecture Phase 8 deleted — and never exercised
the GitHub errors that replaced it.

The technical detail is relocated, not destroyed: the server still logs exactly
what happened, and Settings → Advanced still shows the raw values — in a
development or preview build only.

### The form asks five things, and the schema still has eighteen

`id`, `rev`, `status`, `priority`, `category`, `targeting`, `trigger`,
`maxImpressions`, `minIntervalHours` and `dismiss` are all absent from the phone
form. None is removed from the contract; all are still validated and still
editable from the desktop Manager. `packages/mobile/src/components/announcement-form.tsx`
lists why each one is out.

`id` is the one that mattered most: it is permanent, never reused, and keys
impression state on every device for 60 days after the announcement is gone.
The consequences do not go away by hiding the field, so `src/ids.ts` derives it
from the title — readable in a `git log` a year later, which random would not
be — and takes the SERVER's suggestion on a collision, because the server holds
both the existing records and `retired-ids.json` and a local guess would be
checking against half the question.

### The app signs in with the DEVICE FLOW, and holds one credential

**Phase 8.** The administrator taps a button, reads eight characters, types them
at `github.com/login/device`, and approves. There is no address, no port, no
token to paste and no QR code.

The device flow is the only one of GitHub's that needs **no client secret** —
which matters absolutely, because anything compiled into an APK is readable by
anyone who unzips it. There is no secret to leak because there is none.

Three things follow, and they are the whole reason this replaced pairing:

- **Recovery is reinstalling.** No state on the old device is worth recovering.
- **Revocation is GitHub's**, per device, with an audit trail.
- **`pollForToken` performs exactly ONE poll.** The waiting belongs to the
  screen, which has to stay responsive, honour a `slow_down` *permanently*, and
  stop when somebody navigates away. A loop inside the library would own all of
  that and expose none of it — and going back to the old interval after a
  `slow_down` is how a client is throttled out of the flow entirely.

The cost, from GitHub's own guidance: the device flow has no redirect URI, so an
attacker can start one and phish somebody into approving it. The defence is
entirely in the words on screen, which is why the sign-in screen names what is
asking rather than only printing a code.

### `Contents` and `Workflows` are separate, and that is the security design

**The single most important fact in Phase 8.** The app's token can write
`content/` and cannot touch `.github/workflows/`.

So a stolen phone can change what is published, and cannot change what
publishing *does* — it cannot make the workflow print the signing key. That is
what allows `ANNOUNCEMENT_SIGNING_KEY` to be an ordinary repository secret
instead of a file on somebody's laptop.

`publish-workflow.test.ts` asserts `permissions: { contents: write }` and the
absence of `workflows`. If that assertion is ever relaxed, the key stops being
safe where it is, and the whole arrangement has to be reconsidered.

### One commit per operation, over HTTP

Publishing has been one git commit since Phase 1. Over the API it is the same
rule, which is why `packages/github` uses the **Git Data API** and not the
Contents API — the latter writes one file per commit.

  blobs → tree (with `base_tree`) → commit → ONE non-forcing ref update

Three things there are load-bearing and each was a real hazard:

- **`base_tree` must be present.** Without it the commit contains only the
  listed files and deletes the entire rest of the repository — successfully.
- **`force: false`.** Two administrators with two phones is now possible, where
  one Manager against one checkout made it impossible. A forcing update would
  silently lose somebody's work; instead `ConcurrentUpdate` is thrown, the
  screen re-reads, and it says so.
- **A record and its image go in the SAME commit**, and so do a deletion and its
  retired-id ledger entry. A repository observed between those two commits is
  one the build refuses, or one where an id is briefly free for reuse.

### The app re-reads after every write, and the blob cache is not an exception

The repository is the system of record, so there is no client-side store. `run`
re-reads after anything that writes — not as a nicety, but because a write is
built on a specific commit and the next one must build on what the last
produced, or every second write in a row is refused as a concurrent update.

`BlobCache` keys on **git blob shas**, which are content hashes. A cached entry
cannot be stale: if the content changed, the sha changed, and the cache misses.
It makes a refresh cost one tree listing instead of fifty blob reads and cannot
make the app show something out of date.

`listFiles` **refuses a truncated tree** rather than returning a short one. A
silently short listing reads as "those announcements were deleted", and the app
would then offer to publish a manifest missing them.

### The Android Manager is a CLIENT, and that is the whole security design

`packages/mobile` is an Expo/React Native application. It is not a port of the
Manager and it must never become one, because four of the Manager's operations
cannot happen on a phone: `content/` is a git checkout, git needs credentials,
`sharp` is native libvips, and — the one that settles it — **the Ed25519 private
key must never leave the operator's machine**.

So the app asks the Manager server to act. It can request a signature; it cannot
produce one. A stolen phone yields a bearer token that drives one Manager, not a
key that authenticates a manifest to a million installs.

**The private announcement signing key must never be bundled in the Android
application** — not in the APK, not in the AAB, not in `app.config.ts`, not in
`extra`, not in an asset, not in SecureStore, not behind an endpoint the app can
call. `packages/mobile/src/__tests__/config.test.ts` and `bundle.test.ts` assert
it against the config *and* the built Hermes bytecode, because a review cannot
see a secret that arrived through a dependency.

Keep these two apart, always:

| | Android app signing | RUOOD announcement signing |
| --- | --- | --- |
| authenticates | the APK to Android | a manifest to RUOOD Lab |
| key | Play / EAS upload key | Ed25519, key id `2bc1e956` |
| lives | Google's servers | `~/.ruood/announcement-signing.key`, mode 0600 |
| rotating it | a Play Console operation | **an app release of RUOOD Lab** |

`docs/ANDROID.md` is the full record.

### Metro resolves the shared packages to SOURCE, like Vite does

`packages/mobile/metro.config.js` maps `@ruood/announcement-schema`, `-client`,
`-authoring` and `-github` to their `src/index.ts`, for the same cause: their
`dist` is CommonJS, and an `export * from` through it is a re-export a bundler
cannot analyse statically. `vite.config.ts` recorded the same reasoning.

The consequence is the one worth protecting: the phone runs the SAME validator
the Manager publishes with, and the bundle needs nothing to have been compiled
first -- which matters most on EAS, where nothing runs this repository's build
script.

**The mapping is `resolver.resolveRequest`, and it was `extraNodeModules`, which
is NOT an alias.** In `metro-resolver/src/resolve.js` the extra paths are
`.concat(extraPaths)` onto the END of the candidate list: a fallback for a
package that could not be found at all. npm workspaces symlink every one of
these into the root `node_modules`, so each was always found, and the alias
underneath was never once consulted.

On a development machine that is invisible -- `dist/` is there, resolution
succeeds one step earlier than intended, and the bundle is correct anyway. On
EAS it is fatal, and this is exactly how a preview build failed:

```
Unable to resolve module @ruood/announcement-authoring
  from packages/mobile/app/announcements/new.tsx
The package was found at node_modules/@ruood/announcement-authoring/package.json
But its main module could not be resolved: .../dist/index.js
```

`dist/` is gitignored, so it is not in the upload, and nothing in a managed
build compiles this workspace. Metro finds the package, cannot resolve the
`main` it declares, and throws `InvalidPackageError` -- it does NOT fall through
to the remaining candidates, so the fallback could not have rescued it even if
it had been reached.

`resolveRequest` runs BEFORE node_modules resolution, so the mapping is now the
answer rather than a guess made after the real answer failed. Nothing about the
packages changed: `main` still points at `dist` for node, the CLI and every jest
suite.

**`bundle.test.ts` cannot catch this and never could** -- `dist` carries the
same string literals as `src`, so a bundle built from either passes that sweep.
`metro-resolution.test.ts` asserts the thing that actually differs: which FILE
the config resolves to, and that no `dist` is on that path.

Reproduce it in one command, and it is worth doing before trusting any change
here:

```bash
mv packages/authoring/dist packages/authoring/dist.bak   # what EAS sees
cd packages/mobile && npx expo export:embed --eager --platform android --dev false
```

Two other things there are load-bearing and were bugs once:

- `disableHierarchicalLookup` must stay OFF. Every monorepo recipe sets it, and
  they assume pnpm-style layouts where everything is reachable from a listed
  root. npm nests what it cannot hoist — `expo-router` carries its own
  `@expo/metro-runtime` — and turning lookup off makes those unreachable.
- `watchFolders` is APPENDED, never assigned. Expo puts its own entries there,
  and replacing the array drops them.

`babel.config.js` resolves the preset with `require.resolve` for the same class
of reason: `@babel/core` hoists to the root, `babel-preset-expo` nests here, and
Babel resolves a preset *name* relative to `@babel/core`.

### There is exactly ONE React, and `overrides` is what enforces it

The root `package.json` pins `react` and `react-dom` to `19.1.0` across the
workspace. Removing that pin brings back a crash that **only appears on a real
device, only in a release build**:

```
TypeError: Cannot read property 'useRef' of null
  at useNavigationContainerRef / ContextNavigator / ExpoRoot
```

The workspace holds React 19 for the Android app, and React 18 arrives as a
transitive peer. npm hoists `@react-navigation/core` to the repository ROOT,
where it resolves React from the root `node_modules` — so the navigation stack
binds to React 18 while everything else binds to 19, and its hooks dispatcher is
null.

It typechecks, it lints, it bundles, and `expo-doctor` reports it only as a
"duplicate dependency" warning that reads as cosmetic. `bundle.test.ts` asserts
no React 18 string survives into the shipped bundle, because that is the only
check that would have caught it.

Do not "fix" a future duplicate by reordering `nodeModulesPaths`. That governs
the app's own imports and does nothing for a package hoisted above it.

### The expo-router Babel plugin has to be added BY HAND

`babel-preset-expo` adds it only when `hasModule('expo-router')` succeeds, and
that is a bare `require.resolve('expo-router')` evaluated from inside the
PRESET's own directory. npm put the preset at the repository root and left
`expo-router` nested under `packages/mobile`, so the resolve failed and the
preset **silently dropped the plugin**.

The symptom is a release build that dies in the bundler naming a file in
`expo-router` and nothing about this project:

```
SyntaxError: node_modules/expo-router/_ctx.android.js:
Invalid call at line 2: process.env.EXPO_ROUTER_APP_ROOT
```

`_ctx.android.js` is a `require.context` over that variable, and the plugin is
what replaces it with a real path. Without the plugin Metro reaches an argument
it cannot evaluate statically and the whole bundle fails.

`babel.config.js` now requires the plugin directly and lists it. That is safe:
it takes the app root from `api.caller(...)` rather than from resolution, and it
is idempotent, so a future npm layout that lets the preset add it as well costs
nothing.

**Hoisting `expo-router` to the root instead is not an option** — npm refuses it
outright over the `react-native`/`expo` peer graph, and forcing it would put a
second copy of the router in the tree, which is the exact shape of the React
18/19 crash the `overrides` block already exists to prevent.

This is the third time hoisting has broken this app the same way, and the second
time in `babel.config.js`. The rule that keeps emerging: **never let a bare
module name decide whether a build step happens.**

### There is exactly ONE Expo project, and it is `packages/mobile`

The workspace root is not an Expo project and must never be made to look like
one. Every `expo` and `eas` command runs from `packages/mobile`, which is where
`app.config.ts`, `eas.json`, `metro.config.js`, `babel.config.js`, `index.js`
and `app/` all live.

**What happens when that slips**, and it is a bad failure because the message
names neither the cause nor this project:

```
Unable to resolve module ../../App from
  /home/expo/workingdir/build/node_modules/expo/AppEntry.js
```

`resolveEntryPoint` in `@expo/config` reads the `main` field of the package.json
**at the project root**. `packages/mobile/package.json` has `main: "index.js"`;
the workspace root's has no `main` at all and no root `index.*`, so it falls
through to its last resort — `expo/AppEntry.js`, the classic pre-router entry,
whose first line is `import App from '../../App'`. There is no `App` there and
there must not be one: this is an expo-router app, and `index.js` importing
`expo-router/entry` is its entry (see the header of that file).

It slipped because `eas init` cannot write a project id into a `.ts` config, so
run from the repository root it wrote an `app.json` and an `eas.json` THERE —
and with an `eas.json` beside it, `eas build` at the root treats the root as the
project. The build then uploads, installs, and dies in the bundler.

Two things prevent the recurrence:

- **`extra.eas.projectId` is written in `app.config.ts`** rather than left for
  `eas init` to place wherever it was run. `EAS_PROJECT_ID` still overrides it.
  A project id is not a credential — it names a project, and the account that
  owns it is what authorises anything — and `config.test.ts`'s opaque-literal
  sweep excuses that ONE value by name, so every other long literal still fails.
- **`/.expo/`, `/app.json` and `/eas.json` are gitignored at the root**, so a
  stray one cannot be committed or uploaded to a builder again.

Reproducing it takes one command, and it is worth knowing both halves:

```bash
npx expo export:embed --eager --platform android --dev false   # from the root: FAILS on ../../App
cd packages/mobile && npx expo export:embed --eager --platform android --dev false   # bundles
```

### `unstable_serverRoot` is what makes a RELEASE build possible

`metro.config.js` sets `config.server.unstable_serverRoot = projectRoot`, and
without it **every release and production build fails** while debug builds are
perfectly fine — which is the worst possible shape for a bug.

Expo's embed exporter (`expo export:embed`, which Gradle and EAS run to produce
the bundle inside the APK/AAB) computes the entry path relative to `projectRoot`
and then resolves it with `relativeTo: 'server'`. `@expo/metro-config` detects
the monorepo and points the server root at the repository root, so the two
disagree by `packages/mobile` and the build dies with:

```
Unable to resolve module ./index.js from D:\RUOOD-Announcement-Manager\.
```

A debug build never sees it, because it loads JavaScript from Metro rather than
bundling it. Hoisting does not fix it either — the mismatch is structural, and
only holds when `projectRoot === serverRoot`.

The cost is that plain `expo export` no longer works here: it computes the same
path against the *repository* root, so the two commands cannot both be satisfied.
`export:embed` wins because it is the one that produces every shipping artefact;
`npm run bundle` invokes it through Gradle, and `bundle.test.ts` sweeps its
output — which is strictly better than sweeping an approximation.

`packages/mobile/index.js` exists for the same reason: it makes the entry a real
file inside the package rather than a specifier resolved out of a nested
`node_modules`.

### A cloud build is given nothing by your shell

`app.config.ts` reads `GITHUB_CLIENT_ID`, `ANNOUNCEMENTS_OWNER` and
`ANNOUNCEMENTS_REPO` from the environment, and compiles them into `extra`. A
local build reads them from the shell they were exported in. **An EAS build
cannot**: the config is evaluated on the builder, in a process that never saw
that shell, and the only environment it has is what `eas.json` declares for the
profile.

So they are in `packages/mobile/eas.json`, on every profile, beside
`APP_VARIANT`. Passing them on the `eas build` command line looks right, is what
this file used to say, and does nothing at all.

The failure is quiet and total: the APK installs, opens, and says **"This app
has not been set up"**. It cannot be rescued from Advanced either -- a client id
can be overridden there, and `hasRepository()` is compiled in and deliberately
not overridable, so `setClientId` leaves the app `unconfigured` and the sign-in
button never appears. Nothing on the device says why.

None of the three is a secret, which is what allows a committed file to hold
them: a device-flow client id has NO client secret -- that is the entire reason
the flow is usable from an APK, where anything compiled in is readable by anyone
who unzips it -- and `owner/repo` is where a public repository lives. The
announcement signing key is not there, is not readable from a phone, and is a
secret of the publishing workflow.

`config.test.ts` asserts every profile carries all three, and that no key in any
profile's `env` ends in `KEY`, `SECRET`, `TOKEN` or `PASSWORD` -- `eas.json` is
now a place build configuration lives, so it is swept like `extra` is.

### `APP_VARIANT` must be EXPORTED, not set on the prebuild line alone

A local release build reads `app.config.ts` **twice**: once by
`expo prebuild`, which fixes the application id and the launcher name, and again
by `expo export:embed`, which Gradle runs to produce the JS bundle. They are
separate processes with separate environments.

`APP_VARIANT=preview npx expo prebuild` sets it for the first and not the
second, so the APK carries the `.preview` application id while the bundle inside
it reports `appVariant: "production"` — and the Repository tab shows the wrong
build badge, which is precisely what that badge exists to prevent.

`export APP_VARIANT=preview` before both. EAS is unaffected: `eas.json` sets
`env.APP_VARIANT` for the whole build.

### The app is Android-only, and the platform list says so explicitly

`platforms: ['android']` in `app.config.ts`. Expo's default is
`['ios', 'android', 'web']`, and leaving it there was a bug: pressing `w` in
`expo start` — or Expo reaching for web when no device is attached — tried to
bundle a platform with no dependencies installed, and failed with forty lines of
`Unable to resolve react-native-web/...` naming every file except the wrong one.

**The fix is not to install `react-native-web`.** The bearer token lives in the
Android keystore through `expo-secure-store`; on web that degrades to
`localStorage`, readable by any script on the page — and the credential in
question is now a GitHub token that can write the announcements repository.
`config.test.ts` pins the list.

### `permissions: []` does not stop a plugin, and only the manifest tells the truth

A config plugin merges INTO the AndroidManifest and is not filtered by the
`permissions` list. `expo-image-picker` added `RECORD_AUDIO` and
`WRITE_EXTERNAL_STORAGE`, and React Native added `SYSTEM_ALERT_WINDOW`, while
`app.config.ts` said `permissions: []` and `expo config` agreed with it.

`blockedPermissions` is what actually removes them, and the only way to see the
result is `expo prebuild` followed by reading
`android/app/src/main/AndroidManifest.xml`.
`packages/mobile/src/__tests__/manifest.test.ts` now does that automatically and
pins the exact set that survives: `INTERNET`, `READ_EXTERNAL_STORAGE` (image
picking below Android 13) and `VIBRATE`. Anything else appearing there arrived
with a dependency and needs a decision, not a passing test.

The same test now asserts `usesCleartextTraffic="false"`, having previously
asserted `"true"`. Cleartext existed for one reason — plain HTTP to a Manager
server on a private network — and Phase 8 deleted that server; everything the
app speaks to is `api.github.com` over TLS. It is asserted `false` rather than
simply unchecked because turning it back on would look like nothing at all.

### There is no publish step in the app, because writing `content/` IS publishing

**Phase 8.** The app used to save, transition, then call a publish endpoint that
built, signed, committed and pushed. All of that was the Manager server.

Now the commit the app makes triggers `publish.yml`, and the two buttons differ
by one field:

| Button | What it writes |
| --- | --- |
| Save Draft | `status: 'draft'` — the build excludes drafts entirely |
| Publish | `status: 'published'` — the build includes it |

That is the same rules with the orchestration moved, not a loosening of them:
`applyTransition` still owns which moves are legal, and the build still refuses
anything the validator refuses.

**The app says "will reach RUOOD users shortly", not "is live".** The workflow
takes a minute or two, and claiming otherwise would be the app lying about
something checkable.

### Production WAS a typed confirmation, and now it is a sentence

**Changed in Phase 7.** The mobile publish screen used to start on `staging` on
every mount, paint production in the alarm colour, and require the word
`PUBLISH` to be typed before a production publish committed.

That was the right protection for the app it was: a technical tool where
staging and production were both routine operations, and where the difference
between them had to be made physically hard to get wrong.

It is the wrong protection for this one. An administrator writing a notice is
not choosing between two channels — there is one thing they mean, and asking
them to type a word in capitals to do the only thing the screen is for is
friction that teaches people to type it without reading. A confirmation
everybody has learned to dismiss protects nothing.

What replaced it:

- a plain confirmation dialog naming **who will see the result**, which is the
  fact that actually matters (`Every RUOOD user will be able to see this.`);
- **Save Draft**, which is genuinely reversible, needs no confirmation at all;
- **staging did not disappear.** It moved to the desktop Manager and the CLI,
  where the person using it knows what a channel is. `packages/mobile` no longer
  sends `channel: 'staging'` anywhere.

The app build variant (`development` / `preview` / `production`) and the publish
channel (`staging` / `production`) are still **different axes** and still
different types with different names. That part is unchanged and must stay.

The app build variant (`development` / `preview` / `production`) and the publish
channel (`staging` / `production`) are **different axes** and are deliberately
different types with different names. A development build may publish to
production; a production build may publish to staging.

### The four formats, and the one rule the cropper serves

**Phase 8.** The editor offers exactly four shapes — Square 1:1 (1080×1080),
Portrait 4:5 (1080×1350), Tall 2:3 (1080×1620) and Full screen 9:16
(1080×1920) — with pan and pinch inside a fixed frame.

The rule everything in `src/crop.ts` exists to hold: **never stretch, never
letterbox.** One scale factor on both axes, and never below `fitCover`. Those
two together mean the output is always a true sub-rectangle of the source. There
is no `scaleX`/`scaleY` anywhere in that file and there must not be.

**The crop rectangle and the editor must measure in the SAME pixels**, and
getting that wrong was a real bug found on the device, not a hypothetical. The
size came from `Image.getSize`; the editor laid the picture out at that size and
everything on screen was self-consistent — frame, drag, preview, all correct.
The rectangle was then handed to `expo-image-manipulator`, which measures in the
file's TRUE pixels. At 4:5 on a 3000x2000 test card **the editor framed the
centre and the committed image was the top-left corner**, with no error and a
perfectly plausible picture.

`media.sourceSize` now asks the manipulator itself, by running it with no
actions. It is the same library, reading the same file, reporting the coordinate
system it is about to crop in, so the two cannot disagree — there is only one of
them. `crop.test.ts` sweeps the source and fails if `Image.getSize` comes back.

This is the same shape as the animated-GIF hazard one section down, and worth
naming as a class: **on this platform, the thing that silently returns a
plausible answer is the default.**

Three things are easy to get wrong and are each pinned by a test:

- **The crop rectangle must never leave the source.** `expo-image-manipulator`
  throws outright on one that does, and the administrator reads "that image
  could not be used" about an image that was fine. `crop.test.ts` sweeps every
  image × format × zoom × extreme-offset combination.
- **Dragging the image right moves the window LEFT.** The classic crop bug, and
  it looks correct until somebody compares the preview with the result.
- **A small crop is never upscaled.** `outputSizeFor` caps the encode at the
  rectangle's own size; enlarging to 1080 would spend the encoder's quality
  budget on invented pixels.

The gestures are `PanResponder` and `Animated`, with **no new dependency**.
`react-native-gesture-handler` and `react-native-reanimated` would both be
smoother and both mean a native rebuild plus two significant packages for one
frame and two gestures. The gesture writes the animated values directly, so
dragging costs no re-render — a `setState` per touch move is exactly what makes
a crop editor feel broken.

**An animation never reaches the cropper.** The form checks before opening it,
and `prepareForUpload` ignores a crop for an animated asset even if one is
passed. Two locks, because the failure is invisible: every path through the
manipulator returns frame one, so cropping a GIF would publish a still image
that looked exactly like a success.

The cropper is a full-screen `Modal`, so it sits OUTSIDE `Screen` and inherits
none of its safe-area insets. It takes them itself, and without that the heading
is drawn underneath the status bar clock.

**The pinch cannot be verified through `adb`, and the app carries a readout so a
human can verify it in one gesture.** `ImageCropper` takes a `debug` prop that
shows the live touch count and scale; `app/image-editor-preview.tsx` is the only
caller that passes it, so it exists in developer builds alone. The reason it is
there is written up under Known issues — injected multi-touch does not reach an
app on this device, and a pinch that does nothing looks identical whether the
touches never arrived or the arithmetic refused them.

### An animated GIF stays animated, and becomes a WebP

**Added in Phase 7**, and it is the one rule the image pipeline is now built
around: `sharp(source)` without `{ animated: true }` reads ONLY THE FIRST FRAME
and returns a perfectly valid, perfectly still image with no error at all. A
publish would succeed, look correct, and ship a motionless picture. That is the
worst possible shape for a bug, and it is the DEFAULT behaviour of every image
library involved — `expo-image-manipulator` on the phone does the same thing,
and Android's crop UI does it one step earlier.

So the animation is defended at four separate places:

| Where | What would have destroyed it |
| --- | --- |
| `packages/mobile/src/media.ts` | `allowsEditing` in the picker; the manipulator. A GIF skips client-side optimisation ENTIRELY and the original bytes go up, and a crop is ignored for one even if passed. |
| `packages/mobile/src/components/announcement-form.tsx` | opening the CROPPER for an animation. It checks the type first and sends a GIF straight through. |
| `packages/core/src/images/encode.ts` | `sharp()` without `animated: true`. It also re-reads its own OUTPUT and throws if the frames are gone. |
| `d:pp/.../announcement-modal.tsx` | React Native's `Image`, which draws frame one on Android. `expo-image` decodes animation, and was already a dependency. |
| tests | `core/src/__tests__/animation.test.ts` asserts the frame count of the OUTPUT bytes. A test that only checked a GIF was *accepted* would pass against a pipeline that had silently destroyed it. |

**GIF in, animated WebP out**, and that choice is why the contract barely moved:
WebP is animated as well as still, so there is still exactly ONE output format,
one content type, one decode path on the device, and `IMAGE_PATH_PATTERN` is
unchanged. Passing GIF bytes through would have meant two of each, plus files
several times larger, for a picture nobody can tell apart on a phone.

`packages/core/src/__tests__/gif-fixture.ts` builds a real GIF89a byte by byte,
because `sharp` reads animations perfectly and has no supported way to CREATE
one from raw pixels — a fixture built with sharp would be testing a sharp-based
decoder against whatever sharp could be persuaded to emit.

### The schema has two image budgets, and `animated` picks between them

`ANIMATED_IMAGE_MAX_BYTES` (600 KB) and `ANIMATED_IMAGE_MAX_DIMENSION` (640)
sit beside the still caps, and `AnnouncementImage.animated` is what the
validator reads to choose. An animation is the same picture many times over, so
holding it to a still's 150 KB would not produce a smaller animation — it would
refuse every real one.

`animated` is **derived, never authored**: `encodeAnnouncementImage` stamps what
it actually produced, so the flag cannot disagree with the file. Same discipline
as `width` and `sha256` beside it.

**The compatibility consequence, stated plainly.** A RUŌOD Lab build from before
this change applies the 150 KB still cap to every image, so an animated record
over that size is SKIPPED by an older client. That fails closed and the app is
unaffected — but animated announcements only reach installs on the release that
carries this schema. `ANIMATED_IMAGE_MAX_FRAMES` (150) caps decode cost, which
bytes alone do not.

### RUŌOD Lab downloads images, verifies them, and only then keeps them

**Added in Phase 7.** Phase 4 shipped the presenter with `imageUri={null}`
hard-coded and said so; announcements had never displayed an image at all.

`modules/announcements/images.ts` is the pure half and `image-cache.ts` the
impure one, split exactly as `state.ts` and `storage.ts` are. Three rules:

- **An image is never a reason to suppress an announcement.** Every failure —
  offline, timeout, 404, oversized, wrong hash — returns `null`, and the
  announcement is presented without its picture. No path in the module can
  return "do not show this", and there must never be one.
- **Verify, then keep.** The bytes are hashed in memory and compared with
  `image.sha256` from the SIGNED manifest before anything reaches disk. Writing
  first would leave a device trusting a file on the strength of its name.
  The signature covers the manifest, NOT the image — the image is a separate
  request — so without this check a network that could not touch the manifest
  could still substitute every picture in it.
- **Content-addressed, therefore immutable.** The cache filename carries the
  hash, so a file that exists is current. That is the whole of cache
  invalidation, and there is no freshness check to get wrong.

`imageUrlFor` resolves against the MANIFEST's own URL and refuses anything that
is not a relative `images/...` path — the same rule as `config.ts`: a manifest
must never be able to say where the next request goes.

### The preview is approximate, and says so on screen

**Removed with `packages/ui` in Phase 8.** The browser Manager held a preview
that copied RUŌOD Lab's tokens, and it went with the server it was served by.
The rule it embodied is worth keeping if a preview is ever rebuilt: copy the
tokens, name the source in a comment, and do NOT make it a shared component — that would be a dependency between two repositories with different
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

### The pinned manifest URLs carry the `dist/` prefix

GitHub Pages serves the repository root, and the Manager commits its built
manifests to `dist/announcements.json` and `dist/staging/announcements.json`
(`commitPaths` in `packages/core/src/paths.ts`). The app's pinned URLs must
therefore include `dist/`.

Both were once pinned without it and every fetch 404'd. Nothing failed loudly,
because an unreachable manifest is handled exactly like an empty one — correct
behaviour, and perfect camouflage for a total outage. `config.ts` is the one
file in the app where a typo is both invisible and complete: the fetcher takes
an injected URL and the verifier takes injected keys, precisely so they can be
tested off the network, which leaves what actually ships untested.
`modules/announcements/__tests__/config.test.ts` now pins the URL shape, the
trusted key, and `REQUIRE_SIGNATURE`.

### Sub-targets land on their parent tab

Nine of the fourteen `ROUTE_TARGETS` name things that are not routes. Reports,
Data Management, Backup, Units and the rest are `useState` flags inside
`ToolsScreen` and `SettingsScreen` that open an in-tree modal, so there is
nothing to navigate to.

`modules/announcements/navigation.ts` maps each of them to the tab that owns it.
Opening them properly would mean teaching both screens to accept an external
"open this" signal — a change to two large screens that have nothing to do with
announcements, and one to make deliberately rather than as a side effect.

### Active and passive delivery is `surface`, and no other field

Phase 5 needed an authoring control for "may interrupt" versus "inbox only".
The contract already had one, so **nothing was added to the schema**:

| `surface` | Delivery | What happens |
| --- | --- | --- |
| `modal` | Active | a dialog, at most one per session, and in the inbox |
| `banner` | Active | an inline notice, never blocks, and in the inbox |
| `inbox` | Passive | the inbox only — `isEligible` refuses to present it |

A `passive` boolean beside `surface` would be a second field expressing the same
fact and free to disagree with it, and every consumer would then have to decide
which one wins. `packages/schema/src/__tests__/delivery.test.ts` pins this;
`packages/mobile/src/language.ts` is only how the app says it in words.

### The inbox is history; the presenter is attention

They are separate concerns and separate state, keyed by the same id:

```
seen[id]     impressions, dismissal   → the presenter's frequency rules
inbox[id]    content, readAt          → what the user sees and has read
```

Neither is derivable from the other, which is why both exist. Dismissing the
presenter records a dismissal and removes nothing. Expiry, a revert and a remote
deletion all leave the inbox entry alone — remote lifecycle is not a request to
forget local history. There is no user-facing delete.

Being presented **does** mark the entry read, because being shown the content is
having read it. Dismissal never marks anything read on its own.

### One unread derivation, never a stored count

`InboxEntry.readAt` is the only unread state. Both indicators — the Settings tab
dot and the Announcements row dot — call the same `hasUnread` over the same
array, through `modules/announcements/inbox-store.ts`. A stored count is exactly
how two indicators end up disagreeing, so there is none.

The store is a module-level `useSyncExternalStore`, matching `AppModalHost`'s
own pattern, so the tab bar can read it without every screen re-rendering.

### The inbox is capped at 200, and protects unread items

`enforceRetention` evicts the **oldest read** entry while any read entry exists,
and only falls back to the oldest entry at all when every one of the 200 is
unread. Ties break on id, so the same inbox always evicts the same thing on
every device. The cap is applied on write and on read.

It is a **local storage limit only**. It never deletes, archives or deactivates
anything in the Manager or the repository.

### The app's state is v2, and v1 is migrated

Adding the inbox bumped `STATE_VERSION`. Phase 4 state is migrated rather than
discarded: reading v1 as unrecognised would empty `seen`, and an empty `seen`
re-shows every announcement to everyone who upgrades — the exact failure the
whole system exists to prevent.

## Where the complexity lives

| File | What |
| --- | --- |
| `packages/schema/src/validate-record.ts` | The one record validator, `authored` and `published` modes |
| `packages/core/src/build/build.ts` | The build: project → images → serialise → verify |
| `packages/core/src/publish/publish.ts` | Nothing irreversible until everything reversible has succeeded |
| `packages/core/src/publish/diff.ts` | Pure. What a publish would change, in words |
| `packages/core/src/git/repository.ts` | One commit per publish; rebase-once on rejection, never force |
| `packages/core/src/images/attach.ts` | Encode, keep exactly one original per id, read bytes back for a preview |
| `packages/github/src/device-flow.ts` | Signing in with nothing to paste, and why one poll |
| `packages/github/src/repository.ts` | One commit over HTTP; `base_tree`, and refusing to force |
| `packages/github/src/content.ts` | The repository as announcements; what shares a commit |
| `packages/authoring/src/edit.ts` | The closed editable set, and why each exclusion is excluded |
| `packages/authoring/src/authoring.ts` | The legal state moves, in one table |
| `packages/authoring/src/repo-paths.ts` | Where a record lives, said once for both transports |
| `packages/core/src/ci/publish-workflow.ts` | Where signing happens now, and what it may not do |
| `packages/client/src/session.ts` | The one secret, and where it may live |
| `packages/mobile/metro.config.js` | The monorepo, and the alias to schema source |
| `packages/mobile/app.config.ts` | What may reach a build, and the permissions blocked |
| `packages/mobile/src/language.ts` | Every word an administrator reads, and the gate they pass |
| `packages/mobile/src/media.ts` | Why an animated GIF is NOT optimised on the phone |
| `packages/mobile/src/crop.ts` | The four formats, and why a crop can never letterbox |
| `packages/mobile/src/components/image-cropper.tsx` | Pan and pinch with no dependency, why animations never arrive, and the readout that makes a pinch checkable by hand |
| `packages/mobile/src/ids.ts` | The id nobody has to invent, and why it is not random |
| `packages/mobile/src/components/announcement-form.tsx` | Five fields, and why the other thirteen are out |
| `packages/schema/src/validate-record.ts` (`validateText`) | Why a picture can be the whole announcement, and what is still refused |
| `packages/mobile/app/announcements/new.tsx` | Why there is no publish step any more |
| `packages/mobile/app/login.tsx` | The device flow, and who owns the waiting |
| `packages/mobile/app/advanced.tsx` | Everything the product hides, behind a developer-only door |
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
| `inbox.ts` | Pure. The 200-item cap, and which entry it is safe to evict |
| `inbox-store.ts` | The one unread derivation both indicators read |
| `images.ts` | Pure. Which images are worth fetching, and which may be evicted |
| `image-cache.ts` | Verify before keeping, and never a reason to suppress a record |

Two things in `git/repository.ts` are non-obvious and were bugs once:

- `isRepository()` must ask `CheckRepoActions.IS_REPO_ROOT`, not plain
  `checkIsRepo()` — the latter is true for any *subdirectory* of any repository,
  so scaffolding inside an existing checkout skipped `git init` and every later
  publish committed into the enclosing project.
- A rejected push is rebased once and retried. Never `--force`.

## The Manager UI (Phase 2) was REMOVED in Phase 8

There was a local web app — Fastify over `core`, with a React client — and it is
gone with the server that hosted it. What it did, and where each part went:

| It had | Now |
| --- | --- |
| Dashboard, record list, editor | the Android Manager |
| Image attach and preview | the Android Manager |
| Publish flow with a dry-run diff | `announce publish`, and the workflow |
| `git log`, push, revert | `git`, in a checkout |
| The advanced fields (`rev`, `priority`, `category`, targeting, staging) | the CLI, and only the CLI |

**That last row is a real loss and should be said plainly**: those five are
still in the contract, still validated, and no longer editable from any UI. If
somebody wants them back, the honest options are a CLI command (cheap) or a
second front end over `packages/github` (not cheap) — not adding them to the
phone form, which exists to ask five questions.

Postponed deliberately, still: rich content, localisation (the schema leaves
room — `title`/`body` stay plain strings in v1 and an optional `i18n` map is a
non-breaking v2 addition), templates, A/B testing, analytics.

Not built, and worth knowing you have not got: no undo beyond `git revert`, and
no merge of two concurrent edits — the second writer is told and re-reads,
rather than being merged or silently winning.

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

### A pinch cannot be injected from `adb`, so zoom needs a human finger

Everything else on the device can be driven from the command line. The pinch
cannot, and the failure is a convincing impostor: the gesture is accepted,
reported as delivered, and the app does not move — which reads exactly like a
broken zoom handler.

What was established, in order, on a CPH1937 running Android 11 (ColorOS):

| Route | Result |
| --- | --- |
| `adb shell input` | single pointer only. There is no multi-touch subcommand. |
| `sendevent` on `/dev/input/event1` | `Permission denied`. Shell IS in group `input` and the node is `crw-rw----`, so this is SELinux, not DAC, and a `user` build has no way round it. |
| `InputManager.injectInputEvent` from `app_process` | taps and one-finger drags **work**. `ACTION_POINTER_DOWN` and every two-pointer `ACTION_MOVE` after it are **dropped in silence**, under a real touchscreen device id and under id 0 alike. |

The proof it is the harness and not the app: with the injector sending four
single-pointer moves before the second finger lands, the app's own debug readout
shows `touches 1 · dx 2` and then stops changing. The single-pointer half of the
same injected stream arrives; the app never sees a second pointer.

Two things are worth knowing before repeating any of this:

- **A real device id is required.** `MotionEvent` injected with `deviceId` 0 and
  no `setDisplayId` is accepted and reaches nothing at all — the same silent
  shape as above, one layer earlier. `input` picks a device whose source
  includes `SOURCE_TOUCHSCREEN`, and so must anything imitating it.
- **`adb shell settings put system pointer_location 1`** — the obvious way to
  watch what the system thinks it received — is refused here: shell holds
  neither `WRITE_SETTINGS` nor `MANAGE_APP_OPS_MODES`.

So zoom is verified by a person: Advanced → Open the image editor → Load the
test card → pinch. The readout under the frame prints the touch count and the
scale, and the test card's circle is the distortion oracle — one scale factor on
both axes keeps it round, and anything else makes it an ellipse.

### The Development Build cannot reach Metro, so it runs a stale bundle

Symptom, and it is a misleading one:

```
There was a problem loading the project.
java.net.ConnectException: Failed to connect to /192.168.100.115:8081
  ... Caused by: android.system.ErrnoException: isConnected failed: ETIMEDOUT
```

`ETIMEDOUT` rather than `ECONNREFUSED` is the whole diagnosis. Refused means
nothing is listening; timed out means the packets are being dropped in silence,
which is what Windows Firewall does by default to an inbound connection with no
matching allow rule. Metro binds `::` on 8081 and is listening fine.

The consequence is worse than a failed load, because the dev client falls back
to the last bundle it cached. The app starts, everything from that older build
works, and anything added since is simply absent — which reads exactly like a
feature that was never wired up. **Announcements missing from Settings was this,
not a bug in the section.**

The fix is one inbound rule, in an **elevated** PowerShell, once:

```powershell
New-NetFirewallRule -DisplayName "Expo Metro 8081" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8081 `
  -Profile Private -RemoteAddress LocalSubnet
```

Scoped to `Private` and `LocalSubnet` deliberately: the Wi-Fi profile is already
Private, and Metro serves the whole working tree to anyone who can reach it.

Then force a fresh bundle rather than trusting the cached one — `npx expo start
--dev-client -c`, and on the device use **Reload**, not resume.

This machine has several interfaces (`192.168.0.2` on Ethernet, `192.168.100.115`
on Wi-Fi). The phone must be on the Wi-Fi subnet, and Metro must be advertising
that address — check the URL the dev client is dialling against the one Metro
prints.

Phase 5 and the URL fix are pure TypeScript. **No native rebuild is required**;
a reload over Metro is enough.

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
