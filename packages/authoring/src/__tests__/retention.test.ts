/**
 * The retention limit's bounds, and what counts as one.
 *
 * Three front ends read these — the phone's form, the CLI's `--max`, and the
 * build that enforces the stored value — so a disagreement here is a number one
 * of them accepts and another refuses.
 */

import { MANIFEST_MAX_RECORDS } from '@ruood/announcement-schema';

import {
  DEFAULT_MAX_RETAINED,
  isRetentionLimit,
  normaliseRetentionLimit,
  parseRetentionLimit,
  RETENTION_MAX,
  RETENTION_MIN,
  retentionLimitProblem,
} from '../retention';

describe('the bounds', () => {
  it('stops at the schema’s own cap, rather than repeating the number', () => {
    // A limit above this could never be satisfied: `validateManifest` refuses a
    // manifest with more records, on the publisher and on every client.
    expect(RETENTION_MAX).toBe(MANIFEST_MAX_RECORDS);
  });

  it('has a minimum of one, because zero is the kill switch and there is one', () => {
    expect(RETENTION_MIN).toBe(1);
    expect(isRetentionLimit(0)).toBe(false);
  });

  it('defaults inside its own bounds and below the cap', () => {
    expect(isRetentionLimit(DEFAULT_MAX_RETAINED)).toBe(true);
    expect(DEFAULT_MAX_RETAINED).toBeLessThan(RETENTION_MAX);
  });
});

describe('isRetentionLimit', () => {
  it.each([RETENTION_MIN, 5, 20, RETENTION_MAX])('accepts %s', (value) => {
    expect(isRetentionLimit(value)).toBe(true);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['above the cap', RETENTION_MAX + 1],
    ['fractional', 4.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string', '5'],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_label, value) => {
    expect(isRetentionLimit(value)).toBe(false);
  });
});

describe('normaliseRetentionLimit', () => {
  it('keeps a usable value', () => {
    expect(normaliseRetentionLimit(7)).toBe(7);
  });

  it.each([[0], [-3], [RETENTION_MAX + 1], ['lots'], [null], [undefined], [{}]])(
    'falls back to the default for %p',
    (value) => {
      // Forgiving only in the safe direction: the default publishes FEWER
      // records than an unbounded build, and a hand-edited settings file is no
      // reason to stop publishing altogether.
      expect(normaliseRetentionLimit(value)).toBe(DEFAULT_MAX_RETAINED);
    },
  );
});

describe('parseRetentionLimit', () => {
  it('reads digits, with surrounding space', () => {
    expect(parseRetentionLimit('5')).toBe(5);
    expect(parseRetentionLimit(' 12 ')).toBe(12);
  });

  it.each(['', '0', '-1', '4.5', '1e2', '0x10', 'five', String(RETENTION_MAX + 1)])(
    'refuses %p rather than clamping it',
    (text) => {
      // A form that turned 500 into 50 would show a number nobody chose.
      expect(parseRetentionLimit(text)).toBeNull();
    },
  );

  it('explains a refusal in a sentence, and says nothing when there is nothing to say', () => {
    const problem = retentionLimitProblem('0');
    expect(problem).toContain(String(RETENTION_MIN));
    expect(problem).toContain(String(RETENTION_MAX));
    expect(retentionLimitProblem('5')).toBeNull();
  });
});
