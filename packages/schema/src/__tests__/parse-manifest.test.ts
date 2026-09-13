import { MANIFEST_MAX_BYTES } from '../constants';
import {
  parseManifest,
  parseManifestText,
  utf8ByteLength,
  verifyPublishable,
} from '../parse-manifest';
import { DAY, NOW, iso, loose, malformed, manifest, publishedRecord } from './fixtures';

const options = { now: NOW };

describe('never throws', () => {
  it.each([
    'not json at all',
    '{',
    '',
    'null',
    '[]',
    '42',
    '"a string"',
    '{"schemaVersion": "one"}',
  ])('survives the payload %p', (text) => {
    expect(() => parseManifestText(text, options)).not.toThrow();
    expect(parseManifestText(text, options).ok).toBe(false);
  });

  it.each([null, undefined, 42, 'text', [], {}, { announcements: null }])(
    'survives the decoded value %p',
    (value) => {
      expect(() => parseManifest(value, options)).not.toThrow();
      expect(parseManifest(value, options).ok).toBe(false);
    },
  );
});

describe('the envelope gate', () => {
  it('accepts a well-formed manifest', () => {
    const result = parseManifest(manifest(), options);
    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.announcements).toHaveLength(1);
    expect(result.ok && result.skipped).toHaveLength(0);
  });

  it('rejects a schema version from the future, whole', () => {
    // The one case where the entire file is refused: this build cannot know
    // what a v2 record means, so it must not act on any of it.
    const result = parseManifest(manifest([], { schemaVersion: 2 }), options);
    expect(result).toMatchObject({ ok: false, reason: 'schema-too-new' });
  });

  it('rejects a payload larger than the cap before parsing it', () => {
    const result = parseManifestText(JSON.stringify(manifest()), {
      ...options,
      receivedBytes: MANIFEST_MAX_BYTES + 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('reads a missing kill switch as "not paused"', () => {
    // Failing to the suppressed side would be worse than failing to the normal
    // side: a dropped field would silence every announcement.
    const value = loose(manifest());
    delete value.paused;
    const result = parseManifest(value, options);
    expect(result.ok && result.manifest.paused).toBe(false);
  });

  it('carries the kill switch through when it is set', () => {
    const result = parseManifest(manifest([], { paused: true }), options);
    expect(result.ok && result.manifest.paused).toBe(true);
  });
});

describe('one bad record does not poison the file', () => {
  it('keeps the good records and reports the dropped one', () => {
    const result = parseManifest(
      manifest([
        publishedRecord({ id: 'good-one' }),
        // Over the title limit — a record-level error whose path names `title`,
        // now that an EMPTY title is a legitimate image-only announcement.
        publishedRecord({ id: 'bad-one', title: 'a'.repeat(61) }),
        publishedRecord({ id: 'good-two' }),
      ]),
      options,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.announcements.map((a) => a.id)).toEqual([
      'good-one',
      'good-two',
    ]);
    expect(result.ok && result.skipped).toEqual([
      { index: 1, id: 'bad-one', reason: expect.stringContaining('title') },
    ]);
  });

  it('handles a record that is not an object at all', () => {
    const result = parseManifest(manifest([null as never, publishedRecord()]), options);
    expect(result.ok && result.manifest.announcements).toHaveLength(1);
    expect(result.ok && result.skipped[0]).toMatchObject({ index: 0, id: null });
  });
});

describe('fails closed on anything it cannot render', () => {
  it.each([
    ['an unknown surface', { display: { ...publishedRecord().display, surface: 'toast' } }],
    ['an unknown trigger', { display: { ...publishedRecord().display, trigger: 'asap' } }],
    ['an unknown dismiss rule', { display: { ...publishedRecord().display, dismiss: 'x' } }],
    ['an unknown category', { category: 'urgent' }],
    ['an unknown platform', { targeting: { ...publishedRecord().targeting, platforms: ['tv'] } }],
    ['an unknown action type', { action: { type: 'deeplink', label: 'Go', target: 'x' } }],
    ['a route outside the closed list', { action: { type: 'route', label: 'Go', target: 'tools.factory-reset' } }],
    ['a minSchema from the future', { minSchema: 2 }],
  ])('skips a record with %s', (_label, override) => {
    const result = parseManifest(
      manifest([publishedRecord(override as never), publishedRecord({ id: 'sound-one' })]),
      options,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.announcements.map((a) => a.id)).toEqual(['sound-one']);
  });

  it('never substitutes a default for an unknown enum value', () => {
    const result = parseManifest(
      manifest([publishedRecord({ display: malformed({ ...publishedRecord().display, surface: 'toast' }) })]),
      options,
    );
    expect(result.ok && result.manifest.announcements).toHaveLength(0);
  });
});

describe('tolerates what forward compatibility requires', () => {
  it('keeps a record carrying an unknown optional field', () => {
    // A v2 field added later must not make a v1 client drop the record.
    const result = parseManifest(
      manifest([{ ...publishedRecord(), soundEffect: 'chime' } as never]),
      options,
    );
    expect(result.ok && result.manifest.announcements).toHaveLength(1);
  });

  it('keeps a record that has already expired', () => {
    // Eligibility is decided later; parsing is only about readability.
    const result = parseManifest(
      manifest([publishedRecord({ startAt: iso(NOW - 10 * DAY), endAt: iso(NOW - DAY) })]),
      options,
    );
    expect(result.ok && result.manifest.announcements).toHaveLength(1);
  });
});

describe('utf8ByteLength', () => {
  it('counts ASCII, multibyte and astral characters correctly', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('한')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
  });

  it('agrees with Buffer over a realistic manifest', () => {
    const serialised = JSON.stringify(manifest());
    expect(utf8ByteLength(serialised)).toBe(Buffer.byteLength(serialised, 'utf8'));
  });

  it('agrees with Buffer on mixed and lone-surrogate input', () => {
    for (const sample of ['naïve café 😀 한글', 'a\uD800b', '\uDC00']) {
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
    }
  });
});

describe('verifyPublishable', () => {
  it('passes a clean manifest', () => {
    const result = verifyPublishable(JSON.stringify(manifest()), options);
    expect(result.ok).toBe(true);
  });

  it('refuses a manifest the client would silently drop a record from', () => {
    // The rule the Manager exists to enforce: publishing runs the CLIENT's
    // reader over the exact bytes, so "valid but unreadable" cannot ship.
    const serialised = JSON.stringify(
      manifest([publishedRecord({ display: malformed({ ...publishedRecord().display, surface: 'toast' }) })]),
    );
    const result = verifyPublishable(serialised, options);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('silently skip');
  });

  it('refuses a manifest the client would reject outright', () => {
    const result = verifyPublishable(JSON.stringify(manifest([], { schemaVersion: 2 })), options);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('reject');
  });

  it('refuses malformed JSON', () => {
    expect(verifyPublishable('{', options).ok).toBe(false);
  });

  it('refuses a manifest with a duplicate id, which parsing alone would miss', () => {
    // parseManifest accepts both copies; only validateManifest catches it, so
    // this proves verifyPublishable really runs both.
    const serialised = JSON.stringify(manifest([publishedRecord(), publishedRecord()]));
    expect(parseManifestText(serialised, options).ok).toBe(true);
    expect(verifyPublishable(serialised, options).ok).toBe(false);
  });
});
