import { validateAnnouncementRecord } from '@ruood/announcement-schema';

import {
  applyTransition,
  availableTransitions,
  bumpRevision,
  createRecord,
  TransitionError,
  touch,
} from '../authoring';
import { DAY, NOW, authored, iso } from '../../__tests__/fixtures';

describe('createRecord', () => {
  const input = { id: 'new-thing', title: 'New thing', body: 'It is here.', now: NOW };

  it('produces a draft', () => {
    expect(createRecord(input).status).toBe('draft');
  });

  it('produces a record that validates, so a new draft never blocks a build', () => {
    const result = validateAnnouncementRecord(createRecord(input), {
      now: NOW,
      mode: 'authored',
    });
    expect(result.errors).toEqual([]);
  });

  it('defaults to next-launch, which never interrupts work in progress', () => {
    expect(createRecord(input).display.trigger).toBe('next-launch');
  });

  it('defaults to android and ios, leaving web to be opted into', () => {
    expect(createRecord(input).targeting.platforms).toEqual(['android', 'ios']);
  });

  it('stamps createdAt and updatedAt from the injected clock', () => {
    const record = createRecord(input);
    expect(record.createdAt).toBe('2026-09-15T12:00:00Z');
    expect(record.updatedAt).toBe(record.createdAt);
  });

  it('defaults to no end date, and takes one when given', () => {
    expect(createRecord(input).endAt).toBeNull();
    expect(createRecord({ ...input, endAt: iso(NOW + DAY) }).endAt).toBe(iso(NOW + DAY));
  });
});

describe('the transition table', () => {
  it.each([
    ['draft', ['publish', 'archive']],
    ['published', ['pause', 'archive']],
    ['paused', ['resume', 'archive']],
    ['archived', ['restore']],
  ])('offers the right transitions from %s', (status, expected) => {
    expect(availableTransitions(authored({ status: status as never }))).toEqual(expected);
  });

  it.each([
    ['draft', 'pause'],
    ['draft', 'resume'],
    ['published', 'publish'],
    ['published', 'resume'],
    ['archived', 'publish'],
    ['archived', 'pause'],
  ])('refuses %s -> %s', (status, transition) => {
    expect(() =>
      applyTransition(authored({ status: status as never }), transition as never, NOW),
    ).toThrow(TransitionError);
  });

  it('names what is available when it refuses', () => {
    expect(() => applyTransition(authored({ status: 'archived' }), 'publish', NOW)).toThrow(
      /Available: restore/,
    );
  });
});

describe('applying a transition', () => {
  it('publishes a draft and stamps publishedAt', () => {
    const next = applyTransition(authored({ status: 'draft', publishedAt: null }), 'publish', NOW);
    expect(next.status).toBe('published');
    expect(next.publishedAt).toBe('2026-09-15T12:00:00Z');
  });

  it('keeps the original publishedAt across a pause and resume', () => {
    // It is the record's own history — git already has the commit dates.
    const first = authored({ status: 'paused', publishedAt: iso(NOW - 10 * DAY) });
    const resumed = applyTransition(first, 'resume', NOW);
    expect(resumed.publishedAt).toBe(iso(NOW - 10 * DAY));
  });

  it('archives with a timestamp and restores to draft, clearing it', () => {
    const archived = applyTransition(authored(), 'archive', NOW);
    expect(archived).toMatchObject({ status: 'archived', archivedAt: '2026-09-15T12:00:00Z' });

    const restored = applyTransition(archived, 'restore', NOW);
    // Draft, not published: its dates are probably in the past and it should
    // pass validation again before it reaches an install.
    expect(restored).toMatchObject({ status: 'draft', archivedAt: null });
  });

  it('always moves updatedAt', () => {
    const next = applyTransition(authored({ status: 'draft' }), 'publish', NOW + DAY);
    expect(next.updatedAt).toBe(iso(NOW + DAY));
  });

  it('never mutates the record it was given', () => {
    const record = authored({ status: 'draft' });
    applyTransition(record, 'publish', NOW);
    expect(record.status).toBe('draft');
  });
});

describe('bumpRevision', () => {
  it('increments rev', () => {
    expect(bumpRevision(authored({ rev: 3 }), NOW).rev).toBe(4);
  });

  it('changes nothing else but updatedAt', () => {
    const before = authored({ rev: 1 });
    const after = bumpRevision(before, NOW + DAY);
    expect({ ...after, rev: before.rev, updatedAt: before.updatedAt }).toEqual(before);
  });

  it('is separate from every other edit, so a typo fix does not re-show', () => {
    const edited = touch(authored({ rev: 2 }), { body: 'Corrected.' }, NOW);
    expect(edited.rev).toBe(2);
  });
});
