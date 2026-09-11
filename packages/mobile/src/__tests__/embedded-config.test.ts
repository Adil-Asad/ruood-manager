/**
 * What configuration actually reached the APK.
 *
 * ## Why this exists
 *
 * `config.test.ts` asserts that the GitHub coordinates are **absent** when the
 * build was given none — it runs with no environment set, and an absent key is
 * the correct outcome there. That is a real assertion and it stays.
 *
 * It also means the whole suite passes green for a build that shipped with
 * nothing configured, which is exactly what happened: a preview APK was
 * assembled with only `APP_VARIANT` exported, and every test agreed. The app
 * installed, started, and said "This app has not been set up", and nothing in
 * CI had a way to notice.
 *
 * So this is the other half, and it reads the **artefact** rather than the
 * source:
 *
 *     packages/mobile/android/app/build/intermediates/assets/release/
 *       mergeReleaseAssets/app.config
 *
 * That file is what `expo-constants` serves to `Constants.expoConfig` on the
 * device, so it is the literal answer to "what does the installed app believe",
 * not an approximation of it. `src/config.ts` reads nothing else.
 *
 * ## What it deliberately does NOT assert
 *
 * **The values.** `Adil-Asad` and `ruood-announcements` are not in here, and
 * must not be. The repository is addressed at runtime precisely so that
 * pointing a build at a different one is an environment variable rather than a
 * code change; a test that pinned the names would undo that and would fail for
 * anybody building this against their own repository.
 *
 * What is worth pinning is the **shape**: that the keys are there, that they
 * are not placeholders somebody pasted out of the documentation, and that a
 * half-configured build — a client id with no repository, or the reverse — is
 * caught. Those are the failures that produce a working-looking APK.
 *
 * It SKIPS, loudly, when no release build has been made. `android/` is
 * gitignored and regenerated, and a test that fails on a fresh clone is a test
 * people learn to ignore — the same reasoning as `bundle.test.ts` and
 * `manifest.test.ts`, and the same shape.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MOBILE = join(__dirname, '..', '..');

const EMBEDDED = join(
  MOBILE,
  'android',
  'app',
  'build',
  'intermediates',
  'assets',
  'release',
  'mergeReleaseAssets',
  'app.config',
);

interface Extra {
  appVariant?: string;
  githubClientId?: string;
  announcementsOwner?: string;
  announcementsRepo?: string;
  announcementsBranch?: string;
}

const found = existsSync(EMBEDDED);
const extra: Extra = found
  ? (((JSON.parse(readFileSync(EMBEDDED, 'utf8')) as { extra?: Extra }).extra ?? {}) as Extra)
  : {};

const describeEmbedded = found ? describe : describe.skip;

if (!found) {
  console.warn(
    '\n  SKIPPED: the embedded Expo config check.\n' +
      '  Build a release first, with the build variables exported:\n' +
      '    cd packages/mobile/android && ./gradlew assembleRelease\n' +
      '  See docs/RUN-ON-PHONE.md §1 for the four variables it needs.\n',
  );
}

/** Placeholders from the documentation. A build configured with one of these
 *  is a copy-paste that nobody finished, and it fails at sign-in rather than
 *  at build time — which is the worst place to find out. */
const PLACEHOLDERS = [
  'Iv23li...',
  'Iv1.xxxx',
  'Iv1.xxxxxxxxxxxx',
  '<owner>',
  '<repo>',
  'owner',
  'repo',
];

describeEmbedded('the Expo config embedded in the release APK', () => {
  it('is the real resolved config, not an empty file', () => {
    // A guard on the guard: without this, every assertion below could pass
    // vacuously against `{}` and report a configured build.
    expect(Object.keys(extra).length).toBeGreaterThan(0);
    expect(extra.appVariant).toBeDefined();
  });

  it.each([
    ['the GitHub client id', 'githubClientId'],
    ['the announcements owner', 'announcementsOwner'],
    ['the announcements repository', 'announcementsRepo'],
  ] as const)('carries %s', (_what, key) => {
    // The three that `src/config.ts` needs before it will offer a sign-in.
    // Absent is the documented signal for "never set" — `app.config.ts` omits
    // an unset variable rather than writing an empty string — so an absent key
    // here means the environment did not reach Gradle.
    const value = extra[key];
    expect(typeof value).toBe('string');
    expect((value ?? '').trim().length).toBeGreaterThan(0);
  });

  it('carries no placeholder copied out of the documentation', () => {
    for (const key of ['githubClientId', 'announcementsOwner', 'announcementsRepo'] as const) {
      expect(PLACEHOLDERS).not.toContain((extra[key] ?? '').trim());
    }
  });

  it('is configured for a repository AND a client id, never one of the two', () => {
    // The half-configured build is the one that looks fine until somebody tries
    // to sign in. `hasRepository()` and `compiledClientId()` are checked
    // together at launch, so either alone is an APK that cannot work.
    const hasClient = (extra.githubClientId ?? '').trim().length > 0;
    const hasRepository =
      (extra.announcementsOwner ?? '').trim().length > 0 &&
      (extra.announcementsRepo ?? '').trim().length > 0;

    expect(hasClient).toBe(hasRepository);
  });

  it('leaves the branch unset, or names one explicitly', () => {
    // Unset is normal and is NOT a defect: `src/config.ts` defaults it to
    // `main`, which is what the publish workflow triggers on. An empty string
    // is the defect — it reads as "configured to nothing", and `config.ts`
    // falls back to `main` only because it guards for exactly that.
    if (extra.announcementsBranch === undefined) return;
    expect(extra.announcementsBranch.trim().length).toBeGreaterThan(0);
  });

  it('carries no signing key', () => {
    // The same sweep `config.test.ts` runs over the resolved config, applied to
    // the artefact instead. A secret that arrived through a dependency or a
    // plugin would appear here and nowhere a review would look.
    const serialised = JSON.stringify(extra);
    expect(serialised).not.toContain('-----BEGIN');
    expect(serialised).not.toContain('announcement-signing');
  });
});
