/**
 * The Settings screen's retention field.
 *
 * Two things are worth pinning and neither needs a renderer.
 *
 * **It uses the shared bounds.** The phone's form, the CLI's `--max` and the
 * build that enforces the stored number all read `@ruood/announcement-authoring`.
 * A literal `50` typed into this screen is how the phone comes to accept a
 * value the build refuses — the same class of bug as a second copy of the
 * validator.
 *
 * **It says it in the product's own vocabulary.** §25: `manifest`, `dist`,
 * `repository`, `commit` and `JSON` are implementation detail and none of them
 * may appear on a screen. A setting about what gets published is exactly where
 * that vocabulary leaks in, because every word for it in this codebase is one
 * of the forbidden ones.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isRetentionLimit,
  parseRetentionLimit,
  RETENTION_MAX,
  RETENTION_MIN,
  retentionLimitProblem,
} from '@ruood/announcement-authoring';

const source = readFileSync(
  join(__dirname, '..', '..', 'app', '(tabs)', 'settings.tsx'),
  'utf8',
);

describe('the field', () => {
  it('is on the Settings screen, labelled in words an administrator uses', () => {
    expect(source).toContain('Maximum retained announcements');
  });

  it('takes its bounds from the shared module rather than repeating them', () => {
    expect(source).toContain("from '@ruood/announcement-authoring'");
    expect(source).toContain('RETENTION_MIN');
    expect(source).toContain('RETENTION_MAX');

    // The numbers themselves must not appear as literals in the copy or the
    // validation — that is how the phone and the build start to disagree.
    const body = source.slice(source.indexOf('export default'));
    expect(body).not.toMatch(/\b50\b/);
  });

  it('validates through the shared parser, not a regex of its own', () => {
    expect(source).toContain('parseRetentionLimit');
    expect(source).toContain('retentionLimitProblem');
  });

  it('writes the setting through the one function that preserves the counter', () => {
    // `saveSettings` merges onto the stored file. A screen that assembled its
    // own write would drop the revision counter.
    expect(source).toContain('saveSettings');
  });
});

describe('the words on the screen', () => {
  /**
   * The card itself, comments and all.
   *
   * Sliced rather than swept over the whole file, because the rest of the
   * screen is about accounts and builds and has its own vocabulary; and
   * including the comments is deliberate — a word that belongs nowhere near an
   * administrator should not be in the block either, where the next person
   * copies it into a label.
   */
  const card = source.slice(
    source.indexOf('<Card title="Announcements people see">'),
    source.indexOf('<Card title="About">'),
  );

  const copy = card;

  it.each([
    'manifest',
    'dist',
    'repository',
    'commit',
    'JSON',
    'revision',
    'retention limit',
    'maxRetained',
    'state.json',
  ])('never says %s', (word) => {
    expect(copy.toLowerCase()).not.toContain(word.toLowerCase());
  });

  it('says what happens to the ones that fall outside, because that is the fear', () => {
    // An administrator setting a limit needs to know it is not a deletion. The
    // sentence is the feature's whole safety story on the one screen that
    // offers it.
    expect(source).toContain('nothing is deleted');
    expect(source.toLowerCase()).toContain('history');
  });

  it('does not claim the change is already live', () => {
    // The workflow builds and signs after the next publish, which is a minute
    // or two away — the same honesty the publish screen keeps.
    expect(source).toContain('takes effect the next time an announcement is published');
  });
});

describe('what the form accepts', () => {
  it('accepts a value the build will accept, and refuses one it would not', () => {
    for (const value of [RETENTION_MIN, 5, RETENTION_MAX]) {
      expect(parseRetentionLimit(String(value))).toBe(value);
      expect(isRetentionLimit(value)).toBe(true);
    }

    for (const text of ['0', '-1', String(RETENTION_MAX + 1), '']) {
      expect(parseRetentionLimit(text)).toBeNull();
    }
  });

  it('has a sentence to show for every refusal', () => {
    for (const text of ['0', '-1', String(RETENTION_MAX + 1), 'lots']) {
      const problem = retentionLimitProblem(text);
      expect(problem).not.toBeNull();
      expect(problem).toMatch(/[.!?]$/);
    }
  });
});
