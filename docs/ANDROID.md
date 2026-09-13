# RUOOD Manager for Android

RUŌOD Manager as a real Expo/React Native application, built, signed and
shipped through EAS and Google Play.

The app is the administration client for RUŌOD Lab. Announcements are its
first module; the screens are Home, Announcements and Settings rather than
anything named after the machinery underneath.

This document covers the app: what it is, why it is shaped this way, how to
build each artefact, and the two things that must never be confused with each
other. `ARCHITECTURE.md` remains the record of why the *system* is the way it
is; nothing in it was overturned to make this.

---

## 1. Why the app is a client of GitHub, and not a port of the Manager

The Manager does four things that cannot happen on a phone:

| What | Why not on Android |
| --- | --- |
| reads and writes `content/` | it is a git checkout on somebody's disk |
| commits and pushes | there is no git on Android, and no credentials to give it |
| encodes images | `sharp` is libvips - native, Node-only |
| **signs manifests** | the Ed25519 private key must never reach a device |

The fourth is the one that settles it. The whole security model of RUOOD Lab's
announcements rests on one private key authenticating a manifest to every
install. Putting that key in an APK would end the model: an APK is a zip, and
anything inside one is readable by anyone who downloads it.

**Phases 6 and 7 answered this with a server.** The phone was a client of a
Manager process on the operator's PC, which held the checkout, `sharp` and the
key. That worked, and it had a property the operator would not accept: the
product depended on one machine being awake, and a lost phone had to be
re-paired against it.

**Phase 8 answered it with GitHub instead.** The phone writes `content/` through
the GitHub API; a workflow in the announcements repository builds, validates,
optimises and signs. The signing key is a secret of that workflow.

```
Android Manager --device flow--> GitHub (identity)
                --commits content/--> announcements repository
                                            |  publish.yml, pinned toolchain
                                            v  sharp -> build -> verify -> SIGN
                                          dist/ --> Pages --> RUOOD Lab
```

The phone can change **what** is published. It cannot change what publishing
**does** - because `Contents` and `Workflows` are separate fine-grained
permissions, and its token has only the first. That single fact is what allows
the signing key to be an ordinary Actions secret rather than a file on a laptop,
and section 2 is about keeping it distinct from the other key.

What it cost, stated plainly: the signature now proves *this came through the
pipeline*, not *a human with an offline key approved it*. Anyone who can push to
`main` can cause a signed publish. That is unavoidable once a phone publishes
without a particular machine being awake, and the upgrade path is a setting -
`publish.yml` already names an `announcements` environment, so moving the secret
there and adding a required reviewer gates every publish on approval with no
code change.

---

## 2. The two signings, which share nothing

This is the single most important distinction in this document.

| | Android app signing | RUŌOD announcement signing |
| --- | --- | --- |
| **What it authenticates** | the APK/AAB, to Android | a manifest, to RUŌOD Lab |
| **Key** | upload key / Play app signing key | Ed25519, key id **`2bc1e956`** |
| **Held by** | Google Play, or EAS credentials | the operator's machine only |
| **Where it lives** | EAS servers / Play Console | `~/.ruood/announcement-signing.key`, mode `0600` |
| **Rotation** | a Play Console operation | **an app release of RUŌOD Lab** — the public key is compiled in |
| **In this repository** | nothing | the *public* half, at `keys/announcement-signing.pub` |

They are never in the same process, never in the same store, and rotating one
has no bearing on the other. EAS holding an Android upload key is not, and must
never be described as, "EAS holds the signing key".

### Where the announcement private key is allowed to exist

**Allowed:** `~/.ruood/announcement-signing.key` on the operator's machine, mode
`0600`, outside every repository. `saveSigningKey` refuses a path inside a
repository by path containment — not by trusting a `.gitignore`, because the
failure being prevented is exactly the one where the ignore rule is missing.

**Never, under any circumstances:**

- in the APK or the AAB
- in `app.config.ts`, `extra`, or any Expo config value
- in JavaScript shipped to a device
- in `AsyncStorage`, `SecureStore`, or any app storage
- in an app asset
- in either repository
- in a log line, an error message, or a crash report
- behind any API endpoint the app can call

`packages/mobile/src/__tests__/config.test.ts` and `bundle.test.ts` assert this
against the config *and* against the built Hermes bundle, because a review
cannot see a secret that arrived through a dependency.

---

## 3. Authentication: the GitHub device flow

### There is no token to paste, and nothing to recover

The administrator taps **Sign in with GitHub**, reads eight characters, types
them at `github.com/login/device` on whatever device is nearest, and approves.
No address, no port, no token, no QR code, no terminal.

Phases 6 and 7 had a bearer token in `~/.ruood/manager-token`, a pairing blob to
paste, and `--new-token` to revoke. All three are gone, along with the server
that issued them.

### Why the device flow specifically

It is the only one of GitHub's flows that needs **no client secret** - which
matters absolutely here, because anything compiled into an APK is readable by
anyone who unzips it. There is no secret to leak because there is none. The
client id is compiled in and is not a credential.

Three consequences, and they are the reason this replaced pairing:

- **Recovery is reinstalling.** Nothing on the old device is worth recovering.
- **Revocation is GitHub's**, per device, with an audit trail this project would
  otherwise have had to build.
- **No single-device dependency.** Nothing waits on a particular machine.

### The cost, from GitHub's own guidance

The device flow has no redirect URI, so an attacker can start one and phish
somebody into approving it. The defence is entirely in the words on screen,
which is why the sign-in screen names what is asking rather than only printing a
code.

### `pollForToken` performs exactly ONE poll

The waiting belongs to the screen, which has to stay responsive, show progress,
honour a `slow_down` **permanently**, and stop when somebody navigates away. A
loop inside the library would own all of that and expose none of it - and going
back to the old interval after a `slow_down` is how a client is throttled out of
the flow entirely.

### What is stored on the device

| | Where | Why there |
| --- | --- | --- |
| the access token | `expo-secure-store`, Android keystore | it can write the announcements repository |
| a refresh token, when the app is configured to expire tokens | the same | dropping it would sign the administrator out every eight hours |
| the client id override | ordinary preferences | a device-flow client id is public, and a development build needs to set one without a rebuild |

Token expiry is an **optional** GitHub App feature. With it off, the access
token does not expire and no refresh token is issued; `IssuedToken.expiresAt` is
then `null` rather than `0`, because "never expires" and "expired at the epoch"
must not be the same value.

---

## 4. Project structure

```
packages/
  schema/    the contract. ZERO dependencies, platform-neutral. Unchanged.
  authoring/ NEW in Phase 8 - the PURE record operations: createRecord,
             applyEdits, applyTransition, and the repository-relative paths.
             Extracted from core so the phone and the publishing build run
             identical code.
  core/      build, images, git, SIGNING. Node-only. Re-exports authoring, so
             every existing import path still resolves.
  client/    the platform-neutral plumbing: the injected Http port, the
             credential store, base64, and the pure presentation helpers.
  github/    NEW in Phase 8 - device flow, the Git Data API, and content/ as
             announcements. Platform-neutral, transport injected.
  cli/       every operation, headless. What the publishing workflow runs.
  mobile/    the Expo/React Native Android application.
```

`packages/ui` - the Fastify server and the browser Manager - was **removed** in
Phase 8, along with accounts, sessions, throttling and pairing.

### Why `authoring` was split out of `core`

The CLI runs `core` against a working copy. The app cannot: it has no checkout,
no `sharp` and no git. Rather than duplicate the record rules on the phone, the
shared part was pulled *down* into a package both import. The phone is not
producing an approximation of a record for something else to correct - it is
producing the record, with the same function the publishing build reads it back
with.

Where they genuinely differ is only transport: `core/src/content/store.ts`
writes a working copy, `github/src/content.ts` writes over the API. **If a rule
appears in one and not the other, they have started to disagree**, and the
symptom is a record that saves on the phone and is refused by the build with
nothing to point at.

### The mobile app runs the real validator

`metro.config.js` aliases `@ruood/announcement-schema`, `-client`, `-authoring`
and `-github` to their **source**, for the documented reason: their `dist` is
CommonJS, and `export * from` through it is a re-export a bundler cannot analyse
statically.

The consequence is the property the whole project is built on - the phone runs
the same validator the publishing build uses, not a copy of it.
`bundle.test.ts` asserts that schema literals really are in the shipped
bytecode, so the alias cannot silently stop working.

---

## 5. Environments — and the two axes that must not be conflated

| Axis | Values | Set by | What it decides |
| --- | --- | --- | --- |
| **App variant** | `development` / `preview` / `production` | `APP_VARIANT`, from the EAS profile | which build of the Manager app this is |
| **Publish channel** | `staging` / `production` | the operator, per publish | which manifest is written |

They are independent. A development build can publish to production; a
production build can publish to staging. Collapsing them would be how a test
announcement reaches every install.

Each variant gets its own application id and launcher name, so they install side
by side and cannot be confused:

| Variant | Application id | Name |
| --- | --- | --- |
| development | `com.ruood.announcementmanager.dev` | Announcements (dev) |
| preview | `com.ruood.announcementmanager.preview` | Announcements (preview) |
| production | `com.ruood.announcementmanager` | RUOOD Announcements |

### Guarding production publishes

The publish screen:

- **starts on `staging` on every mount, and resets to it after every publish.**
  A screen that remembers "production" from an hour ago is a screen that
  publishes to production when someone taps the obvious button;
- paints the production banner and button in the alarm colour;
- requires the word **`PUBLISH`** to be typed before a production publish
  commits. Staging requires nothing, which is the point.

---

## 6. Building

All commands run from the repository root.

### Prerequisites

```bash
npm install
npm run build          # schema → core → client → cli → ui
```

### Development build (Metro, on a physical device)

```bash
npx eas build --profile development --platform android
# install the APK, then:
npm run start -w @ruood/announcement-manager-android    # expo start --dev-client
```

A development build **may** use Metro. That is what it is for.

### Preview APK (QA, no Metro, no PC)

Every command in this document runs from `packages/mobile`. That directory is
the Expo project; the workspace root is not one, and an `eas` command run there
produces a build that fails in the bundler on `Unable to resolve module
../../App` -- see "There is exactly ONE Expo project" in `CLAUDE.md`.

```bash
cd packages/mobile
npx eas build --profile preview --platform android
```

Produces an installable APK that needs no development server, no `localhost`
and no machine of the operator's switched on at all. It shows the sign-in
screen and runs standalone.

What it does need is a **GitHub client id and an announcements repository**,
compiled in at build time:

```bash
GITHUB_CLIENT_ID=Iv23li... ANNOUNCEMENTS_OWNER=<owner> ANNOUNCEMENTS_REPO=<repo> \
  npx eas build --profile preview --platform android
```

None of that is a secret. A device-flow client id has no client secret, and the
repository is public. A build assembled without them is not broken — it says so
on the sign-in screen, and a development build can be given a client id from
Advanced without rebuilding.

### Production AAB (Google Play)

```bash
npx eas build --profile production --platform android
```

`autoIncrement: true` with `appVersionSource: "remote"` means **EAS owns the
version code**. Two builds sharing one is a Play upload rejection, and the way
that happens is a human editing a number.

`true` rather than `"version"` deliberately: `"version"` would also bump the
patch of `versionName` on every build, so `1.0.0` would silently become `1.0.7`
after seven builds of the same code. The version *name* is what users see and it
is a deliberate decision; the version *code* is bookkeeping and should be
automatic. They are separate for a reason and are kept separate here.

### Local verification, without an EAS account

```bash
npm run bundle   -w @ruood/announcement-manager-android   # the real shipping JS bundle
npm run prebuild -w @ruood/announcement-manager-android   # real AndroidManifest
npm run typecheck -w @ruood/announcement-manager-android
npm run lint      -w @ruood/announcement-manager-android
npm run doctor    -w @ruood/announcement-manager-android
npm test          -w @ruood/announcement-manager-android
```

`export` and `prebuild` produce the two artefacts the security tests read. Run
them before trusting a clean test run — `bundle.test.ts` and `manifest.test.ts`
**skip loudly** rather than fail when they are missing, because a test that
fails on a fresh clone is a test people learn to ignore.

---

## 7. Permissions

The app requests **none** of its own. What survives into the manifest:

| Permission | Why |
| --- | --- |
| `INTERNET` | talking to the Manager, which is the whole app |
| `READ_EXTERNAL_STORAGE` | picking an image on Android below 13 |
| `VIBRATE` | React Native core; a `normal` permission, no prompt |

Three are **blocked**, because libraries add them unasked and `permissions: []`
does not stop a plugin merging into the manifest:

| Blocked | Added by | Why it is refused |
| --- | --- | --- |
| `RECORD_AUDIO` | expo-image-picker | the module can record video; this app picks a still image |
| `WRITE_EXTERNAL_STORAGE` | expo-image-picker | the app reads one image and writes nothing |
| `SYSTEM_ALERT_WINDOW` | React Native | "display over other apps" has no place in a release build |

This was found by reading the **generated** `AndroidManifest.xml`, not the
config — the config said `permissions: []` while the manifest said
`RECORD_AUDIO`. `manifest.test.ts` now checks the manifest so it cannot return.

`usesCleartextTraffic` is **disabled**, and this changed in Phase 8. It used to
be enabled, for one reason: the app spoke plain HTTP to a Manager server on a
private network. That server is gone, and everything the app talks to now is
`api.github.com` over TLS.

`manifest.test.ts` asserts `usesCleartextTraffic="false"` rather than simply not
checking it, because turning it back on would look like nothing at all — no
error, no warning, and every request readable by anyone on the network.

---

## 8. Google Play

### Internal Testing

```
EAS production build  →  .aab  →  Play Console  →  Internal testing  →  install
```

Everything that can be configured in the repository is. The remaining steps need
a Google Play account and are therefore the operator's:

1. **Create the app** in the Play Console. Package name
   `com.ruood.announcementmanager` — permanent once published.
2. **Complete the Data safety form.** The honest answers: no data is collected,
   no data is shared, no analytics, no advertising. The app talks only to a
   server the user configures on their own network.
3. **Set up Play App Signing** (the default). Google holds the app signing key;
   EAS holds the upload key. Neither is the announcement signing key.
4. **Create an Internal testing track** and add tester email addresses.
5. **Upload the AAB**, or let EAS submit it:
   ```bash
   npx eas submit --profile production --platform android
   ```
   `eas.json` sets `track: internal` and `releaseStatus: draft`, so a submit
   lands as a draft on the internal track and never auto-promotes.

### Closed testing, then production

Play requires a closed test with testers before a new personal developer account
can go to production. The path is Internal → Closed → Production, and it is a
Play Console operation at each step; nothing in this repository changes.

Since the audience for this app is the operator, Internal Testing may well be
the permanent home. Nothing here forces a production release.

---

## 9. What is NOT built

Worth knowing you have not got:

- **No offline authoring.** The repository is the system of record, and the app
  re-reads after every write. A local draft cache would be a second copy free to
  disagree with it.
- **No merge of two concurrent edits.** Two administrators with two phones is
  now possible, where one Manager against one checkout made it impossible. The
  second writer is told (`ConcurrentUpdate`) and re-reads - never merged, and
  never silently overwritten, because ref updates are made with `force: false`.
- **No push notifications.** Nothing to notify about.
- **No advanced fields on the phone.** `rev`, `priority`, `category`, targeting
  and the staging channel are CLI-only since `packages/ui` was removed. That is
  a real loss of a UI and no loss of capability.
- **No iOS build.** The configuration is Android-only. Nothing prevents iOS, but
  nothing has been tested for it.
- **No verified pinch-to-zoom in automation.** It cannot be injected through
  `adb` on a production build; see the Known issues entry in `CLAUDE.md`. The
  crop editor carries a developer-only touch readout so a person can confirm it
  in one gesture.

---

## 10. `expo-dev-client` was removed

It used to sit in `dependencies` so the `development` EAS profile could set
`developmentClient: true`. Its `expo-dev-launcher` declares two Google libraries
**unconditionally** in its own `build.gradle` — not per-variant:

```gradle
implementation "com.google.android.gms:play-services-code-scanner:16.1.0"
implementation "com.google.mlkit:barcode-scanning:17.3.0"
```

so `libbarhopper_v3.so` — 4.9 MB of ML Kit barcode scanning, for QR pairing this
app never uses — shipped in the **release** APK as well. Autolinking confirmed
it: 20 modules linked, four of them dev-client modules, in a production build.

It is gone. The package is removed, the `development` profile is a plain debug
APK, and autolinking now resolves 13 modules with no dev-related entries.

**Nothing was lost.** A debug build talks to Metro on its own — that is standard
React Native behaviour. The dev launcher was only a picker UI on top of it, and
its one unique feature, QR scanning, is the thing that dragged in ML Kit -
and since Phase 8 there is no pairing to scan or paste at all: signing in is
the device flow.

## 11. One React, enforced by `overrides`

The root `package.json` pins `react` and `react-dom` to `19.1.0` for the whole
workspace. That is not tidiness — without it the release APK **crashed on
launch**:

```
com.facebook.react.common.JavascriptException:
  TypeError: Cannot read property 'useRef' of null
    at useNavigationContainerRef / ContextNavigator / ExpoRoot
```

The workspace held React 19 for this app and React 18 as a transitive peer of
the browser client. npm hoisted `@react-navigation/core` to the repository root,
where it resolved React from the **root** `node_modules` — so the navigation
stack bound to React 18 while everything else bound to 19, and its hooks
dispatcher was null.

This is worth spelling out because an earlier note in this file claimed the
duplicate was harmless and "settled by `nodeModulesPaths` order". That is true
for the app's own imports and **false** for a transitively-hoisted package that
resolves React from its own directory. The bundle carried both version strings.

Nothing else catches it: it typechecks, lints, bundles, and `expo-doctor`
reported it only as a duplicate-dependency warning that reads as cosmetic. Only
a real device showed it, and only in a release build.

`packages/mobile/src/__tests__/bundle.test.ts` now asserts that no React 18
string appears in the shipped bundle.
