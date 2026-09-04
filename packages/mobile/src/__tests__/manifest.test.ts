/**
 * The generated `AndroidManifest.xml` — the ground truth about permissions.
 *
 * Neither `app.config.ts` nor `expo config` tells you what a build will
 * actually ask for. The config lists what plugins *declared*; only the prebuilt
 * manifest shows what survived, and only it carries the `tools:node="remove"`
 * markers that `blockedPermissions` produces for the manifest merger.
 *
 * That gap is not academic: `permissions: []` in the config coexisted happily
 * with `RECORD_AUDIO` in the manifest, and nothing but reading this file would
 * have shown it.
 *
 * Runs against `android/`, produced by:
 *
 *     npm run prebuild -w @ruood/announcement-manager-android
 *
 * and SKIPS when that has not been run, because `android/` is gitignored and
 * regenerated — a test that failed on a fresh clone would teach people to
 * ignore it. It says loudly that it skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MOBILE = join(__dirname, '..', '..');

/**
 * The MERGED manifest first, then the prebuild source as a fallback.
 *
 * This distinction cost a real miss. The prebuild source manifest holds what
 * `app.config.ts` and its config plugins declared; it does NOT hold what the
 * dependencies' own manifests contribute. `expo-image-picker` declares
 * `CAMERA` in its library manifest, so the source manifest looked clean while
 * the installed APK asked for the camera — found only by dumping the
 * permissions of the app on a real device.
 *
 * The merged manifest is what the manifest merger actually produced, library
 * contributions and `tools:node="remove"` resolutions included. It is the only
 * file that answers "what will this build ask for".
 *
 * Produce it with:
 *
 *     cd packages/mobile/android && ./gradlew processDebugMainManifest
 */
function manifestPath(): { path: string; merged: boolean; variant: string } | null {
  const mergedFor = (variant: 'release' | 'debug'): string =>
    join(
      MOBILE,
      'android',
      'app',
      'build',
      'intermediates',
      'merged_manifest',
      variant,
      `process${variant === 'release' ? 'Release' : 'Debug'}MainManifest`,
      'AndroidManifest.xml',
    );

  // RELEASE first: that is what Google Play reads and what a user is shown on
  // the listing. The debug variant legitimately carries SYSTEM_ALERT_WINDOW,
  // added by `app/src/debug/AndroidManifest.xml` for React Native's dev
  // overlay, so asserting the shipping permission set against it would fail
  // for a reason that does not matter.
  for (const variant of ['release', 'debug'] as const) {
    const path = mergedFor(variant);
    if (existsSync(path)) return { path, merged: true, variant };
  }

  const source = join(MOBILE, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (existsSync(source)) return { path: source, merged: false, variant: 'source' };

  return null;
}

const located = manifestPath();
const MANIFEST = located?.path ?? '';
const isMerged = located?.merged ?? false;
const isRelease = located?.variant === 'release';

const found = located !== null;
const manifest = found ? readFileSync(MANIFEST, 'utf8') : '';

const describeManifest = found ? describe : describe.skip;

if (!found) {

  console.warn(
    '\n  SKIPPED: the AndroidManifest permission check.\n' +
      '  Generate it first:  npm run prebuild -w @ruood/announcement-manager-android\n',
  );
}

/** Every permission in the manifest, and whether it is marked for removal. */
function permissions(): { name: string; removed: boolean }[] {
  const matches = manifest.matchAll(
    /<uses-permission\s+android:name="([^"]+)"([^/>]*)\/?>/g,
  );

  return [...matches].map((match) => ({
    name: match[1]!,
    removed: (match[2] ?? '').includes('tools:node="remove"'),
  }));
}

describeManifest('the generated AndroidManifest', () => {
  it('is the real thing', () => {
    expect(manifest).toContain('<manifest');
    expect(permissions().length).toBeGreaterThan(0);
  });

  it('is a merged manifest, not the prebuild source', () => {
    // Said out loud, because the difference is what this file exists for and a
    // silent fallback to the weaker check is the way that gets lost.
    expect(isMerged).toBe(true);

    if (!isRelease) {
      console.warn(
        '\n  NOTE: checking the DEBUG merged manifest. The set Google Play reads is\n' +
          '  the release one:  cd packages/mobile/android && ./gradlew processReleaseMainManifest\n',
      );
    }
  });

  it.each([
    ['the microphone', 'android.permission.RECORD_AUDIO'],
    ['writing to shared storage', 'android.permission.WRITE_EXTERNAL_STORAGE'],
    ['the camera', 'android.permission.CAMERA'],
    ['drawing over other apps', 'android.permission.SYSTEM_ALERT_WINDOW'],
  ])('strips %s at merge time', (_what, name) => {
    // SYSTEM_ALERT_WINDOW is genuinely present in a DEBUG build: the debug
    // source set adds it for React Native's dev overlay, and blockedPermissions
    // does not reach a variant source set. It is absent from release, which is
    // the build this rule is about.
    if (!isRelease && name === 'android.permission.SYSTEM_ALERT_WINDOW') return;

    const entry = permissions().find((permission) => permission.name === name);

    // Either absent entirely, or present and marked for removal. Both mean it
    // is not in the shipped APK; present-and-unmarked is the failure.
    expect(entry?.removed ?? true).toBe(true);
  });

  it('keeps only permissions that are actually used', () => {
    const kept = permissions()
      .filter((permission) => !permission.removed)
      .map((permission) => permission.name)
      // The app's own signature-level permission, generated by AndroidX for
      // its non-exported dynamic receivers. It grants nothing to anyone else.
      .filter((name) => !name.endsWith('DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'))
      .sort();

    // INTERNET               talking to the Manager, which is the whole app.
    // READ_EXTERNAL_STORAGE  picking an image on Android below 13, where the
    //                        photo picker cannot read the chosen file without it.
    // VIBRATE                React Native core. `normal`, no prompt.
    // USE_BIOMETRIC /
    // USE_FINGERPRINT        expo-secure-store, which holds the session token.
    //                        Kept deliberately — see app.config.ts.
    // ACCESS_NETWORK_STATE   expo-image, added in Phase 7 to render the image
    //                        preview. It is what makes an ANIMATED preview move
    //                        at all — React Native's own Image draws frame one
    //                        — so an administrator can see that the GIF they
    //                        picked is animated before it reaches a user's
    //                        phone. `normal` tier: granted at install, no
    //                        prompt, and not shown prominently on a listing.
    //
    // `SYSTEM_ALERT_WINDOW` used to be here and is not any more: it arrived
    // with `expo-dev-client`, which was removed.
    //
    // Anything else appearing here arrived with a dependency and needs a
    // DECISION, not a passing test. This assertion caught ACCESS_NETWORK_STATE
    // arriving, which is exactly what it is for — the entry above is the
    // decision, written down.
    const expected = [
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.INTERNET',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      'android.permission.VIBRATE',
    ];

    // Strict only against the RELEASE merged manifest, which is the set Google
    // Play reads. The debug variant adds SYSTEM_ALERT_WINDOW from its own
    // source set, and the prebuild source manifest is missing every library
    // contribution — asserting the exact set against either would fail for a
    // reason that is not a real finding.
    if (isRelease) {
      expect(kept).toEqual(expected);
    } else {
      expect(kept.filter((name) => !expected.includes(name))).toEqual(
        isMerged ? ['android.permission.SYSTEM_ALERT_WINDOW'] : [],
      );
    }
  });

  it('asks for no location, contacts, camera or SMS permission', () => {
    // None of these can ever be justified by an announcement authoring tool,
    // so they are named rather than left to the list above to catch.
    const kept = permissions().filter((permission) => !permission.removed);

    for (const forbidden of [
      'LOCATION',
      'CONTACTS',
      'CAMERA',
      'RECORD_AUDIO',
      'SMS',
      'CALL_',
      'READ_PHONE',
    ]) {
      expect(kept.filter((permission) => permission.name.includes(forbidden))).toEqual([]);
    }
  });

  it('refuses cleartext traffic', () => {
    // This used to assert the OPPOSITE. Cleartext was on because the app spoke
    // plain HTTP to a Manager server on a private network; Phase 8 deleted that
    // server, and everything the app talks to now is api.github.com over TLS.
    //
    // Asserting `false` rather than simply dropping the check is the point:
    // re-enabling cleartext would be a silent, invisible security regression —
    // nothing about the app would look different, and every request would
    // become readable by anyone on the network.
    expect(manifest).toContain('usesCleartextTraffic="false"');
    expect(manifest).not.toContain('usesCleartextTraffic="true"');
  });
});
