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
import { ConcurrentUpdate, DeviceFlowError, GitHubError } from '@ruood/announcement-github';
import { ID_MAX_LENGTH, ID_MIN_LENGTH, LIFECYCLE_STATUSES } from '@ruood/announcement-schema';

import {
  announcementLabel,
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

// ---------------------------------------------------------------------------
// An announcement may be a picture and nothing else
// ---------------------------------------------------------------------------

/**
 * Three places still need something to call it: a row in the list, the sentence
 * after a publish, and the commit message. A blank there reads as content that
 * failed to load, and none of these words is ever written into a record.
 */
describe('what to call an announcement with no title', () => {
  it('uses the title when there is one', () => {
    expect(announcementLabel({ title: 'Eid hours', body: 'Open until four.' })).toBe('Eid hours');
  });

  it('falls back to the message, on one line', () => {
    expect(announcementLabel({ title: '', body: 'Open until four.\nSee you there.' })).toBe(
      'Open until four. See you there.',
    );
  });

  it('says what a picture with no words is', () => {
    expect(announcementLabel({ title: '', body: '', image: true })).toBe('Image announcement');
    expect(announcementLabel({})).toBe('Untitled announcement');
  });

  it('never leaks the system’s vocabulary, like everything else on a screen', () => {
    for (const label of [
      announcementLabel({ title: '', body: '', image: true }),
      announcementLabel({}),
    ]) {
      expect(label).not.toMatch(/(git|commit|manifest|repository|sha256|blob)/i);
    }
  });
});

describe('file sizes', () => {
  it('says sizes the way a person would', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(420 * 1024)).toBe('420 KB');
    expect(fileSize(Math.round(1.8 * 1024 * 1024))).toBe('1.8 MB');
  });
});

// ---------------------------------------------------------------------------
// §25, for the errors Phase 8 actually produces
// ---------------------------------------------------------------------------

/**
 * The GitHub failures, swept the same way the `ApiFailure` ones are.
 *
 * The sweep above predates Phase 8 and covers `ApiFailure` — the Manager
 * SERVER's error type, from an architecture that no longer exists. `language.ts`
 * says of the branches below that they "are now the ones an administrator will
 * actually hit", and nothing was checking them: a raw GitHub message reaching a
 * phone would have compiled, typechecked, rendered and passed the whole suite.
 *
 * These are the paths a real administrator meets — a revoked token, an
 * uninstalled app, somebody else editing at the same time — so they get the
 * same guarantee: a sentence, no status code, no GitHub vocabulary.
 */
describe('GitHub failures reach the administrator as product language', () => {
  /** What GitHub actually puts in a message body, verbatim in shape. */
  const RAW_GITHUB = [
    'Bad credentials',
    'Resource not accessible by integration',
    'Not Found',
    'API rate limit exceeded for user ID 12345.',
    'Server Error',
    'Reference cannot be updated',
    'https://docs.github.com/rest/repos/contents#create-or-update-file-contents',
  ];

  it.each([401, 403, 404, 429, 500, 502, 503])(
    'never shows the raw status %s to an administrator',
    (status) => {
      const shown = humanise(new GitHubError(status, `Request failed with status ${status}`));

      expect(shown).not.toContain(String(status));
      expect(shown.length).toBeGreaterThan(10);
      expect(shown).toMatch(/[.!?]$/);
    },
  );

  it.each(RAW_GITHUB)('never passes GitHub\u2019s own wording through: %s', (raw) => {
    // 401 and 403 are mapped to fixed sentences; the point here is that the
    // GitHub text never survives into what is shown.
    for (const status of [401, 403, 404, 429, 500]) {
      expect(humanise(new GitHubError(status, raw))).not.toContain(raw);
    }
  });

  it('never leaks developer vocabulary out of a GitHub failure', () => {
    // The words §25 bans, checked against every mapped GitHub status rather
    // than against a hand-written example that could be the only one that
    // passes.
    const banned = /\b(api|http|endpoint|repository|repo|token|integration|rate limit exceeded|sha|blob|tree|ref|commit)\b/i;

    for (const status of [401, 403, 404, 429, 500, 502, 503]) {
      const shown = humanise(new GitHubError(status, 'Resource not accessible by integration'));
      expect(shown).not.toMatch(banned);
    }
  });

  it('says a revoked or expired sign-in in words that name the next action', () => {
    expect(humanise(new GitHubError(401, 'Bad credentials'))).toBe(
      'Your GitHub sign-in has expired. Please sign in again.',
    );
  });

  it('treats 403 and 404 as the same answer, because they are', () => {
    // A repository somebody cannot see answers 404, not 403. Telling them apart
    // would be telling them apart wrongly.
    const forbidden = humanise(new GitHubError(403, 'Resource not accessible by integration'));
    const missing = humanise(new GitHubError(404, 'Not Found'));

    expect(forbidden).toBe(missing);
    expect(forbidden).toContain('access');
  });

  it('explains a concurrent edit without mentioning what a commit is', () => {
    const shown = humanise(new ConcurrentUpdate());

    expect(shown).not.toMatch(/\b(commit|sha|ref|force|push|merge|conflict)\b/i);
    expect(shown).toMatch(/[.!?]$/);
    // It has to say that somebody else changed things, or it is not actionable.
    expect(shown.toLowerCase()).toContain('changed');
  });

  it('passes a device-flow sentence through, because it is already written for a person', () => {
    const shown = humanise(new DeviceFlowError('That code expired. Tap to get a new one.'));

    expect(shown).toBe('That code expired. Tap to get a new one.');
  });
});

/**
 * The status nothing maps, which is where a leak would actually happen.
 *
 * `humanise` maps 401, 403/404, 429 and 5xx to sentences. Everything else —
 * 422 above all, which is what the Git Data API answers when a blob, a tree or
 * a commit is refused — falls through to `safe()`, and `safe()` shows the
 * message unless `looksTechnical` recognises it.
 *
 * That list was written before Phase 8 and knew nothing about GitHub's
 * vocabulary, so these messages passed it: they contain no errno, no stack
 * frame, no bare status and no JSON. They would have been printed on the phone
 * exactly as GitHub wrote them.
 */
describe('an unmapped GitHub status never leaks GitHub\u2019s wording', () => {
  const UNMAPPED_422 = [
    "Invalid request. For 'properties/content', nil is not a string.",
    'Reference cannot be updated',
    'Reference does not exist',
    'tree.path contains a malformed path component',
    'No commit found for SHA: 0000000000000000000000000000000000000000',
    'Resource not accessible by integration',
    'Bad credentials',
  ];

  it.each(UNMAPPED_422)('replaces %s with a sentence', (raw) => {
    const shown = humanise(new GitHubError(422, raw));

    expect(shown).not.toContain(raw);
    expect(shown).toBe('Something went wrong. Please try again.');
  });

  it('still lets the VALIDATOR’s own sentence through, which is a different path', () => {
    // The gate must not become "hide everything". A validator sentence is
    // written for a person and is more useful than the generic fallback - but
    // it arrives as an ApiFailure, not a GitHubError, and that is exactly why
    // the two are treated differently.
    const human = 'That image is too large. Please choose a smaller one.';

    expect(humanise(new ApiFailure(422, human))).toBe(human);
  });
});
