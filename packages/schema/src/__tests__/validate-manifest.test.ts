import type { IssueCode, ValidationResult } from '../issues';
import { MANIFEST_MAX_BYTES, MANIFEST_MAX_RECORDS } from '../constants';
import { validateManifest } from '../validate-manifest';
import { DAY, NOW, iso, loose, manifest, publishedRecord } from './fixtures';

function check(value: unknown, serialisedBytes?: number): ValidationResult {
  return validateManifest(value, {
    now: NOW,
    ...(serialisedBytes === undefined ? {} : { serialisedBytes }),
  });
}

function codes(result: ValidationResult): IssueCode[] {
  return result.errors.map((issue) => issue.code);
}

function warningCodes(result: ValidationResult): IssueCode[] {
  return result.warnings.map((issue) => issue.code);
}

describe('the envelope', () => {
  it('accepts the fixture manifest cleanly', () => {
    const result = check(manifest());
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it.each([null, undefined, 42, 'text', []])('rejects %p as not an object', (value) => {
    expect(codes(check(value))).toContain('not-an-object');
  });

  it('requires every envelope field', () => {
    for (const field of ['schemaVersion', 'revision', 'generatedAt', 'paused', 'announcements']) {
      const value = loose(manifest());
      delete value[field];
      expect(codes(check(value))).toContain('missing-field');
    }
  });

  it('rejects a schema version this build cannot read', () => {
    expect(codes(check(manifest([], { schemaVersion: 2 })))).toContain(
      'schema-version-unsupported',
    );
    expect(codes(check(manifest([], { schemaVersion: 0 })))).toContain(
      'schema-version-unsupported',
    );
  });

  it('requires generatedAt to carry an offset', () => {
    expect(codes(check(manifest([], { generatedAt: '2026-09-15' })))).toContain(
      'instant-no-offset',
    );
  });

  it('requires paused to be a boolean, since it is the kill switch', () => {
    expect(codes(check(manifest([], { paused: 'yes' as unknown as boolean })))).toContain(
      'wrong-type',
    );
    expect(check(manifest([], { paused: true })).ok).toBe(true);
  });

  it('warns about an unrecognised envelope field', () => {
    const value = { ...manifest(), signedBy: 'someone' };
    expect(warningCodes(check(value))).toContain('unknown-field');
  });
});

describe('size and count limits', () => {
  it('rejects a manifest over the byte cap', () => {
    const result = check(manifest(), MANIFEST_MAX_BYTES + 1);
    expect(codes(result)).toContain('manifest-too-large');
  });

  it('accepts one exactly at the cap', () => {
    expect(codes(check(manifest(), MANIFEST_MAX_BYTES))).not.toContain('manifest-too-large');
  });

  it('rejects more records than a published manifest should ever hold', () => {
    const records = Array.from({ length: MANIFEST_MAX_RECORDS + 1 }, (_, i) =>
      publishedRecord({ id: `record-${i + 1}`, display: { ...publishedRecord().display, surface: 'inbox' } }),
    );
    expect(codes(check(manifest(records)))).toContain('manifest-too-many-records');
  });
});

describe('records inside the manifest', () => {
  it('reports a record error against its index', () => {
    const result = check(manifest([publishedRecord({ title: '' })]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.path === 'announcements[0].title')).toBe(true);
  });

  it('validates every record, not just the first', () => {
    const result = check(
      manifest([publishedRecord(), publishedRecord({ id: 'second', priority: 999 })]),
    );
    expect(result.errors.some((issue) => issue.path.startsWith('announcements[1]'))).toBe(true);
  });

  it('rejects a duplicate id and names both positions', () => {
    // Ids key impression state on every device, so two records cannot share one.
    const result = check(manifest([publishedRecord(), publishedRecord()]));
    expect(codes(result)).toContain('id-duplicate');
    expect(result.errors.some((issue) => issue.message.includes('announcements[0]'))).toBe(true);
  });

  it('rejects an authoring field that leaked into a published record', () => {
    const leaked = { ...publishedRecord(), status: 'published' } as never;
    expect(codes(check(manifest([leaked])))).toContain('unknown-field');
  });
});

describe('overlap warnings', () => {
  const inbox = { ...publishedRecord().display, surface: 'inbox' as const };

  it('warns when two records of the same category overlap in time', () => {
    const result = check(
      manifest([
        publishedRecord({ id: 'first', startAt: iso(NOW), endAt: iso(NOW + 5 * DAY) }),
        publishedRecord({ id: 'second', startAt: iso(NOW + DAY), endAt: iso(NOW + 6 * DAY) }),
      ]),
    );
    expect(warningCodes(result)).toContain('overlapping-category-warning');
  });

  it('does not warn when the windows merely touch', () => {
    const result = check(
      manifest([
        publishedRecord({ id: 'first', startAt: iso(NOW), endAt: iso(NOW + DAY) }),
        publishedRecord({ id: 'second', startAt: iso(NOW + DAY), endAt: iso(NOW + 2 * DAY) }),
      ]),
    );
    expect(warningCodes(result)).not.toContain('overlapping-category-warning');
  });

  it('does not warn across different categories', () => {
    const result = check(
      manifest([
        publishedRecord({ id: 'first', category: 'feature' }),
        publishedRecord({ id: 'second', category: 'tip' }),
      ]),
    );
    expect(warningCodes(result)).not.toContain('overlapping-category-warning');
  });

  it('warns when more than three modals are live at once', () => {
    const records = Array.from({ length: 4 }, (_, i) =>
      publishedRecord({
        id: `modal-${i + 1}`,
        category: i % 2 === 0 ? 'feature' : 'tip',
        startAt: iso(NOW),
        endAt: iso(NOW + 5 * DAY),
      }),
    );
    expect(warningCodes(check(manifest(records)))).toContain('too-many-modals-warning');
  });

  it('does not count a paused record towards modal pressure', () => {
    const records = Array.from({ length: 4 }, (_, i) =>
      publishedRecord({
        id: `modal-${i + 1}`,
        category: i % 2 === 0 ? 'feature' : 'tip',
        startAt: iso(NOW),
        endAt: iso(NOW + 5 * DAY),
        ...(i === 0 ? { paused: true } : {}),
      }),
    );
    expect(warningCodes(check(manifest(records)))).not.toContain('too-many-modals-warning');
  });

  it('does not count banners or inbox items towards modal pressure', () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      publishedRecord({
        id: `quiet-${i + 1}`,
        category: i % 2 === 0 ? 'feature' : 'tip',
        display: inbox,
        startAt: iso(NOW),
        endAt: iso(NOW + 5 * DAY),
      }),
    );
    expect(warningCodes(check(manifest(records)))).not.toContain('too-many-modals-warning');
  });

  it('counts a record with no end date as live indefinitely', () => {
    const records = Array.from({ length: 4 }, (_, i) =>
      publishedRecord({
        id: `open-${i + 1}`,
        category: i % 2 === 0 ? 'feature' : 'tip',
        startAt: iso(NOW),
        endAt: null,
      }),
    );
    expect(warningCodes(check(manifest(records)))).toContain('too-many-modals-warning');
  });
});

describe('an empty manifest', () => {
  it('is valid — it is what a paused or freshly-cleared repository publishes', () => {
    const result = check(manifest([]));
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
