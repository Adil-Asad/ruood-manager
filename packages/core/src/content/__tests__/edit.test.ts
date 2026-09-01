import { validateAnnouncementRecord } from '@ruood/announcement-schema';

import { applyEdits, EDITABLE_FIELDS, EditError, isEditableField } from '../edit';
import { DAY, NOW, authored, iso } from '../../__tests__/fixtures';

describe('applyEdits', () => {
  it('writes the fields it is given and leaves the rest alone', () => {
    const record = authored();
    const next = applyEdits(record, { title: 'Reports', priority: 80 }, NOW);

    expect(next.title).toBe('Reports');
    expect(next.priority).toBe(80);
    expect(next.body).toBe(record.body);
    expect(next.display).toEqual(record.display);
  });

  it('stamps updatedAt from the injected clock', () => {
    expect(applyEdits(authored(), { title: 'x' }, NOW).updatedAt).toBe('2026-09-15T12:00:00Z');
  });

  it('does not mutate the record it was given', () => {
    const record = authored();
    applyEdits(record, { title: 'Something else' }, NOW);
    expect(record.title).toBe('Reports Center');
  });

  it('ignores a field explicitly set to undefined, so "not sent" is "not changed"', () => {
    const next = applyEdits(authored(), { title: undefined }, NOW);
    expect(next.title).toBe('Reports Center');
  });

  it('produces a record that still validates', () => {
    const next = applyEdits(authored(), { body: 'A shorter body.', priority: 10 }, NOW);
    expect(validateAnnouncementRecord(next, { now: NOW, mode: 'authored' }).errors).toEqual([]);
  });
});

describe('the editable set is closed', () => {
  // The three that each have their own operation, and the reason each is
  // separate is a rule the architecture leans on rather than a preference.
  it.each([
    ['id', 'immutable'],
    ['status', 'applyTransition'],
    ['rev', 'bumpRevision'],
  ])('refuses %s and says what to use instead', (field, mention) => {
    expect(() => applyEdits(authored(), { [field]: 'x' } as never, NOW)).toThrow(EditError);

    try {
      applyEdits(authored(), { [field]: 'x' } as never, NOW);
    } catch (error) {
      expect((error as EditError).field).toBe(field);
      expect((error as EditError).message).toContain(mention);
    }
  });

  it.each(['createdAt', 'updatedAt', 'publishedAt', 'archivedAt', 'signature', 'minSchema'])(
    'refuses %s',
    (field) => {
      expect(() => applyEdits(authored(), { [field]: 'x' } as never, NOW)).toThrow(EditError);
    },
  );

  it('refuses rather than dropping, so a caller is never told it saved something it did not', () => {
    // The distinction this test exists for: a silent drop looks like success.
    expect(() => applyEdits(authored(), { rev: 9 } as never, NOW)).toThrow();
  });

  it('reports which fields are editable', () => {
    expect(isEditableField('title')).toBe(true);
    expect(isEditableField('status')).toBe(false);
    expect(EDITABLE_FIELDS).toContain('targeting');
    expect(EDITABLE_FIELDS).not.toContain('rev');
  });
});

describe('clearing an optional field', () => {
  it('removes an action when it is set to null', () => {
    const record = authored({
      action: { type: 'route', label: 'Open Tools', target: 'app.tools' },
    });

    const next = applyEdits(record, { action: null }, NOW);

    // Removed, not set to null — a null would serialise into content/ and the
    // published record would carry a field the client has to ignore.
    expect('action' in next).toBe(false);
  });

  it('removes an internal note when it is set to null', () => {
    const next = applyEdits(authored({ internalNote: 'ask marketing' }), { internalNote: null }, NOW);
    expect('internalNote' in next).toBe(false);
  });

  it('detaches an image when it is set to null', () => {
    const record = authored({
      image: {
        path: 'images/reports-center-a1b2c3d4.webp',
        width: 1080,
        height: 720,
        bytes: 40_000,
        sha256: 'a'.repeat(64),
        alt: 'The Reports screen',
      },
    });

    expect('image' in applyEdits(record, { image: null }, NOW)).toBe(false);
  });

  it('keeps endAt: null as a value — it means "no end date", not "remove"', () => {
    const next = applyEdits(authored(), { endAt: null }, NOW);
    expect(next.endAt).toBeNull();
    expect('endAt' in next).toBe(true);
  });

  it('takes a new end date', () => {
    expect(applyEdits(authored(), { endAt: iso(NOW + 30 * DAY) }, NOW).endAt).toBe(
      iso(NOW + 30 * DAY),
    );
  });
});
