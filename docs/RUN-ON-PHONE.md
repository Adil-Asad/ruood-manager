# Running RUŌOD Manager on your phone

Everything you need to go from a fresh phone to publishing an announcement.

**This document was rewritten for Phase 8.** It used to describe pairing a
phone with a Manager server on the PC — an address, a port, a pasted token, a
firewall rule and a tailnet. None of that exists any more. If you are looking
for `4874`, `--tailnet` or `manager-token`, they are gone deliberately; see
`docs/ANDROID.md` §1 for why.

---

## What you need, once

| | |
| --- | --- |
| A GitHub account | the administrator signs in with it |
| An announcements repository | e.g. `<owner>/ruood-announcements` |
| A GitHub App with **Device Flow** enabled | it provides sign-in. Its client id is compiled into the app |
| `ANNOUNCEMENT_SIGNING_KEY` as a repository secret | the publishing workflow signs with it |

Full setup for the repository side is `docs/OPERATING.md`. This document is the
phone.

---

## 1. Install the app

There is no development server to start and no machine that has to stay awake.

```bash
# a QA build, installable directly
GITHUB_CLIENT_ID=Iv23li... ANNOUNCEMENTS_OWNER=<owner> ANNOUNCEMENTS_REPO=<repo> \
  npx eas build --profile preview --platform android
```

Install the resulting APK. Or, over USB from this checkout:

```bash
export APP_VARIANT=preview
npm run bundle -w @ruood/announcement-manager-android
adb install -r packages/mobile/android/app/build/outputs/apk/release/app-release.apk
```

`APP_VARIANT` must be **exported**, not set on one command line. `app.config.ts`
is read twice — once by `prebuild` and once by the bundler Gradle runs — and
setting it for only the first produces an APK whose build badge disagrees with
its own application id.

---

## 2. Sign in

Open the app and tap **Sign in with GitHub**.

It shows eight characters. Open `github.com/login/device` on whatever device is
nearest — the phone's own browser is fine, and the button does it for you — type
the code, and approve. The app continues on its own.

That is the whole of it. No address, no port, no token to paste, no QR code.

**Read the screen before approving.** The device flow has no redirect URI, which
means anyone can start one and ask you to approve *their* sign-in. The app names
what is asking; if you did not start it, do not approve it.

---

## 3. Lost, replaced or stolen phone

Install the app again and sign in. There is nothing to restore, because there is
nothing on the device worth restoring — the repository is the system of record.

To cut off a device you no longer have, revoke it on GitHub: **Settings →
Applications → Authorized GitHub Apps**. That is per-device and leaves an audit
trail.

A stolen phone can change what is published. It **cannot** change what
publishing does: its token can write `content/` and cannot touch
`.github/workflows/`, so it can never make the workflow reveal the signing key.

---

## 4. Two people, two phones

Supported, and it was not before. Each writes through the GitHub API, and every
ref update is made with `force: false`.

If two edits collide, the second one is **refused, not merged and not silently
overwritten**. The app says so, re-reads, and you make the edit again on top of
what is actually there.

---

## 5. Publishing, and what "shortly" means

There is no publish button, because writing `content/` *is* publishing:

| Button | What it writes |
| --- | --- |
| **Save Draft** | `status: draft` — the build excludes drafts entirely |
| **Publish** | `status: published` — the build includes it |

The commit triggers `publish.yml`, which builds, validates, optimises, signs and
writes `dist/`. GitHub Pages then serves it.

The app says **"will reach RUŌOD users shortly"** rather than "is live", and that
is deliberate: the workflow takes a minute or two, and the app will not claim
something you could check and find untrue.

To watch it: the **Actions** tab of the announcements repository.

---

## 6. What is not on the phone

`rev`, `priority`, `category`, targeting and the staging channel are **CLI
only**. The form asks five questions on purpose. Everything else is still in the
contract, still validated, and still editable:

```bash
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js <command> --repo <path to announcements repo>
```

---

## 7. If something goes wrong

| Symptom | Cause |
| --- | --- |
| "This app has not been set up" | built without `GITHUB_CLIENT_ID` / repository. A development build can set a client id in **Advanced**; anything else needs a rebuild |
| Sign-in code expires | codes are short-lived. Tap for a new one |
| "Someone else changed this first" | the concurrent-edit refusal in §4. Re-read and redo the edit |
| Published but nothing on the device | check the **Actions** run first, then that RUŌOD Lab's pinned URLs carry the `dist/` prefix |
| A development build shows stale screens | it is running a cached bundle because it cannot reach Metro. See the Known issues entry in `CLAUDE.md` — it is a Windows Firewall rule, and the symptom is `ETIMEDOUT`, not `ECONNREFUSED` |
