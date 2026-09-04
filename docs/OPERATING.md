# Setting up RUŌOD Manager

Everything somebody has to do once, so that an administrator can then write
announcements from a phone without ever seeing any of it.

There is no server to run and no machine that has to stay awake.

---

## What is actually running where

```
  The administrator's phone              GitHub
  ─────────────────────────              ──────────────────────────────────
  RUŌOD Manager (Android)                announcements repository
    signs in with GitHub  ──────────▶      content/   ← the app commits here
    writes, schedules, deletes                │
    never holds a signing key                 │  publish.yml, on every change
                                              ▼  sharp → build → verify → SIGN
                                            dist/  ──▶ Pages ──▶ RUŌOD Lab
```

Two repositories, and they stay separate:

| | |
| --- | --- |
| **Manager repository** (this one) | builds the Android app and the CLI. Contains no announcements. |
| **announcements repository** | the source of truth for announcement content and publication. Contains no app. |

The publishing workflow lives in the announcements repository and checks this
one out as a build tool, at a pinned ref. Neither is a submodule of the other,
and either can be replaced without touching the other's history.

**The signing key is a secret of the workflow.** It is not on the phone, not in
the app, not in any build of it, and not on anybody's laptop. Losing a phone
does not put it at risk, because the phone never had it.

---

## 1. Create the GitHub App

One app, for signing in from the phone. A **GitHub App** rather than an OAuth
App: its token is limited to the repositories it is installed on and to the
permissions it declares, where an OAuth App token carries a coarse scope that
reaches every repository the person can write to.

In **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Repository permissions → Contents: Read and write.**
- **Leave Workflows unset.** This is the one that matters. `Contents` and
  `Workflows` are separate permissions, so a token that can write `content/`
  cannot edit `.github/workflows/` — which is why the signing key can be an
  ordinary repository secret. A stolen phone can change what is published; it
  cannot change what publishing *does*, and so cannot make it print the key.
- Tick **Enable Device Flow**. Until this is on, GitHub answers the sign-in
  endpoints with 400 and a body that does not say why.
- No callback URL and no webhook are needed.

Install it on the announcements repository, and note the **Client ID** (public —
a device-flow client has no secret).

---

## 2. Put the signing key in the announcements repository

If you do not have a key yet, make one on any machine:

```bash
node packages/cli/dist/bin.js keygen --repo <path to a checkout>
```

That writes the private key outside every repository and commits the **public**
key record, which is what CI and RUŌOD Lab check against.

Then, in the **announcements** repository, add the private key as a secret:

**Settings → Secrets and variables → Actions → New repository secret**

- Name: `ANNOUNCEMENT_SIGNING_KEY`
- Value: the whole PEM, `-----BEGIN PRIVATE KEY-----` line included

The workflow reads it from the environment and never writes it to disk.

> **Later, if you want a stronger guarantee:** move that secret to an
> **Environment** called `announcements` and add a required reviewer. Every
> publish then waits for your approval, and a repository compromise alone cannot
> produce a signed manifest. This is a repository *setting* — the workflow
> already names that environment, so nothing needs rewriting.

---

## 3. Add the workflow

`announce init` scaffolds it. For a repository that already exists, copy
`.github/workflows/publish.yml` from a freshly scaffolded one, or generate it:

```bash
node -e "
const { publishWorkflow } = require('./packages/core/dist/index.js');
console.log(publishWorkflow({
  managerRepository: 'Adil-Asad/ruood-manager',
  managerRef: 'v1.0.0',
}));
" > ../announcements/.github/workflows/publish.yml
```

**Pin `managerRef` to a tag or a commit, not to `main`.** On a branch, a change
in this repository would silently change what every publish signs. Upgrading the
toolchain should be a commit in the announcements repository, visible in its
history beside the manifests it produced.

---

## 4. Give the administrator access

Add their GitHub account to the announcements repository with **Write**
permission. That is the whole of authorisation — there are no accounts to
create, no passwords to set and no sessions to manage.

To revoke: remove their access, or revoke the app's authorisation for their
account. Both take effect on the next request.

---

## 5. Build the app

```bash
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx \
ANNOUNCEMENTS_OWNER=Adil-Asad \
ANNOUNCEMENTS_REPO=ruood-announcements \
  npx eas build --profile preview --platform android
```

Locally, without an EAS account:

```bash
export APP_VARIANT=preview
export GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
export ANNOUNCEMENTS_OWNER=Adil-Asad
export ANNOUNCEMENTS_REPO=ruood-announcements

npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
# android/app/build/outputs/apk/release/app-release.apk
```

**`export`, not a prefix on the prebuild line.** A local release build reads
`app.config.ts` twice — once by `expo prebuild`, which fixes the application id,
and again by `expo export:embed`, which Gradle runs to produce the JS bundle.
They are separate processes with separate environments, and setting the
variables for only the first produces an APK whose bundle was configured
differently from its manifest.

---

## What the administrator then does

1. Install the app.
2. Tap **Sign in with GitHub**, read the eight-character code, type it at
   `github.com/login/device`, approve.
3. Announcements → New Announcement.
4. Image, title, message, Active or Passive, Immediately or Scheduled.
5. Publish.

A minute or two later the workflow has built and signed it, and RUŌOD Lab picks
it up on its next fetch.

They never see a repository, a manifest, a revision, a signing key, a commit, a
channel, a port or a terminal. If they ask about any of those, something has
leaked and it is a bug.

**Losing the phone:** install the app on a new one and sign in again. There is
nothing to restore — the announcements are in the repository, and the credential
is GitHub's to issue. Revoke the old device in GitHub → Settings →
Applications if you want its token dead sooner.

---

## When something is wrong

| What they see | What it means | What to do |
| --- | --- | --- |
| "This app is not set up for device sign-in yet" | The Device Flow checkbox is off. | Tick it on the GitHub App. |
| "Your account cannot change these announcements" | No write access, or the app is not installed on the repository. | Grant Write; install the app. |
| "Your GitHub sign-in has expired" | Token revoked or expired. | Sign in again. |
| "Someone else changed the announcements while you were working" | Two people wrote at once. Nothing was overwritten. | Check the list and redo the change. |
| "This image is too large" | Over 20 MB, or an animation over 12 MB. | A smaller image. |
| Published, but nothing appears | The workflow failed. | Look at the Actions tab in the announcements repository. |

Developer diagnostics — the client id, the repository, the commit the app is
looking at — are under **Settings → Advanced**, and only in a development or
preview build.

---

## The operator's own tools

The CLI still does everything, against a local checkout, for the fields the
phone deliberately does not expose (`rev`, `priority`, `category`, targeting,
the staging channel):

```bash
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js <command> --repo <path to announcements repo>
```

`announce publish --sign` still works locally with the key at
`~/.ruood/announcement-signing.key`, which is how you would publish if GitHub
Actions were unavailable.

---

## The two signings, which share nothing

| | Android app signing | RUŌOD announcement signing |
| --- | --- | --- |
| authenticates | the APK to Android | a manifest to RUŌOD Lab |
| key | Play / EAS upload key | Ed25519, key id `2bc1e956` |
| lives | Google's servers | `ANNOUNCEMENT_SIGNING_KEY`, a secret of the announcements repository |
| rotating it | a Play Console operation | **an app release of RUŌOD Lab** |

`docs/ANDROID.md` is the full record.
