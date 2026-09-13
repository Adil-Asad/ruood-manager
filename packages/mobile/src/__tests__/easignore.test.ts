/**
 * What reaches the EAS builder, and what must not.
 *
 * `.easignore` at the workspace root decides the upload, and it is worth a test
 * for the same reason `repository-separation.test.ts` is: nothing else fails
 * when it stops being true. An over-broad line here is a build that installs,
 * prebuilds, and only then says a module cannot be resolved — minutes in, in
 * the cloud, on the artefact you were about to ship.
 *
 * The rule it protects is one sentence: EAS runs `npm ci` at the workspace root
 * and bundles `packages/mobile`, so it needs every package MANIFEST, the
 * lockfile, and the SOURCE of the four packages the app imports. It needs none
 * of `node_modules/`, the generated Android project, or anything compiled.
 *
 * **`.easignore` REPLACES `.gitignore` for the upload**, which is the half that
 * surprises people: the obvious exclusions have to be restated here or they
 * stop applying, and the archive gets bigger rather than smaller.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..', '..');
const EASIGNORE = join(WORKSPACE_ROOT, '.easignore');

const patterns = readFileSync(EASIGNORE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

/**
 * Whether a path is excluded, by gitignore semantics as EAS applies them.
 *
 * Deliberately a small reimplementation rather than a dependency: what is being
 * checked is which of THESE lines match, and the alternative is adding a
 * package to the workspace to test a twelve-line file.
 */
function excluded(path: string): boolean {
  return patterns.some((raw) => {
    const anchored = raw.startsWith('/');
    const directoryOnly = raw.endsWith('/');
    const pattern = raw.replace(/^\//, '').replace(/\/$/, '');

    if (anchored || pattern.includes('/')) {
      return path === pattern || path.startsWith(`${pattern}/`);
    }

    // An unanchored pattern matches a segment at any depth — `node_modules/`
    // being the one that matters, since npm nests as well as hoists.
    return path
      .split('/')
      .some((segment) =>
        pattern.includes('*')
          ? new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(segment)
          : segment === pattern && !(directoryOnly && segment === path.split('/').pop()),
      );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('the EAS upload', () => {
  it('exists at the workspace root, which is what EAS archives', () => {
    // In a monorepo the archive is rooted at the repository, not at the Expo
    // project — so a `.easignore` inside `packages/mobile` would be read by
    // nobody.
    expect(existsSync(EASIGNORE)).toBe(true);
  });

  it.each([
    'node_modules/expo/package.json',
    'packages/mobile/node_modules/expo-router/entry.js',
    'packages/mobile/android/app/build/outputs/apk/release/app-release.apk',
    'packages/mobile/android/.gradle/8.0/checksums.bin',
    'packages/schema/dist/index.js',
    'packages/mobile/.expo/devices.json',
    'workspace/announcements/content/announcements/eid-hours.json',
    '.git/objects/ab/cdef',
  ])('leaves out %s', (path) => {
    expect(excluded(path)).toBe(true);
  });

  /**
   * Everything the build reads.
   *
   * The manifests are not optional extras: `npm ci` resolves the whole
   * workspace graph, so a missing `packages/core/package.json` fails the
   * install before anything is bundled — even though nothing in the app
   * imports `core`.
   */
  it.each([
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'packages/mobile/package.json',
    'packages/mobile/eas.json',
    'packages/mobile/app.config.ts',
    'packages/mobile/index.js',
    'packages/mobile/metro.config.js',
    'packages/mobile/babel.config.js',
    'packages/mobile/app/_layout.tsx',
    'packages/mobile/assets/icon.png',
    'packages/schema/package.json',
    'packages/schema/src/index.ts',
    'packages/schema/src/validate-record.ts',
    'packages/authoring/package.json',
    'packages/authoring/src/index.ts',
    'packages/client/package.json',
    'packages/client/src/index.ts',
    'packages/github/package.json',
    'packages/github/src/index.ts',
    'packages/core/package.json',
    'packages/cli/package.json',
  ])('keeps %s', (path) => {
    expect(excluded(path)).toBe(false);
    expect(existsSync(join(WORKSPACE_ROOT, path))).toBe(true);
  });

  it('keeps the source of every package Metro resolves to source', () => {
    // The two halves have to agree: `metro.config.js` maps these four to
    // `src/index.ts`, and an upload that dropped `src` would resolve to a file
    // that is not there.
    for (const name of ['schema', 'client', 'authoring', 'github']) {
      expect(excluded(`packages/${name}/src/index.ts`)).toBe(false);
    }
  });
});
