/**
 * What may and may not reach an Android build.
 *
 * `app.config.ts` produces the object that is compiled into the APK and the
 * AAB. Everything in it is readable by anyone who unzips the artefact, so the
 * question these tests ask is not "is the config right" but "could a secret
 * ever get in here without anyone noticing".
 *
 * It is asserted rather than reviewed because a secret added to `extra` is
 * invisible in a diff that also adds a plausible-looking feature, and permanent
 * once a build carrying it has been published to anyone.
 *
 * The specific things being kept out:
 *
 *   the RUOOD announcement signing key   Ed25519 private key, key id 2bc1e956.
 *                                        Lives at ~/.ruood/announcement-signing.key
 *                                        on the operator's machine. Signing
 *                                        happens in the Manager process; this
 *                                        app asks it to, and cannot sign.
 *   the Manager bearer token             entered once on Connect, stored in the
 *                                        Android keystore. Never compiled in.
 *   any GitHub credential                the app never talks to GitHub at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import configure from '../../app.config';
import { GITHUB_TOKEN_KEY } from '../storage-keys';

/** The config as a named variant would build it. */
function build(variant: 'development' | 'preview' | 'production') {
  const previous = process.env.APP_VARIANT;
  process.env.APP_VARIANT = variant;

  // `app.config.ts` reads the variant at module scope, so it is re-imported
  // rather than merely re-called — otherwise every variant is the first one.
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-imported after resetModules so the variant is re-read at module scope
  const fresh = require('../../app.config').default as typeof configure;
  const result = fresh({ config: {} } as never);

  if (previous === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = previous;

  return result;
}

/** Every string anywhere in the config, flattened, so nothing hides in a nest. */
function everyString(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const entry of value) everyString(entry, found);
  else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) everyString(entry, found);
  }
  return found;
}

describe('the Android build carries no secret', () => {
  const config = build('production');
  const strings = everyString(config);
  const serialised = JSON.stringify(config);

  it.each([
    ['a PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['a GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/],
    ['a fine-grained GitHub token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
    ['the signing key path', /announcement-signing\.key/],
    ['a bearer token', /\bBearer\s+\S+/i],
  ])('has no %s anywhere in it', (_what, pattern) => {
    expect(serialised).not.toMatch(pattern);
  });

  it('has no 32+ character opaque literal that could be a credential', () => {
    // Everything legitimately in this config is a name, a path, a colour, a
    // package id or a sentence. A long unbroken run of base64-ish characters is
    // not any of those.
    //
    // With ONE exception, and it is named rather than pattern-matched: the EAS
    // project id. It is a UUID that says which project a build uploads into,
    // the account that owns it is what authorises anything, and it is written
    // into the config precisely so nobody runs `eas init` at the workspace root
    // again. Excusing the exact value keeps every OTHER long literal failing.
    const projectId = (config.extra?.eas as { projectId?: string } | undefined)?.projectId;
    expect(projectId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

    const suspects = strings
      .filter((value) => value !== projectId)
      .filter((value) => /^[A-Za-z0-9+/_=-]{32,}$/.test(value));
    expect(suspects).toEqual([]);
  });

  it('exposes only the build variant and the GitHub coordinates through `extra`', () => {
    // `extra` is the field most likely to grow a secret, because it is where
    // "just one value the app needs" goes. Today it holds a label, the router's
    // own empty object, and — when the build was given one — the address of the
    // Manager, plus `eas` once `eas init` has written a project id.
    //
    // `managerUrl` is WHERE the Manager is, which is not a credential and
    // grants nothing: the server refuses every request that does not carry a
    // valid one, and on a wide bind refuses anonymous requests outright. It is
    // listed explicitly rather than allowed by a pattern, so a fourth key
    // arriving is still a failing test.
    const keys = Object.keys(config.extra ?? {}).sort();
    const allowed = [
      'appVariant',
      'announcementsBranch',
      'announcementsOwner',
      'announcementsRepo',
      'githubClientId',
      'router',
    ];

    expect(keys.filter((key) => key !== 'eas').every((key) => allowed.includes(key))).toBe(true);
    expect(config.extra?.appVariant).toBe('production');
  });

  it('carries no GitHub configuration unless the build was given some', () => {
    // The suite runs with none of those variables set, so the keys must be
    // ABSENT rather than empty — the same reasoning as `eas.projectId`: an
    // empty string reads as something configured to nothing, which is a worse
    // thing to debug than a missing key.
    expect(config.extra?.githubClientId).toBeUndefined();
    expect(config.extra?.announcementsOwner).toBeUndefined();
  });

  it('never reads a signing-related environment variable', () => {
    // A config that read one would compile whatever it found into the binary.
    const source = readFileSync(join(__dirname, '..', '..', 'app.config.ts'), 'utf8');
    // Deduplicated: the question is WHICH variables are read, not how many
    // times each is mentioned.
    const envReads = [...new Set(source.match(/process\.env\.[A-Z_]+/g) ?? [])].sort();

    // None of these is a credential:
    //
    //   APP_VARIANT          which build this is.
    //   EAS_PROJECT_ID       an account-scoped identifier.
    //   GITHUB_CLIENT_ID     a DEVICE-FLOW client id. The device flow exists
    //                        because a public client cannot keep a secret, so
    //                        there is no client secret and none to extract.
    //   ANNOUNCEMENTS_*      where a public repository lives.
    //
    // The list stays exhaustive so a genuinely secret name arriving here fails
    // rather than blending in.
    expect(envReads).toEqual([
      'process.env.ANNOUNCEMENTS_BRANCH',
      'process.env.ANNOUNCEMENTS_OWNER',
      'process.env.ANNOUNCEMENTS_REPO',
      'process.env.APP_VARIANT',
      'process.env.EAS_PROJECT_ID',
      'process.env.GITHUB_CLIENT_ID',
    ]);

    // And none of them is the one that must never be read.
    expect(source).not.toMatch(/process\.env\.[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/);
  });
});

describe('the three build variants', () => {
  const variants = ['development', 'preview', 'production'] as const;

  it('give each variant its own application id, so they install side by side', () => {
    const ids = variants.map((variant) => build(variant).android?.package);

    expect(ids).toEqual([
      'com.ruood.announcementmanager.dev',
      'com.ruood.announcementmanager.preview',
      'com.ruood.announcementmanager',
    ]);
    // Distinct, or a preview build replaces the production one on the device
    // and "I tested it on the wrong app" becomes possible.
    expect(new Set(ids).size).toBe(3);
  });

  it('names them differently on the launcher for the same reason', () => {
    const names = variants.map((variant) => build(variant).name);
    expect(new Set(names).size).toBe(3);
    expect(build('production').name).toBe('RUOOD Announcements');
  });

  it('keeps the production application id free of any suffix', () => {
    // The id is permanent once published to Play. A `.production` on the end
    // would be permanent too.
    expect(build('production').android?.package).toBe('com.ruood.announcementmanager');
  });

  it('defaults to production when no variant is set', () => {
    // The safe default: a build with a forgotten env var is the real app with
    // the real id, not a preview that quietly takes the production slot.
    const previous = process.env.APP_VARIANT;
    delete process.env.APP_VARIANT;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-imported after resetModules so the variant is re-read at module scope
    const fresh = require('../../app.config').default as typeof configure;
    expect(fresh({ config: {} } as never).android?.package).toBe('com.ruood.announcementmanager');
    if (previous !== undefined) process.env.APP_VARIANT = previous;
  });
});

/**
 * Permissions the build is told to strip.
 *
 * `permissions: []` in the config is worth nothing on its own: a config plugin
 * merges INTO the manifest and is not filtered by that list. `expo-image-picker`
 * adds `RECORD_AUDIO` and `WRITE_EXTERNAL_STORAGE`, and React Native core adds
 * `SYSTEM_ALERT_WINDOW`, none of which the source file hints at.
 *
 * `blockedPermissions` is what actually removes them, and this asserts that the
 * list is intact. `manifest.test.ts` then checks the generated manifest, which
 * is the ground truth.
 */
/**
 * The platform list, which was a real bug.
 *
 * Expo's default is `['ios', 'android', 'web']`. Leaving it there meant that
 * pressing `w` in `expo start` — or Expo reaching for web when no device was
 * attached — tried to bundle a platform this app has no dependencies for, and
 * failed with a wall of "Unable to resolve react-native-web/..." that named
 * every file except the one that was wrong.
 *
 * The fix was to close the list, not to install `react-native-web`: the bearer
 * token lives in the Android keystore through `expo-secure-store`, and on web
 * that degrades to `localStorage`, readable by any script on the page. A web
 * build would be a worse-secured copy of a tool that already has a browser
 * front end — served by the very process this app talks to.
 */
describe('the platform list', () => {
  it('is Android only', () => {
    expect(build('production').platforms).toEqual(['android']);
  });

  it('does not include web, whatever else changes', () => {
    // Named separately because this is the one that produced the failure, and
    // because "someone added web back" is a likelier future than "someone
    // reordered the array".
    for (const variant of ['development', 'preview', 'production'] as const) {
      expect(build(variant).platforms).not.toContain('web');
    }
  });

  it('has no react-native-web dependency to make a web build possible', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

    expect(manifest.dependencies['react-native-web']).toBeUndefined();
    expect(manifest.devDependencies['react-native-web']).toBeUndefined();
  });
});

describe('Android permissions', () => {
  const android = build('production').android;

  it('declares no permission of its own', () => {
    expect(android?.permissions).toEqual([]);
  });

  it.each([
    ['the microphone', 'android.permission.RECORD_AUDIO'],
    ['writing to shared storage', 'android.permission.WRITE_EXTERNAL_STORAGE'],
    ['drawing over other apps', 'android.permission.SYSTEM_ALERT_WINDOW'],
  ])('blocks %s, which a library adds unasked', (_what, permission) => {
    expect(android?.blockedPermissions).toContain(permission);
  });

  it('does NOT block reading storage, which image picking needs on older Android', () => {
    // Blocking it would trade a real capability — attaching an image on a
    // device below Android 13 — for a line on a listing.
    expect(android?.blockedPermissions ?? []).not.toContain(
      'android.permission.READ_EXTERNAL_STORAGE',
    );
  });
});

describe('the storage keys', () => {
  it('uses only characters SecureStore accepts', () => {
    // SecureStore rejects anything outside this set at runtime, on the single
    // call that stores the credential — the worst place to find out.
    expect(GITHUB_TOKEN_KEY).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('names the credential for what it is', () => {
    // There is exactly one secret on the device now. Naming it after GitHub is
    // what stops anyone reading a keystore dump and assuming it is the
    // announcement signing key — which has never been on a phone.
    expect(GITHUB_TOKEN_KEY).toContain('github');
  });
});

/**
 * What a CLOUD build is given, which is not what a local one is given.
 *
 * A local build reads `app.config.ts` in a shell the operator exported
 * variables into, so `GITHUB_CLIENT_ID=... npx expo ...` reaches it. **An EAS
 * build does not.** The config is evaluated on the builder, in a process that
 * never saw that shell, and the only environment it has is the one `eas.json`
 * declares for the profile.
 *
 * The cost of getting that wrong is an APK that installs, opens, and says "This
 * app has not been set up" — and cannot be rescued from Advanced either, since
 * the repository is compiled in and deliberately not overridable. It is the
 * kind of failure that is only visible on a device, after a full cloud build.
 *
 * None of these three is a secret, which is why they can live in a file in the
 * repository at all: a device-flow client id has no client secret (that is the
 * whole reason the device flow is usable from an APK), and `owner/repo` is
 * where a PUBLIC repository lives. The signing key is not here and never will
 * be — it is a secret of the publishing workflow.
 */
describe('every EAS build profile is given what the app needs', () => {
  const easJson = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'eas.json'), 'utf8'),
  ) as { build: Record<string, { env?: Record<string, string> }> };

  const profiles = Object.entries(easJson.build);

  it('has the three profiles this project builds', () => {
    expect(profiles.map(([name]) => name).sort()).toEqual([
      'development',
      'preview',
      'production',
    ]);
  });

  it.each(['GITHUB_CLIENT_ID', 'ANNOUNCEMENTS_OWNER', 'ANNOUNCEMENTS_REPO'])(
    'passes %s to every profile',
    (variable) => {
      for (const [name, profile] of profiles) {
        expect(`${name}: ${profile.env?.[variable] ?? ''}`).not.toBe(`${name}: `);
      }
    },
  );

  it('gives each profile its own APP_VARIANT, matching its name', () => {
    // The build variant decides the application id and the launcher name, so a
    // profile carrying the wrong one installs over another build.
    for (const [name, profile] of profiles) {
      expect(profile.env?.APP_VARIANT).toBe(name);
    }
  });

  it('declares nothing that looks like a credential', () => {
    // `eas.json` is committed, so it is the one place build configuration could
    // quietly become a place to put a secret.
    for (const [, profile] of profiles) {
      for (const key of Object.keys(profile.env ?? {})) {
        expect(key).not.toMatch(/(KEY|SECRET|TOKEN|PASSWORD)$/);
      }
    }
  });
});
