import { validateManifest } from '@ruood/announcement-schema';

import { AUTHORED_ONLY_KEYS, exclusionFor, projectManifest, toPublished } from '../project';
import { DAY, NOW, authored, iso } from '../../__tests__/fixtures';

const options = { now: NOW, revision: 5 };

describe('what gets published', () => {
  it('publishes a live record', () => {
    const result = projectManifest([authored()], options);
    expect(result.manifest.announcements.map((r) => r.id)).toEqual(['reports-center']);
    expect(result.excluded).toEqual([]);
  });

  it('publishes a scheduled record, so its image is cached before it starts', () => {
    const record = authored({ startAt: iso(NOW + 5 * DAY), endAt: iso(NOW + 10 * DAY) });
    expect(projectManifest([record], options).manifest.announcements).toHaveLength(1);
  });

  it.each([
    ['draft', authored({ status: 'draft' }), 'draft'],
    ['archived', authored({ status: 'archived' }), 'archived'],
    ['expired', authored({ startAt: iso(NOW - 10 * DAY), endAt: iso(NOW - DAY) }), 'expired'],
  ])('excludes a %s record', (_label, record, reason) => {
    const result = projectManifest([record], options);
    expect(result.manifest.announcements).toHaveLength(0);
    expect(result.excluded).toEqual([{ id: record.id, reason }]);
  });

  it('excludes a record at the exact instant it expires', () => {
    // The window is half-open, so `now === endAt` is already over.
    const record = authored({ startAt: iso(NOW - DAY), endAt: iso(NOW) });
    expect(exclusionFor(record, NOW)).toBe('expired');
    expect(exclusionFor(record, NOW - 1)).toBeNull();
  });

  it('excludes a record whose dates will not parse rather than guessing', () => {
    expect(exclusionFor(authored({ startAt: '2026-09-01' }), NOW)).toBe('unreadable-dates');
    expect(exclusionFor(authored({ endAt: 'whenever' }), NOW)).toBe('unreadable-dates');
  });

  it('publishes a record with no end date', () => {
    expect(exclusionFor(authored({ endAt: null }), NOW + 3650 * DAY)).toBeNull();
  });
});

describe('paused records', () => {
  it('publishes them, carrying paused:true', () => {
    // Kept in the manifest so the client keeps its cached image and resuming
    // needs no download.
    const result = projectManifest([authored({ status: 'paused' })], options);
    expect(result.manifest.announcements[0]).toMatchObject({ paused: true });
  });

  it('never emits paused:false, which is the default', () => {
    const record = projectManifest([authored({ status: 'published' })], options).manifest
      .announcements[0]!;
    expect('paused' in record).toBe(false);
  });

  it('clears a stale paused flag when the record is resumed', () => {
    const record = authored({ status: 'published', paused: true });
    expect('paused' in toPublished(record)).toBe(false);
  });
});

describe('stripping the authoring fields', () => {
  it('removes every one of them', () => {
    const published = toPublished(
      authored({ internalNote: 'ask marketing' }),
    ) as unknown as Record<string, unknown>;
    for (const key of AUTHORED_ONLY_KEYS) {
      expect(published[key]).toBeUndefined();
    }
  });

  it('keeps every published field', () => {
    const record = authored();
    const published = toPublished(record);
    expect(published).toMatchObject({
      id: record.id,
      rev: record.rev,
      minSchema: record.minSchema,
      title: record.title,
      body: record.body,
      category: record.category,
      priority: record.priority,
      startAt: record.startAt,
      endAt: record.endAt,
      display: record.display,
      targeting: record.targeting,
    });
  });

  it('produces a manifest the published-mode validator accepts', () => {
    // The projection's real contract: whatever it emits must be readable by a
    // client, and an authoring field left behind is an error there.
    const result = projectManifest([authored(), authored({ id: 'second' })], options);
    expect(validateManifest(result.manifest, { now: NOW }).ok).toBe(true);
  });
});

describe('ordering', () => {
  it('sorts by priority, then start, then id', () => {
    const records = [
      authored({ id: 'c-low', priority: 10 }),
      authored({ id: 'a-high', priority: 90 }),
      authored({ id: 'b-high', priority: 90 }),
    ];
    const result = projectManifest(records, options);
    expect(result.manifest.announcements.map((r) => r.id)).toEqual(['a-high', 'b-high', 'c-low']);
  });

  it('breaks a priority tie by the earlier start', () => {
    const records = [
      authored({ id: 'later', startAt: iso(NOW) }),
      authored({ id: 'earlier', startAt: iso(NOW - 2 * DAY) }),
    ];
    expect(projectManifest(records, options).manifest.announcements.map((r) => r.id)).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('is stable regardless of input order, so a diff means something', () => {
    const records = [authored({ id: 'aaa' }), authored({ id: 'bbb' }), authored({ id: 'ccc' })];
    const forward = projectManifest(records, options).manifest.announcements.map((r) => r.id);
    const backward = projectManifest([...records].reverse(), options).manifest.announcements.map(
      (r) => r.id,
    );
    expect(forward).toEqual(backward);
  });
});

describe('the envelope', () => {
  it('stamps the injected revision and clock, never the real one', () => {
    const result = projectManifest([], { now: NOW, revision: 42 });
    expect(result.manifest.revision).toBe(42);
    expect(result.manifest.generatedAt).toBe('2026-09-15T12:00:00Z');
  });

  it('defaults the kill switch to off', () => {
    expect(projectManifest([], options).manifest.paused).toBe(false);
  });

  it('carries the kill switch when set', () => {
    expect(projectManifest([], { ...options, paused: true }).manifest.paused).toBe(true);
  });

  it('produces a valid manifest from no records at all', () => {
    const result = projectManifest([], options);
    expect(validateManifest(result.manifest, { now: NOW }).ok).toBe(true);
  });
});
