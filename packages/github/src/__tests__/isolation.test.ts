/**
 * The sweep that keeps this package runnable on a phone.
 *
 * This one guards the package most likely to forget: it speaks HTTP, and every
 * convenient way to speak HTTP in node — `node:https`, a `Buffer` body, a
 * `URLSearchParams` — is unavailable or untyped in Hermes. `URLSearchParams`
 * has already been removed once for exactly that reason.
 *
 * The transport is injected instead (`Http` from `@ruood/announcement-client`),
 * so this package can be tested against a scripted GitHub with no network at
 * all — which is why the suite beside this one runs in a second.
 */


import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = join(__dirname, '..');

/**
 * Identifiers that must never appear.
 *
 * Whole-word matches, so `readFileSync` is caught while a comment mentioning
 * "the filesystem" is not.
 */
const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /\bfrom ['"]node:/, why: 'a node builtin — this runs in Hermes too' },
  { pattern: /\brequire\(['"]node:/, why: 'a node builtin — this runs in Hermes too' },
  { pattern: /\bfrom ['"](fs|path|os|crypto|http|https)['"]/, why: 'a node builtin' },
  { pattern: /\bBuffer\b/, why: 'Buffer does not exist in Hermes or in a browser' },
  { pattern: /\bprocess\.(env|cwd|platform)\b/, why: 'there is no process on a device' },
  { pattern: /\bdocument\b/, why: 'there is no DOM in React Native' },
  { pattern: /\bwindow\./, why: 'there is no window in React Native' },
  { pattern: /\bfrom ['"]react/, why: 'this package is UI-framework-neutral' },
  {
    pattern: /\bfrom ['"]@ruood\/announcement-core['"]/,
    why: 'core reaches for fs, sharp and git — this package is what was pulled OUT of it',
  },
  // `@ruood/announcement-client` is deliberately NOT banned here. This package
  // sits above it and imports its `Http` port and its base64 codec — which is
  // the whole reason the transport can be injected and the suite beside this
  // one needs no network.
];

/**
 * `Date.now()` is banned separately, because it is the one that looks harmless.
 *
 * Every function here takes `now`. A rule that read the clock itself could not
 * be pinned to a fixed instant, and a lifecycle transition that cannot be
 * pinned cannot be tested — the same discipline the schema package keeps.
 */
const CLOCK = /\bDate\.now\(\)/;

/**
 * Comments are removed before anything is matched.
 *
 * Without this the sweep catches its own documentation: `index.ts` explains
 * that `Buffer` and `Date.now()` are banned, and naming them is not using
 * them. Stripping first makes the test assert what it means — that no CODE
 * reaches for a platform — rather than that nobody writes the words down,
 * which would quietly discourage the comments most worth having.
 */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sources(): { name: string; body: string }[] {
  return readdirSync(SOURCE, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      name: entry.name,
      body: stripComments(readFileSync(join(SOURCE, entry.name), 'utf8')),
    }));
}

describe('the github package stays platform-neutral', () => {
  it('has sources to sweep', () => {
    // A sweep over an empty directory passes vacuously, which is the one way
    // this test could stop protecting anything without failing.
    expect(sources().length).toBeGreaterThanOrEqual(3);
  });

  it.each(BANNED)('never uses $why', ({ pattern }) => {
    const offenders = sources()
      .filter((file) => pattern.test(file.body))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it('never reads the clock — `now` is always injected', () => {
    const offenders = sources()
      .filter((file) => CLOCK.test(file.body))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it('never reaches for a global that Hermes types differently', () => {
    // `URLSearchParams` was here once and cost a build. It exists at runtime on
    // every target, and it is typed by neither `DOM` nor `@types/node` in this
    // package's compilation — so it fails at BUILD time, which is the good
    // direction, but only if nobody adds it back with a cast.
    const offenders = sources()
      .filter((file) => /new URLSearchParams|TextEncoder|atob\(|btoa\(/.test(file.body))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it('depends on the schema, the client and nothing else', () => {
    const imports = sources()
      .flatMap((file) => [...file.body.matchAll(/from ['"]([^'".][^'"]*)['"]/g)])
      .map((match) => match[1]!);

    // Relative imports are excluded by the pattern above, so what is left is
    // every package this one reaches for. There should be exactly one.
    expect([...new Set(imports)].sort()).toEqual([
      '@ruood/announcement-authoring',
      '@ruood/announcement-client',
      '@ruood/announcement-schema',
    ]);
  });
});
