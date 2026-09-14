/**
 * The retention window.
 *
 * `content/` is history and grows for ever; `dist/` is downloaded by every
 * install. This is the line between them — the newest N of what would be
 * published, and nothing older.
 *
 * Two properties carry the whole feature, and both are asserted here rather
 * than described:
 *
 *   - the window MOVES: publishing a sixth announcement under a limit of five
 *     drops the oldest, and the published set never grows past the limit;
 *   - it only ever REMOVES: no record is edited, no status is changed, and a
 *     paused announcement that falls outside the window is still paused when it
 *     comes back.
 *
 * That second one is the dangerous half. Retention that "archived" the oldest
 * record would be writing to `content/` from inside a build, and a build that
 * edits the thing it is reading is an author — the next diff would show a
 * change nobody made.
 */

import { DEFAULT_MAX_RETAINED, RETENTION_MAX } from '@ruood/announcement-authoring';
import type { AuthoredAnnouncement } from '@ruood/announcement-schema';

import { applyRetention, projectManifest } from '../project';
import { DAY, NOW, authored, iso } from '../../__tests__/fixtures';

const options = { now: NOW, revision: 5 };

/** A published record, `age` days old, published when it started. */
function aged(id: string, age: number, overrides: Partial<AuthoredAnnouncement> = {}) {
  return authored({
    id,
    startAt: iso(NOW - age * DAY),
    endAt: null,
    publishedAt: iso(NOW - age * DAY),
    ...overrides,
  });
}

/** What the manifest would carry, in no particular order. */
function published(records: AuthoredAnnouncement[], maxRetained?: number): string[] {
  const result = projectManifest(records, {
    ...options,
    ...(maxRetained === undefined ? {} : { maxRetained }),
  });
  return result.manifest.announcements.map((record) => record.id).sort();
}

// A, B, C, D, E, oldest first — the example the feature was asked for.
const A = aged('a', 50);
const B = aged('b', 40);
const C = aged('c', 30);
const D = aged('d', 20);
const E = aged('e', 10);
const F = aged('f', 5);
const G = aged('g', 1);

describe('the window', () => {
  it('publishes everything while the limit is not reached', () => {
    expect(published([A, B, C, D, E], 5)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops the oldest when a sixth arrives', () => {
    expect(published([A, B, C, D, E, F], 5)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('moves again with a seventh', () => {
    expect(published([A, B, C, D, E, F, G], 5)).toEqual(['c', 'd', 'e', 'f', 'g']);
  });

  it('never grows past the limit, however many there are', () => {
    const many = Array.from({ length: 40 }, (_, index) => aged(`n${index}`, index + 1));
    for (const limit of [1, 3, 5, 10, RETENTION_MAX]) {
      expect(published(many, limit).length).toBeLessThanOrEqual(limit);
    }
  });

  it('says why each one is out, so the CLI can name them', () => {
    const result = projectManifest([A, B, C, D, E, F], { ...options, maxRetained: 5 });

    expect(result.excluded).toEqual([{ id: 'a', reason: 'retention' }]);
  });

  it('publishes everything when no limit is given, as every build did before', () => {
    expect(published([A, B, C, D, E, F, G])).toHaveLength(7);
  });

  it.each([0, -1, 4.5, RETENTION_MAX + 1, Number.NaN])(
    'retains everything rather than acting on the unusable limit %p',
    (limit) => {
      // The callers normalise. This is the floor under a bad call site, and it
      // fails towards publishing rather than towards an empty manifest — which
      // on a device is indistinguishable from an outage.
      expect(applyRetention([A, B, C], limit).dropped).toEqual([]);
    },
  );
});

describe('changing the setting', () => {
  const all = [A, B, C, D, E, F, G];

  it('publishes more when the limit goes up', () => {
    expect(published(all, 5)).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(published(all, 10)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('publishes fewer when it comes down', () => {
    expect(published(all, 3)).toEqual(['e', 'f', 'g']);
  });

  it('brings a record straight back, because it was never changed', () => {
    // The whole point of excluding rather than archiving: raising the limit is
    // a build away, with no transition to undo and no status to repair.
    expect(published(all, 3)).not.toContain('a');
    expect(published(all, 10)).toContain('a');
  });
});

describe('the other lifecycle states', () => {
  it('does not let drafts, archived or expired records take a place', () => {
    const draft = authored({ id: 'draft-one', status: 'draft' });
    const archived = authored({ id: 'archived-one', status: 'archived' });
    const expired = aged('expired-one', 30, { endAt: iso(NOW - DAY) });

    const result = projectManifest([draft, archived, expired, E, F, G], {
      ...options,
      maxRetained: 3,
    });

    // Three places, and all three go to records that would actually publish.
    expect(result.manifest.announcements.map((r) => r.id).sort()).toEqual(['e', 'f', 'g']);
    expect(result.excluded.map((entry) => entry.reason).sort()).toEqual([
      'archived',
      'draft',
      'expired',
    ]);
  });

  it('counts a paused record, because it is published and costs every install bytes', () => {
    const paused = aged('paused-recent', 2, { status: 'paused' });
    const result = published([A, B, paused], 2);

    expect(result).toEqual(['b', 'paused-recent']);
  });

  it('keeps a paused record paused, and NEVER reactivates one', () => {
    const paused = aged('paused-recent', 2, { status: 'paused' });

    const record = projectManifest([paused], { ...options, maxRetained: 5 }).manifest
      .announcements[0]!;

    expect(record.paused).toBe(true);
  });

  it('leaves a record that falls outside the window exactly as it was', () => {
    const paused = aged('paused-old', 60, { status: 'paused' });
    const before = JSON.stringify(paused);

    projectManifest([paused, E, F, G], { ...options, maxRetained: 2 });

    // No status change, no stamp, no archive. `content/` is not this build's to
    // write, and a paused announcement that came back as published would be the
    // worst outcome of the whole feature.
    expect(JSON.stringify(paused)).toBe(before);
    expect(paused.status).toBe('paused');
  });
});

describe('which ones are the newest', () => {
  it('uses publishedAt, which is when the announcement went out', () => {
    // A record published yesterday but scheduled to start next month is newer
    // than one published a year ago, whatever their start dates say.
    const scheduled = authored({
      id: 'scheduled',
      publishedAt: iso(NOW - DAY),
      startAt: iso(NOW + 30 * DAY),
      endAt: null,
    });

    expect(published([A, B, scheduled], 1)).toEqual(['scheduled']);
  });

  it('falls back to startAt for a record that has never been published', () => {
    // Drafts reach a manifest on the staging channel and have no publishedAt.
    const older = authored({ id: 'older-draft', status: 'draft', startAt: iso(NOW - 9 * DAY) });
    const newer = authored({ id: 'newer-draft', status: 'draft', startAt: iso(NOW - DAY) });

    const result = projectManifest([older, newer], {
      ...options,
      includeDrafts: true,
      maxRetained: 1,
    });

    expect(result.manifest.announcements.map((r) => r.id)).toEqual(['newer-draft']);
  });

  it('is not the presentation order: priority does not hold a place', () => {
    // `byPresentationOrder` sorts by priority, and using it here would let a
    // high-priority announcement from a year ago outrank this week's.
    const oldImportant = aged('old-important', 90, { priority: 100 });
    const recent = aged('recent', 1, { priority: 1 });

    expect(published([oldImportant, recent], 1)).toEqual(['recent']);
  });

  it('breaks a tie the same way every time, so a build is reproducible', () => {
    const first = aged('aaa', 10);
    const second = aged('zzz', 10);

    // Same dates. The diff, the bytes and the signature all depend on the
    // answer not wobbling between builds.
    for (let run = 0; run < 5; run += 1) {
      expect(published([second, first], 1)).toEqual(['aaa']);
    }
  });
});

describe('applyRetention on its own', () => {
  it('returns the kept records in the order it was given them', () => {
    const result = applyRetention([G, A, F, B], 2);
    expect(result.kept.map((record) => record.id)).toEqual(['g', 'f']);
  });

  it('returns the dropped ones newest first', () => {
    const result = applyRetention([A, B, C, D], 1);
    expect(result.dropped.map((record) => record.id)).toEqual(['c', 'b', 'a']);
  });

  it('copies rather than mutating the input array', () => {
    const input = [A, B, C];
    applyRetention(input, 1);
    expect(input.map((record) => record.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op at exactly the limit', () => {
    expect(applyRetention([A, B, C], 3).dropped).toEqual([]);
  });

  it('applies the default when that is what was stored', () => {
    const many = Array.from({ length: DEFAULT_MAX_RETAINED + 5 }, (_, index) =>
      aged(`n${index}`, index + 1),
    );

    expect(applyRetention(many, DEFAULT_MAX_RETAINED).kept).toHaveLength(DEFAULT_MAX_RETAINED);
  });
});
