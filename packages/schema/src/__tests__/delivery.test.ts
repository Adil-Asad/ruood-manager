/**
 * Active versus passive delivery is `surface`, and nothing else.
 *
 * Phase 5 asked for an authoring control that distinguishes "may interrupt"
 * from "inbox only". The contract already had one, so no field was added — and
 * this file exists to keep it that way. A `passive` boolean alongside `surface`
 * would be a second field expressing the same fact, free to disagree with it,
 * and every consumer would then have to decide which one wins.
 *
 * These assertions are about the CONTRACT, so they live with the contract
 * rather than in the Manager or the app. Both read them the same way:
 *
 *     modal / banner  →  active, presented under the eligibility rules
 *     inbox           →  passive, Settings › Announcements only
 */

import { SURFACES } from '../constants';
import { validateAnnouncementRecord } from '../validate-record';
import { NOW, publishedRecord } from './fixtures';

/** The surfaces a client is allowed to present. Mirrors the app's own check. */
const PRESENTABLE: readonly string[] = ['modal', 'banner'];

describe('surface is the delivery axis', () => {
  it('is a closed set of exactly three', () => {
    expect([...SURFACES]).toEqual(['modal', 'banner', 'inbox']);
  });

  it('splits cleanly into active and passive, with nothing left over', () => {
    const active = SURFACES.filter((surface) => PRESENTABLE.includes(surface));
    const passive = SURFACES.filter((surface) => !PRESENTABLE.includes(surface));

    expect(active).toEqual(['modal', 'banner']);
    expect(passive).toEqual(['inbox']);
  });
});

describe('no second field says the same thing', () => {
  it('a record carries no `passive` field, and one is refused as unknown', () => {
    const clean = validateAnnouncementRecord(publishedRecord(), { now: NOW, mode: 'published' });
    expect(clean.ok).toBe(true);

    // Adding one would be tolerated as an unknown optional field — forward
    // compatibility requires that — but it would be a warning, and it would
    // mean nothing to any consumer. `surface` is the answer.
    const withFlag = validateAnnouncementRecord(
      { ...publishedRecord(), passive: true } as never,
      { now: NOW, mode: 'published' },
    );

    expect(withFlag.warnings.some((issue) => issue.code === 'unknown-field')).toBe(true);
  });

  it.each([...SURFACES])('accepts %s as a valid surface on its own', (surface) => {
    const result = validateAnnouncementRecord(
      { ...publishedRecord(), display: { ...publishedRecord().display, surface } },
      { now: NOW, mode: 'published' },
    );

    expect(result.ok).toBe(true);
  });

  it('refuses a surface outside the three, rather than treating it as passive', () => {
    // Failing closed: an unknown surface is a record this build cannot render,
    // not one to quietly file away in an inbox.
    const result = validateAnnouncementRecord(
      { ...publishedRecord(), display: { ...publishedRecord().display, surface: 'toast' } },
      { now: NOW, mode: 'published' },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.code === 'unknown-enum-value')).toBe(true);
  });
});
