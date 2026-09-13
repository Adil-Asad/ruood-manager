/**
 * The shared packages resolve to SOURCE, and the bundle needs no prior build.
 *
 * This is the invariant the whole "one validator, two consumers" arrangement
 * rests on: the phone runs the same `@ruood/announcement-schema` and
 * `@ruood/announcement-authoring` the publishing build reads records back with,
 * not a compiled copy that can be stale or absent.
 *
 * It is tested here because the one place it actually failed could not be seen
 * from a bundle. `metro.config.js` expressed the alias as
 * `resolver.extraNodeModules`, which reads like an alias and is a FALLBACK:
 * metro-resolver concatenates those paths onto the END of the candidate list,
 * for a package that could not be found at all. npm workspaces symlink every
 * one of these into the root `node_modules`, so each was always found, and the
 * alias was never consulted.
 *
 * On a development machine that was invisible — `dist/` exists there, so
 * resolution succeeded one step earlier and the bundle was correct anyway. On
 * EAS it was fatal: `dist/` is gitignored, nothing in a managed build runs this
 * repository's build script, and Metro threw `InvalidPackageError` on the
 * `main` it could not resolve.
 *
 * `bundle.test.ts` could not catch it either: `dist` carries the same string
 * literals as `src`, so a bundle built from either passes that sweep. The only
 * thing that distinguishes them is which FILE Metro resolves to, which is what
 * this asserts.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const metroConfig = require('../../metro.config.js') as {
  resolver: {
    resolveRequest?: (context: unknown, moduleName: string, platform: string | null) => unknown;
    extraNodeModules?: Record<string, string>;
  };
};

const SHARED = [
  '@ruood/announcement-schema',
  '@ruood/announcement-client',
  '@ruood/announcement-authoring',
  '@ruood/announcement-github',
] as const;

/** What the config resolves a bare package name to, with no fallback available. */
function resolved(moduleName: string): { type?: string; filePath?: string } | undefined {
  const resolveRequest = metroConfig.resolver.resolveRequest;
  if (!resolveRequest) return undefined;

  // A context whose own `resolveRequest` throws: reaching it means the mapping
  // did NOT answer, which on EAS is the failure this file is about.
  const context = {
    resolveRequest: () => {
      throw new Error('fell through to the default resolver');
    },
  };

  return resolveRequest(context, moduleName, 'android') as { type?: string; filePath?: string };
}

describe('the shared packages resolve to source', () => {
  it.each(SHARED)('%s maps to its own src/index.ts', (name) => {
    const result = resolved(name);

    expect(result?.type).toBe('sourceFile');
    expect(result?.filePath?.replace(/\\/g, '/')).toMatch(
      new RegExp(`/packages/[a-z]+/src/index\\.ts$`),
    );
    // The file has to be there: a mapping to a path that does not exist fails
    // at bundle time, on EAS, in the artefact you were about to ship.
    expect(existsSync(result!.filePath!)).toBe(true);
  });

  it('resolves without any package having been built', () => {
    // The mapping names a `.ts` under `src`, so no step of `npm run build` is on
    // the bundle's path. This is the property EAS depends on: a managed build
    // installs dependencies and bundles, and never compiles this workspace.
    for (const name of SHARED) {
      const filePath = resolved(name)?.filePath?.replace(/\\/g, '/') ?? '';
      expect(filePath).not.toContain('/dist/');
    }
  });

  it('does not rely on extraNodeModules, which is only a fallback', () => {
    // Metro concatenates those onto the end of the candidate list, after every
    // node_modules path. With the workspace symlinks in place they are dead
    // entries, and leaving them here would suggest the alias lives in two
    // places when only one of them is ever consulted.
    const extra = metroConfig.resolver.extraNodeModules ?? {};
    for (const name of SHARED) expect(extra[name]).toBeUndefined();
  });

  it('every mapped source entry is a real file in this workspace', () => {
    // Guards a rename: moving `packages/authoring/src/index.ts` would otherwise
    // be found by the next EAS build rather than by this run.
    for (const name of SHARED) {
      const packageDir = name.replace('@ruood/announcement-', '');
      const expected = resolve(__dirname, '..', '..', '..', packageDir, 'src', 'index.ts');
      expect(existsSync(expected)).toBe(true);
    }
  });
});
