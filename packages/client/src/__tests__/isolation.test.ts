/**
 * The sweep that keeps this package runnable in three places.
 *
 * `packages/schema` has one of these and it is the reason "one validator, two
 * consumers" is true rather than aspirational. This package has the same job
 * and the same exposure: it backs the browser client, the Android Manager and
 * a node test, and the only thing stopping a `document` reference from being
 * added is that this test fails when one is.
 *
 * The failure it prevents is quiet. A `Buffer` here compiles, passes every
 * other test under a node jest config, and then throws on a phone the first
 * time the screen that uses it is opened — in front of the operator, with a
 * red box and no clue that a shared package was the cause.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = join(__dirname, '..');

/**
 * Identifiers that must never appear.
 *
 * Each is a whole-word match, so `readFileSync` is caught while a comment
 * mentioning "the filesystem" is not, and a variable called `documentation`
 * does not read as `document`.
 */
const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /\bfrom ['"]node:/, why: 'a node builtin — this runs in Hermes too' },
  { pattern: /\brequire\(['"]node:/, why: 'a node builtin — this runs in Hermes too' },
  { pattern: /\bfrom ['"](fs|path|os|crypto|http|https)['"]/, why: 'a node builtin' },
  { pattern: /\bBuffer\b/, why: 'Buffer does not exist in Hermes or in a browser' },
  { pattern: /\bprocess\.(env|cwd|platform)\b/, why: 'there is no process on a device' },
  { pattern: /\bdocument\b/, why: 'there is no DOM in React Native' },
  { pattern: /\bwindow\./, why: 'there is no window in React Native' },
  { pattern: /\blocalStorage\b/, why: 'storage is injected through SessionStore' },
  { pattern: /\bfrom ['"]react/, why: 'this package is UI-framework-neutral' },
  { pattern: /\bfrom ['"]@ruood\/announcement-core['"]/, why: 'core reaches for fs, sharp and git' },
];

/**
 * `@ruood/announcement-core` is the one import allowed through, and only as a
 * TYPE. A type import erases entirely, so Metro never resolves the package and
 * `sharp` never goes near a bundle. A value import would drag all of it in.
 */
const TYPE_ONLY_CORE = /import type \{[^}]*\} from '@ruood\/announcement-core';/g;

function sources(): { name: string; body: string }[] {
  return readdirSync(SOURCE, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      name: entry.name,
      body: readFileSync(join(SOURCE, entry.name), 'utf8'),
    }));
}

describe('the client package stays platform-neutral', () => {
  it('has sources to sweep', () => {
    expect(sources().length).toBeGreaterThan(5);
  });

  it.each(BANNED)('never uses $why', ({ pattern, why }) => {
    const offenders = sources()
      .map(({ name, body }) => ({
        name,
        // Comments are stripped first: this file's own prose names most of the
        // things it bans, and so does the reasoning in the modules themselves.
        body: stripComments(body).replace(TYPE_ONLY_CORE, ''),
      }))
      .filter(({ body }) => pattern.test(body))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
    expect(why).toBeTruthy();
  });

  it('imports core only as a type, so Metro never resolves it', () => {
    for (const { name, body } of sources()) {
      const mentions = stripComments(body).match(/from '@ruood\/announcement-core'/g) ?? [];
      const typeOnly = stripComments(body).match(TYPE_ONLY_CORE) ?? [];

      expect(`${name}: ${mentions.length} import(s), ${typeOnly.length} type-only`).toBe(
        `${name}: ${mentions.length} import(s), ${mentions.length} type-only`,
      );
    }
  });
});

/** Block and line comments removed, so prose about a banned name is not a use of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
