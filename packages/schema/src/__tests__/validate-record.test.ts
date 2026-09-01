import type { IssueCode, ValidationResult } from '../issues';
import { formatIssues } from '../issues';
import { deriveLifecycleStatus, validateAnnouncementRecord } from '../validate-record';
import { DAY, NOW, authoredRecord, iso, loose, publishedRecord, validImage } from './fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authored(overrides: Record<string, unknown> = {}): ValidationResult {
  return validateAnnouncementRecord(
    { ...authoredRecord(), ...overrides },
    { now: NOW, mode: 'authored' },
  );
}

function published(overrides: Record<string, unknown> = {}): ValidationResult {
  return validateAnnouncementRecord(
    { ...publishedRecord(), ...overrides },
    { now: NOW, mode: 'published' },
  );
}

function codes(result: ValidationResult): IssueCode[] {
  return result.errors.map((issue) => issue.code);
}

function warningCodes(result: ValidationResult): IssueCode[] {
  return result.warnings.map((issue) => issue.code);
}

expect.extend({
  toBeClean(received: ValidationResult) {
    const pass = received.ok && received.warnings.length === 0;
    return {
      pass,
      message: () =>
        `Expected a clean validation, got:\n${formatIssues([
          ...received.errors,
          ...received.warnings,
        ])}`,
    };
  },
});

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeClean(): R;
    }
  }
}

// ---------------------------------------------------------------------------

describe('the fixtures themselves', () => {
  // If this fails, every "produces exactly one error" assertion below is
  // meaningless, because the baseline was already dirty.
  it('validate with no errors and no warnings', () => {
    expect(authored()).toBeClean();
    expect(published()).toBeClean();
  });
});

describe('structure', () => {
  it.each([null, undefined, 42, 'a string', [], [publishedRecord()]])(
    'rejects %p as not an object',
    (value) => {
      const result = validateAnnouncementRecord(value, { now: NOW });
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain('not-an-object');
    },
  );

  it('warns about an unrecognised field rather than rejecting it', () => {
    // Forward compatibility requires an unknown optional field be ignorable.
    const result = authored({ colour: 'gold' });
    expect(result.ok).toBe(true);
    expect(warningCodes(result)).toContain('unknown-field');
  });

  it('rejects an authoring field that leaked into a published manifest', () => {
    const result = published({ status: 'published' });
    expect(codes(result)).toContain('unknown-field');
  });

  it('requires the authoring fields in authored mode', () => {
    const record = loose(publishedRecord());
    const result = validateAnnouncementRecord(record, { now: NOW, mode: 'authored' });
    expect(codes(result)).toContain('missing-field');
  });
});

describe('id', () => {
  it('rejects a malformed id', () => {
    expect(codes(authored({ id: 'Reports Center' }))).toContain('id-invalid-format');
    expect(codes(authored({ id: 'ab' }))).toContain('id-too-short');
  });

  it('rejects an id already in use', () => {
    const result = validateAnnouncementRecord(authoredRecord(), {
      now: NOW,
      mode: 'authored',
      idRegistry: { active: ['reports-center-launch'], retired: [] },
    });
    expect(codes(result)).toContain('id-duplicate');
  });

  it('does not fire the duplicate check on the record being edited', () => {
    const result = validateAnnouncementRecord(authoredRecord(), {
      now: NOW,
      mode: 'authored',
      idRegistry: { active: ['reports-center-launch'], retired: [] },
      editingId: 'reports-center-launch',
    });
    expect(result).toBeClean();
  });

  it('rejects a retired id with its own code', () => {
    const result = validateAnnouncementRecord(authoredRecord(), {
      now: NOW,
      mode: 'authored',
      idRegistry: { active: [], retired: ['reports-center-launch'] },
    });
    expect(codes(result)).toContain('id-retired');
  });

  it('does not consult the registry in published mode', () => {
    const result = validateAnnouncementRecord(publishedRecord(), {
      now: NOW,
      mode: 'published',
      idRegistry: { active: ['reports-center-launch'], retired: [] },
    });
    expect(result).toBeClean();
  });
});

describe('rev and minSchema', () => {
  it('requires rev to be a positive integer', () => {
    expect(codes(authored({ rev: 0 }))).toContain('number-out-of-range');
    expect(codes(authored({ rev: 1.5 }))).toContain('number-not-integer');
    expect(codes(authored({ rev: '2' }))).toContain('wrong-type');
  });

  it('rejects a record demanding a newer schema than this build supports', () => {
    const result = authored({ minSchema: 2 });
    expect(codes(result)).toContain('schema-version-unsupported');
  });

  it('accepts a record at exactly the supported schema version', () => {
    expect(authored({ minSchema: 1 })).toBeClean();
  });
});

describe('text', () => {
  it('requires a non-empty title and body', () => {
    expect(codes(authored({ title: '' }))).toContain('text-empty');
    expect(codes(authored({ title: '   ' }))).toContain('text-empty');
    expect(codes(authored({ body: '' }))).toContain('text-empty');
  });

  it('enforces the length limits', () => {
    expect(codes(authored({ title: 'a'.repeat(61) }))).toContain('text-too-long');
    expect(codes(authored({ body: 'a'.repeat(501) }))).toContain('text-too-long');
    expect(authored({ title: 'a'.repeat(60) })).toBeClean();
  });

  it('warns about a body that will scroll on a phone', () => {
    const result = authored({ body: 'a'.repeat(301) });
    expect(result.ok).toBe(true);
    expect(warningCodes(result)).toContain('text-long-warning');
  });

  it('refuses angle brackets, so stored text can never read as markup', () => {
    expect(codes(authored({ body: 'Tap <b>here</b>' }))).toContain('text-unsafe-characters');
    expect(codes(authored({ title: '5 > 4' }))).toContain('text-unsafe-characters');
  });

  it('refuses control characters and the Unicode line separators', () => {
    expect(codes(authored({ body: 'a\u0000b' }))).toContain('text-unsafe-characters');
    expect(codes(authored({ body: 'a\u007Fb' }))).toContain('text-unsafe-characters');
    expect(codes(authored({ body: 'a\u2028b' }))).toContain('text-unsafe-characters');
    expect(codes(authored({ body: 'a\u2029b' }))).toContain('text-unsafe-characters');
  });

  it('allows paragraph breaks in the body but not in the title', () => {
    expect(authored({ body: 'First line.\n\nSecond line.' })).toBeClean();
    expect(codes(authored({ title: 'Two\nlines' }))).toContain('text-unsafe-characters');
  });
});

describe('priority and category', () => {
  it('bounds priority to 0-100', () => {
    expect(codes(authored({ priority: -1 }))).toContain('number-out-of-range');
    expect(codes(authored({ priority: 101 }))).toContain('number-out-of-range');
    expect(authored({ priority: 0 })).toBeClean();
  });

  it('rejects an unknown category', () => {
    expect(codes(authored({ category: 'announcement' }))).toContain('unknown-enum-value');
  });
});

describe('scheduling', () => {
  it('requires an instant with an offset', () => {
    expect(codes(authored({ startAt: '2026-09-01' }))).toContain('instant-no-offset');
    expect(codes(authored({ startAt: 'soon' }))).toContain('instant-invalid');
  });

  it('rejects an end before the start', () => {
    const result = authored({ startAt: iso(NOW), endAt: iso(NOW - DAY) });
    expect(codes(result)).toContain('end-before-start');
  });

  it('rejects an end equal to the start, which is a window nothing falls in', () => {
    const at = iso(NOW);
    expect(codes(authored({ startAt: at, endAt: at }))).toContain('end-before-start');
  });

  it('requires endAt to be present, with null meaning no expiry', () => {
    const record = loose(authoredRecord());
    delete record.endAt;
    const result = validateAnnouncementRecord(record, { now: NOW, mode: 'authored' });
    expect(codes(result)).toContain('missing-field');
  });

  it('warns, rather than fails, when there is no end date', () => {
    const result = authored({ endAt: null });
    expect(result.ok).toBe(true);
    expect(warningCodes(result)).toContain('no-end-date-warning');
  });

  it('refuses to publish something that already ended', () => {
    const result = authored({ startAt: iso(NOW - 10 * DAY), endAt: iso(NOW - DAY) });
    expect(codes(result)).toContain('end-in-past');
  });

  it('allows a draft to hold a past end date', () => {
    const result = authored({
      status: 'draft',
      startAt: iso(NOW - 10 * DAY),
      endAt: iso(NOW - DAY),
    });
    expect(codes(result)).not.toContain('end-in-past');
  });

  it('does NOT reject an expired record in published mode', () => {
    // A device legitimately holds a manifest whose records have since expired;
    // rejecting the file over that would break the whole manifest.
    const result = published({ startAt: iso(NOW - 10 * DAY), endAt: iso(NOW - DAY) });
    expect(result).toBeClean();
  });

  it('warns about a start date far in the future', () => {
    const result = authored({ startAt: iso(NOW + 200 * DAY), endAt: iso(NOW + 210 * DAY) });
    expect(warningCodes(result)).toContain('start-far-future-warning');
  });
});

describe('display rules', () => {
  const display = publishedRecord().display;

  it('rejects an unknown surface, trigger or dismiss value', () => {
    expect(codes(authored({ display: { ...display, surface: 'toast' } }))).toContain(
      'unknown-enum-value',
    );
    expect(codes(authored({ display: { ...display, trigger: 'asap' } }))).toContain(
      'unknown-enum-value',
    );
    expect(codes(authored({ display: { ...display, dismiss: 'forever' } }))).toContain(
      'unknown-enum-value',
    );
  });

  it('requires maxImpressions to be null or at least 1', () => {
    expect(codes(authored({ display: { ...display, maxImpressions: 0 } }))).toContain(
      'number-out-of-range',
    );
    expect(codes(authored({ display: { ...display, maxImpressions: -3 } }))).toContain(
      'number-out-of-range',
    );
    expect(authored({ display: { ...display, maxImpressions: null } })).toBeClean();
  });

  it('allows minIntervalHours of 0 but not a negative', () => {
    expect(authored({ display: { ...display, minIntervalHours: 0 } })).toBeClean();
    expect(codes(authored({ display: { ...display, minIntervalHours: -1 } }))).toContain(
      'number-out-of-range',
    );
  });

  it('refuses the one combination that would be a remote brick', () => {
    // A modal that is never dismissed, never limited and never expires.
    const result = authored({
      endAt: null,
      display: { ...display, surface: 'modal', dismiss: 'none', maxImpressions: null },
    });
    expect(codes(result)).toContain('unclosable-modal');
  });

  it.each([
    ['an end date', { endAt: iso(NOW + DAY) }, {}],
    ['an impression limit', { endAt: null }, { maxImpressions: 2 }],
    ['a dismiss behaviour', { endAt: null }, { dismiss: 'permanent' as const }],
  ])('accepts an unlimited modal that has %s', (_label, top, displayOverride) => {
    const result = authored({
      ...top,
      display: {
        ...display,
        surface: 'modal',
        dismiss: 'none',
        maxImpressions: null,
        ...displayOverride,
      },
    });
    expect(codes(result)).not.toContain('unclosable-modal');
  });

  it('warns that a trigger has no meaning on an inbox announcement', () => {
    const result = authored({
      display: { ...display, surface: 'inbox', trigger: 'immediate' },
    });
    expect(warningCodes(result)).toContain('inbox-with-immediate-trigger');
  });

  it('warns about an unrecognised display field, scoped to its path', () => {
    const result = authored({ display: { ...display, colour: 'gold' } });
    expect(result.warnings.some((issue) => issue.path === 'display.colour')).toBe(true);
  });
});

describe('targeting', () => {
  const targeting = publishedRecord().targeting;

  it('requires at least one platform', () => {
    const result = authored({ targeting: { ...targeting, platforms: [] } });
    expect(codes(result)).toContain('number-out-of-range');
  });

  it('rejects an unknown platform', () => {
    const result = authored({ targeting: { ...targeting, platforms: ['android', 'watch'] } });
    expect(codes(result)).toContain('unknown-enum-value');
  });

  it('requires the version bounds to be semver or null', () => {
    expect(codes(authored({ targeting: { ...targeting, minVersion: '2.5' } }))).toContain(
      'version-invalid',
    );
    expect(codes(authored({ targeting: { ...targeting, maxVersion: '2.5.x' } }))).toContain(
      'version-invalid',
    );
  });

  it('rejects a range no version can satisfy', () => {
    const transposed = authored({
      targeting: { ...targeting, minVersion: '2.5.0', maxVersion: '2.4.0' },
    });
    expect(codes(transposed)).toContain('version-range-empty');

    const degenerate = authored({
      targeting: { ...targeting, minVersion: '2.5.0', maxVersion: '2.5.0' },
    });
    expect(codes(degenerate)).toContain('version-range-empty');
  });

  it('accepts the "every 2.5.x" idiom', () => {
    expect(
      authored({ targeting: { ...targeting, minVersion: '2.5.0', maxVersion: '2.6.0' } }),
    ).toBeClean();
  });

  it('warns when a feature announcement has no version floor', () => {
    const result = authored({
      category: 'feature',
      targeting: { ...targeting, minVersion: null },
    });
    expect(warningCodes(result)).toContain('version-missing-warning');
  });

  it('does not warn about a missing floor on a non-feature announcement', () => {
    const result = authored({
      category: 'notice',
      targeting: { ...targeting, minVersion: null },
    });
    expect(warningCodes(result)).not.toContain('version-missing-warning');
  });
});

describe('image', () => {
  it('accepts a well-formed image', () => {
    expect(authored({ image: validImage })).toBeClean();
  });

  it('treats an absent image as fine', () => {
    expect(authored({ image: undefined })).toBeClean();
  });

  it('requires a content-addressed path under images/', () => {
    for (const path of [
      'reports-center-a3f91c22.webp',
      'images/reports-center.webp',
      'images/reports-center-a3f91c22.png',
      'images/../secrets.webp',
      'https://example.com/a-a3f91c22.webp',
    ]) {
      const result = authored({ image: { ...validImage, path } });
      expect(codes(result)).toContain('image-path-invalid');
    }
  });

  it('enforces the byte cap', () => {
    const result = authored({ image: { ...validImage, bytes: 150 * 1024 + 1 } });
    expect(codes(result)).toContain('image-too-large');
  });

  it('enforces the dimension cap', () => {
    expect(codes(authored({ image: { ...validImage, width: 2000 } }))).toContain(
      'image-dimension-invalid',
    );
    expect(codes(authored({ image: { ...validImage, height: 4 } }))).toContain(
      'image-dimension-invalid',
    );
  });

  it('requires a 64-character lowercase hex digest', () => {
    expect(codes(authored({ image: { ...validImage, sha256: 'abc' } }))).toContain(
      'image-hash-invalid',
    );
    expect(codes(authored({ image: { ...validImage, sha256: 'A'.repeat(64) } }))).toContain(
      'image-hash-invalid',
    );
  });

  it('requires alt text', () => {
    expect(codes(authored({ image: { ...validImage, alt: '' } }))).toContain('text-empty');
  });
});

describe('action', () => {
  it('accepts a route action pointing at a declared screen', () => {
    expect(
      authored({ action: { type: 'route', label: 'Open Reports', target: 'tools.reports' } }),
    ).toBeClean();
  });

  it('rejects a route target that is not in the closed list', () => {
    // The security rule: an action may only name a screen the app declared.
    for (const target of [
      'tools.factory-reset',
      'ruood-lab://tools/reports',
      'https://example.com',
      '../admin',
      '',
    ]) {
      const result = authored({ action: { type: 'route', label: 'Go', target } });
      expect(codes(result)).toContain('action-target-not-allowed');
    }
  });

  it('rejects an unknown action type', () => {
    const result = authored({ action: { type: 'deeplink', label: 'Go', target: 'x' } });
    expect(codes(result)).toContain('unknown-enum-value');
  });

  it('accepts an https external link to an allowlisted host', () => {
    const result = validateAnnouncementRecord(
      {
        ...authoredRecord(),
        action: { type: 'external', label: 'Release notes', target: 'https://github.com/ruood' },
      },
      { now: NOW, mode: 'authored', externalHostAllowlist: ['github.com'] },
    );
    expect(result).toBeClean();
  });

  it.each([
    ['http://github.com', 'plain http'],
    ['https://evil.example', 'a host off the allowlist'],
    ['https://github.com@evil.example', 'credentials that disguise the real host'],
    ['data:text/html,<script>', 'a data URL'],
    ['ruood-lab://settings', 'an app scheme'],
    ['javascript:alert(1)', 'a javascript URL'],
  ])('rejects %s (%s)', (target) => {
    const result = validateAnnouncementRecord(
      { ...authoredRecord(), action: { type: 'external', label: 'Go', target } },
      { now: NOW, mode: 'authored', externalHostAllowlist: ['github.com'] },
    );
    expect(codes(result)).toContain('action-url-not-allowed');
  });

  it('bounds the action label', () => {
    const result = authored({
      action: { type: 'route', label: 'a'.repeat(25), target: 'tools.reports' },
    });
    expect(codes(result)).toContain('text-too-long');
  });
});

describe('signature', () => {
  it('accepts null, which is what v1 always writes', () => {
    expect(authored({ signature: null })).toBeClean();
  });

  it('accepts a string, so Phase 3 needs no schema change', () => {
    expect(authored({ signature: 'ed25519:abc' })).toBeClean();
  });

  it('rejects a non-string', () => {
    expect(codes(authored({ signature: 42 }))).toContain('wrong-type');
  });
});

describe('deriveLifecycleStatus', () => {
  const base = { startAt: iso(NOW - DAY), endAt: iso(NOW + DAY) };

  it('reports the stored states verbatim', () => {
    expect(deriveLifecycleStatus({ ...base, status: 'draft' }, NOW)).toBe('draft');
    expect(deriveLifecycleStatus({ ...base, status: 'archived' }, NOW)).toBe('archived');
    expect(deriveLifecycleStatus({ ...base, status: 'paused' }, NOW)).toBe('paused');
  });

  it('derives scheduled, active and expired from the dates', () => {
    const published = { status: 'published' as const };
    expect(
      deriveLifecycleStatus({ ...published, startAt: iso(NOW + DAY), endAt: null }, NOW),
    ).toBe('scheduled');
    expect(deriveLifecycleStatus({ ...published, ...base }, NOW)).toBe('active');
    expect(
      deriveLifecycleStatus(
        { ...published, startAt: iso(NOW - 2 * DAY), endAt: iso(NOW - DAY) },
        NOW,
      ),
    ).toBe('expired');
  });

  it('treats a null end date as never expiring', () => {
    expect(
      deriveLifecycleStatus({ status: 'published', startAt: iso(NOW - DAY), endAt: null }, NOW),
    ).toBe('active');
  });

  it('is a pure function of the injected now', () => {
    const record = { status: 'published' as const, startAt: iso(NOW), endAt: iso(NOW + DAY) };
    expect(deriveLifecycleStatus(record, NOW - 1)).toBe('scheduled');
    expect(deriveLifecycleStatus(record, NOW)).toBe('active');
    expect(deriveLifecycleStatus(record, NOW + DAY)).toBe('expired');
  });
});

describe('editingId excuses a record only for colliding with itself', () => {
  const registry = { active: ['reports-center-launch'], retired: ['reports-center-launch'] };

  it('still reports a retired id when the record is being edited', () => {
    // Found by the Phase 1 pipeline tests: skipping the whole availability
    // check for the record being edited let a retired id return through an
    // ordinary edit, and a reused id inherits impression counts on every device.
    const result = validateAnnouncementRecord(authoredRecord(), {
      now: NOW,
      mode: 'authored',
      idRegistry: registry,
      editingId: 'reports-center-launch',
    });
    expect(codes(result)).toContain('id-retired');
  });

  it('still excuses the duplicate when the id is not retired', () => {
    const result = validateAnnouncementRecord(authoredRecord(), {
      now: NOW,
      mode: 'authored',
      idRegistry: { active: ['reports-center-launch'], retired: [] },
      editingId: 'reports-center-launch',
    });
    expect(result).toBeClean();
  });
});
