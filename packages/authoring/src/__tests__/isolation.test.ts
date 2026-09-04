/**
 * The sweep that keeps this package runnable on a phone.
 *
 * `packages/schema` has one of these and it is the reason "one validator, two
 * consumers" is true rather than aspirational. `packages/client` has one for
 * the same reason. This package needs it most of all, because of where it came
 * from: these three files lived inside `@ruood/announcement-core` — beside
 * `node:fs`, `simple-git` and `sharp` — and the only thing that made extracting
 * them possible was that they had stayed pure by habit.
 *
 * Habit is not a guarantee. A single `readFileSync` added here compiles, passes
 * every other test under a node jest config, and then throws on a phone the
 * first time somebody opens the editor — with a red box that names a bundler
 * module and not this package.
 *
 * The rule this protects is the one that made the extraction worth doing: the
 * phone and the build must run the SAME code for what an edit means. That stops
 * being true the moment one of them cannot import it.
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
  {
    pattern: /\bfrom ['"]@ruood\/announcement-client['"]/,
    why: 'the wire contract is a layer above this one; depending upward is a cycle',
  },
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

describe('the authoring package stays platform-neutral', () => {
  it('has sources to sweep', () => {
    // A sweep over an empty directory passes vacuously, which is the one way
    // this test could stop protecting anything without failing.
    expect(sources().length).toBeGreaterThanOrEqual(4);
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

  it('depends on the schema and on nothing else', () => {
    const imports = sources()
      .flatMap((file) => [...file.body.matchAll(/from ['"]([^'".][^'"]*)['"]/g)])
      .map((match) => match[1]!);

    // Relative imports are excluded by the pattern above, so what is left is
    // every package this one reaches for. There should be exactly one.
    expect([...new Set(imports)]).toEqual(['@ruood/announcement-schema']);
  });
});
