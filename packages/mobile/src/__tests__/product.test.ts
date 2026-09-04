/**
 * The product layer: the words the administrator reads, and the id they never
 * have to invent.
 *
 * These are the pieces that turn the system's vocabulary into the product's,
 * and they are worth testing precisely because nothing else can catch them. A
 * screen that leaks `ECONNREFUSED` still compiles, still passes a typecheck,
 * still renders — and is a broken product. So the translation is pure, lives in
 * one module, and is pinned here.
 *
 * The screens themselves are not rendered. `jest.config.js` here is node-only,
 * deliberately, and the alternative — pulling in a React Native test renderer
 * to assert that a button says "Publish" — would be a large amount of machinery
 * to test a string literal. What IS testable is every decision behind those
 * strings, and that is what this file covers.
 */

import { ApiFailure, ConnectionFailure } from '@ruood/announcement-client';
import { ID_MAX_LENGTH, ID_MIN_LENGTH, LIFECYCLE_STATUSES } from '@ruood/announcement-schema';

import {
  DELIVERY_LABELS,
  deliveryOf,
  explainStatus,
  fileSize,
  humanise,
  statusOf,
  surfaceFor,
} from '../language';
import { idFromTitle, availableId } from '../ids';

// ---------------------------------------------------------------------------
// §25 — no raw error ever reaches an administrator
// ---------------------------------------------------------------------------

describe('error messages', () => {
  /**
   * The list from §25, verbatim. Every one of these was a thing the old app
   * could put on a phone screen.
   */
  const FORBIDDEN = [
    'EADDRINUSE',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOENT',
    'signature verification failed',
    'Git push rejected',
    'fatal: not a git repository',
    'sharp: input file is missing',
    'Error: connect ECONNREFUSED 127.0.0.1:4874',
    '{"error":"boom"}',
    'at Object.<anonymous> (index.js:1:1)',
  ];

  it.each(FORBIDDEN)('never shows %s to an administrator', (raw) => {
    const shown = humanise(new Error(raw));

    expect(shown).not.toContain(raw);
    // And what it shows instead is a sentence, not an empty string.
    expect(shown.length).toBeGreaterThan(10);
    expect(shown).toMatch(/[.!?]$/);
  });

  it('never shows a status code on its own', () => {
    for (const status of [400, 403, 404, 409, 415, 500, 502, 503]) {
      const shown = humanise(new ApiFailure(status, `Request failed with status ${status}`));
      expect(shown).not.toContain(String(status));
    }
  });

  it('says the session expired, in those words', () => {
    // The exact sentence §25 asks for. An administrator who sees this needs to
    // know to log in again, and nothing else.
    expect(humanise(new ApiFailure(401, 'Unauthorized'))).toBe(
      'Your session has expired. Please log in again.',
    );
    expect(humanise(new ApiFailure(403, 'Forbidden'))).not.toContain('403');
  });

  it('names the next action when the Manager cannot be reached', () => {
    const shown = humanise(new ConnectionFailure('http://192.168.1.5:4874', new Error('boom')));

    // The commonest failure on a phone. It must not mention the address, the
    // port, or what a Manager is.
    expect(shown).not.toContain('192.168');
    expect(shown).not.toContain('4874');
    expect(shown.toLowerCase()).toContain('try again');
  });

  it('passes a validator refusal through, because it was written for a person', () => {
    const failure = new ApiFailure(422, 'The record was refused.', [
      {
        code: 'image-too-large',
        path: 'image.bytes',
        message: 'The image is 900000 bytes; the publish limit is 153600.',
        severity: 'error',
      } as never,
    ]);

    // A 4xx an administrator can act on keeps its own sentence — replacing it
    // with "something went wrong" would be hiding the one useful fact.
    expect(humanise(failure)).toContain('The image is');
  });

  it('keeps the throttle’s wait, which is the only useful part of a 429', () => {
    const failure = new ApiFailure(429, 'Too many failed attempts. Try again in 2 minutes.');
    expect(humanise(failure)).toContain('2 minutes');
  });

  it('falls back to a sentence for something entirely unrecognised', () => {
    expect(humanise(null)).toMatch(/[.!?]$/);
    expect(humanise(undefined)).toMatch(/[.!?]$/);
    expect(humanise({})).toMatch(/[.!?]$/);
  });
});

// ---------------------------------------------------------------------------
// §19, §33 — the status vocabulary
// ---------------------------------------------------------------------------

describe('the status words', () => {
  it('has a word for every lifecycle state the schema can produce', () => {
    // Total, deliberately. A state added to the contract that fell through to a
    // default would render as the wrong word rather than as a failure.
    for (const lifecycle of LIFECYCLE_STATUSES) {
      expect(statusOf(lifecycle)).toBeTruthy();
      expect(explainStatus(lifecycle)).toBeTruthy();
    }
  });

  it('uses only the words §19 lists', () => {
    const words = LIFECYCLE_STATUSES.map((lifecycle) => statusOf(lifecycle));

    expect(new Set(words)).toEqual(
      new Set(['Draft', 'Scheduled', 'Active', 'Inactive', 'Expired', 'Archived']),
    );
  });

  it('calls `paused` Inactive, not Paused', () => {
    // "Paused" invites "paused until when?", which has no answer. Inactive is a
    // state somebody switches back on — which is exactly what it is.
    expect(statusOf('paused')).toBe('Inactive');
  });

  it('explains each state from the RUOOD user’s point of view', () => {
    // Every explanation answers "who can see this, and when" — the only
    // question an administrator is actually asking.
    expect(explainStatus('active').toLowerCase()).toContain('now');
    expect(explainStatus('draft').toLowerCase()).toContain('only you');
    expect(explainStatus('paused').toLowerCase()).toContain('nobody');
  });

  it('never uses repository vocabulary in anything an administrator reads', () => {
    const everything = [
      ...LIFECYCLE_STATUSES.map(statusOf),
      ...LIFECYCLE_STATUSES.map(explainStatus),
      DELIVERY_LABELS.active.title,
      DELIVERY_LABELS.active.detail,
      DELIVERY_LABELS.passive.title,
      DELIVERY_LABELS.passive.detail,
    ].join(' ');

    // §33's bad list. `manifest`, `revision`, `commit`, `staging` and the rest
    // are all true and all meaningless to the reader.
    expect(everything).not.toMatch(
      /\b(manifest|revision|commit|git|repository|staging|signing key|surface|sha256)\b/i,
    );
  });
});

// ---------------------------------------------------------------------------
// §12 — active and passive is `surface`, and no other field
// ---------------------------------------------------------------------------

describe('delivery', () => {
  it('maps onto `surface` and nothing else', () => {
    expect(surfaceFor('active')).toBe('modal');
    expect(surfaceFor('passive')).toBe('inbox');
  });

  it('round-trips, so an edited announcement keeps the choice it was given', () => {
    expect(deliveryOf(surfaceFor('active'))).toBe('active');
    expect(deliveryOf(surfaceFor('passive'))).toBe('passive');
  });

  it('reads `banner` as active, because it is presented', () => {
    // The form offers two choices and the schema has three surfaces. A record
    // created on the desktop Manager as a banner must not read as passive here
    // — it interrupts, which is what "active" means to the administrator.
    expect(deliveryOf('banner')).toBe('active');
  });

  it('describes each choice without naming a schema field', () => {
    // `surface`, `modal` and `banner` are the contract's words. "Inbox" is NOT
    // on that list even though it is also a surface value — it is the name of a
    // thing the RUOOD user can actually see, in Settings, and inventing a
    // second word for one feature would be worse than reusing the right one.
    expect(DELIVERY_LABELS.active.detail).not.toMatch(/\bsurface\b|\bmodal\b|\bbanner\b/i);
    expect(DELIVERY_LABELS.passive.detail).not.toMatch(/\bsurface\b|\bmodal\b|\bbanner\b/i);
    expect(DELIVERY_LABELS.passive.detail.toLowerCase()).toContain('inbox');
  });
});

// ---------------------------------------------------------------------------
// §11 — the id is generated, and it is still a legal id
// ---------------------------------------------------------------------------

describe('generated ids', () => {
  const NOW = Date.parse('2026-09-15T12:34:00Z');

  /** Exactly what `checkIdFormat` accepts: lowercase words, single hyphens. */
  const LEGAL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  it.each([
    ['Ramadan Schedule', 'ramadan-schedule'],
    ['Reports Center is here!', 'reports-center-is-here'],
    ['  Spaced   out  ', 'spaced-out'],
    ['Version 2.5.0 released', 'version-2-5-0-released'],
    ['UPPERCASE TITLE', 'uppercase-title'],
  ])('turns %s into a readable id', (title, expected) => {
    expect(idFromTitle(title, NOW)).toBe(expected);
  });

  it('always produces something the validator will accept', () => {
    const titles = [
      'Ramadan Schedule',
      '🎉🎉🎉',
      '—',
      'a',
      'Réservé aux membres',
      'x'.repeat(200),
      '...---...',
      '',
    ];

    for (const title of titles) {
      const id = idFromTitle(title, NOW);

      expect(id).toMatch(LEGAL);
      expect(id.length).toBeGreaterThanOrEqual(ID_MIN_LENGTH);
      expect(id.length).toBeLessThanOrEqual(ID_MAX_LENGTH);
      // Never a trailing hyphen, which the slice to the length limit can leave.
      expect(id.endsWith('-')).toBe(false);
    }
  });

  it('strips accents rather than dropping the letters under them', () => {
    // "Réservé" must not become "rserv". Dropping combining marks after NFKD
    // is what keeps the id readable in a git log a year later.
    expect(idFromTitle('Réservé aux membres', NOW)).toBe('reserve-aux-membres');
  });

  it('falls back to something dated when a title leaves nothing', () => {
    expect(idFromTitle('🎉🎉🎉', NOW)).toBe('announcement-2026-09-15');
  });

  /** A registry with the given ids taken, and the given ones retired. */
  function registry(active: string[] = [], retired: string[] = []) {
    return { records: active.map((id) => ({ id })), retiredIds: retired };
  }

  it('takes the id when nothing has claimed it', () => {
    expect(availableId(registry(), 'Ramadan Schedule', NOW)).toBe('ramadan-schedule');
  });

  it('avoids an id that is already in use', () => {
    const id = availableId(registry(['ramadan-schedule']), 'Ramadan Schedule', NOW);

    expect(id).toBe('ramadan-schedule-2');
    expect(id).toMatch(LEGAL);
  });

  it('avoids an id that has been RETIRED, which is the one that matters', () => {
    // A reused id inherits the previous announcement's impression counters on
    // every device for sixty days, so the replacement silently fails to show
    // for exactly the users who were paying attention. Checking only for
    // duplicates would miss this entirely.
    const id = availableId(registry([], ['ramadan-schedule']), 'Ramadan Schedule', NOW);

    expect(id).not.toBe('ramadan-schedule');
    expect(id).toMatch(LEGAL);
  });

  it('keeps counting past a run of taken ids', () => {
    const taken = ['ramadan-schedule', 'ramadan-schedule-2', 'ramadan-schedule-3'];
    expect(availableId(registry(taken), 'Ramadan Schedule', NOW)).toBe('ramadan-schedule-4');
  });

  it('produces a legal id even when a long title is disambiguated', () => {
    // The suffix is appended after a slice to the length limit, which is
    // exactly where a trailing hyphen or an over-long id could sneak back in.
    const long = 'x'.repeat(200);
    const id = availableId(registry([idFromTitle(long, NOW)]), long, NOW);

    expect(id.length).toBeLessThanOrEqual(ID_MAX_LENGTH);
    expect(id).toMatch(LEGAL);
  });

  it('never returns an id that was in either list', () => {
    const active = ['notice', 'notice-2'];
    const retired = ['notice-3', 'notice-4'];

    const id = availableId(registry(active, retired), 'Notice', NOW);

    expect([...active, ...retired]).not.toContain(id);
    expect(id).toMatch(LEGAL);
  });
});

// ---------------------------------------------------------------------------
// §8 — the size report the administrator reads
// ---------------------------------------------------------------------------

describe('file sizes', () => {
  it('says sizes the way a person would', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(420 * 1024)).toBe('420 KB');
    expect(fileSize(Math.round(1.8 * 1024 * 1024))).toBe('1.8 MB');
  });
});
