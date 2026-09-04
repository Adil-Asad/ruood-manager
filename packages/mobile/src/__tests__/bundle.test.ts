/**
 * What is in the artefact that actually ships.
 *
 * `config.test.ts` asserts about the configuration. This asserts about the
 * **bundle** — the Hermes bytecode Metro produced — because a secret does not
 * have to come through `app.config.ts` to end up in a build. It could come
 * through an import, a constant someone inlined "just for testing", or a
 * dependency. The only way to be sure is to look at the output.
 *
 * It prefers the bundle Gradle produced for a RELEASE build:
 *
 *     packages/mobile/android/app/build/generated/assets/
 *       createBundleReleaseJsAndAssets/index.android.bundle
 *
 * because that is literally the JavaScript packaged into the APK and the AAB —
 * not an approximation of it. It falls back to `expo export` output if that is
 * what happens to be present.
 *
 * Produce it with either of:
 *
 *     cd packages/mobile/android && ./gradlew createBundleReleaseJsAndAssets
 *     npx eas build --profile preview --platform android
 *
 * and it SKIPS when neither has been run, rather than failing. A test that
 * fails because an optional build step was skipped teaches people to ignore it,
 * and an ignored security test is worse than none. It is loud about the skip so
 * it is visible in the output.
 *
 * A bundle carries its string table whether it is plain JavaScript or Hermes
 * bytecode, so a literal compiled into the app is findable in it — which is
 * what makes this test meaningful and, incidentally, the reason a secret in a
 * bundle is not hidden from anyone who downloads the APK either.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MOBILE = join(__dirname, '..', '..');

/** The release bundle Gradle embeds, then anything `expo export` left behind. */
function bundlePath(): string | null {
  const shipped = join(
    MOBILE,
    'android',
    'app',
    'build',
    'generated',
    'assets',
    'createBundleReleaseJsAndAssets',
    'index.android.bundle',
  );
  if (existsSync(shipped)) return shipped;

  const exported = join(MOBILE, 'dist', '_expo', 'static', 'js', 'android');
  if (!existsSync(exported)) return null;

  const file = readdirSync(exported).find(
    (name) => name.endsWith('.hbc') || name.endsWith('.js'),
  );
  return file ? join(exported, file) : null;
}

const found = bundlePath();

// `latin1` rather than `utf8`: the file is bytecode, and decoding it as UTF-8
// replaces invalid sequences, which could silently destroy the very literal
// being searched for. latin1 is a byte-for-byte mapping.
const bundle = found ? readFileSync(found, 'latin1') : '';

const describeBundle = found ? describe : describe.skip;

if (!found) {
  console.warn(
    '\n  SKIPPED: the Android bundle secret sweep.\n' +
      '  Build the shipping bundle first:\n' +
      '    cd packages/mobile/android && ./gradlew createBundleReleaseJsAndAssets\n',
  );
}

describeBundle('the exported Android bundle', () => {
  it('is big enough to be the real bundle', () => {
    // A guard on the guard. If this ever shrinks to nothing, every assertion
    // below would pass vacuously and report a clean sweep of an empty file.
    expect(bundle.length).toBeGreaterThan(500_000);
  });

  it('contains the schema validator, so the app runs the real one', () => {
    // Not a security assertion — a correctness one, and it belongs here because
    // it proves the same thing the sweep relies on: that literals from the
    // aliased source packages really do land in this file, so their absence
    // below means something.
    for (const literal of ['minSchema', 'maxImpressions', 'snooze-24h', 'next-launch']) {
      expect(bundle).toContain(literal);
    }
  });

  it.each([
    ['a PEM private key', '-----BEGIN'],
    ['the signing key filename', 'announcement-signing.key'],
    ['the signing key directory', '.ruood/announcement-signing'],
    ['a classic GitHub token prefix', 'ghp_'],
    ['a fine-grained GitHub token prefix', 'github_pat_'],
  ])('carries no %s', (_what, literal) => {
    expect(bundle).not.toContain(literal);
  });

  it('carries no Ed25519 public key literal either', () => {
    // The PUBLIC key is not a secret and pinning it in RUOOD Lab is correct.
    // It has no business in the MANAGER, though: this app never verifies a
    // manifest, so a key here would mean something is doing crypto that should
    // not be, on a device that should not have it.
    expect(bundle).not.toContain('ADPY+qUfp7Gn9r5nHWVbXkwH2pqW0RF2JlZWrTjsEfU=');
  });

  /**
   * Exactly one React.
   *
   * This is a crash regression, not a tidiness rule. Two Reacts in one bundle
   * produced, on a real device and only in a release build:
   *
   *     TypeError: Cannot read property 'useRef' of null
   *       at useNavigationContainerRef / ContextNavigator / ExpoRoot
   *
   * The workspace held React 19 for this app and React 18 as a transitive peer
   * of the desktop Manager's browser client. npm hoisted
   * `@react-navigation/core` to the repository ROOT, where it resolved React
   * from the root `node_modules` — so the navigation stack bound to React 18
   * while everything else bound to 19, and its hooks dispatcher was null.
   *
   * Nothing else catches it. It typechecks, it lints, it bundles, `expo-doctor`
   * reports it only as a "duplicate dependency" warning that looks cosmetic,
   * and the app dies on launch. The fix is `overrides` in the root
   * `package.json`; this is what proves the fix is still in place.
   */
  it('contains exactly one React', () => {
    const versions = [...new Set(bundle.match(/\b1[89]\.\d+\.\d+\b/g) ?? [])]
      .filter((version) => version.startsWith('18.') || version.startsWith('19.'))
      .sort();

    // React 18 must not appear at all — its presence is the bug.
    expect(versions.filter((version) => version.startsWith('18.'))).toEqual([]);
  });

  it('carries no hardcoded server address', () => {
    // The address is paired in at runtime. One compiled in would mean a build
    // that talks to a machine the operator did not choose — and it would be
    // the single most misleading literal in the file.
    //
    // The Connect screen's placeholder is the one address in here, and it is
    // deliberately in 192.0.2.0/24 — RFC 5737 TEST-NET-1, reserved for
    // documentation and guaranteed not to route. So it is allowed by name, and
    // anything else that looks like an endpoint still fails.
    const addresses = bundle.match(/https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g) ?? [];
    const routable = addresses.filter((address) => !address.includes('://192.0.2.'));

    expect(routable).toEqual([]);
  });
});
