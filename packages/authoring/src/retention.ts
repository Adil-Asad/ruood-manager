/**
 * How many announcements stay published.
 *
 * ## What the setting is for
 *
 * `content/` is history and grows for ever — that is deliberate, and it is what
 * gives the Manager a `git log` of everything that was ever announced. `dist/`
 * is not history. Every install downloads it, parses it, and holds it in
 * memory, so an announcement that nobody will ever be shown again costs every
 * device bytes for as long as it stays in the file.
 *
 * The retention limit is the line between the two: **the newest N of the
 * records that would otherwise be published, and nothing older.** The rest stay
 * exactly where they are in `content/`, editable, readable and reversible —
 * raising the limit brings them straight back.
 *
 * ## Why the bounds are these numbers
 *
 * `MANIFEST_MAX_RECORDS` is the schema's own hard cap: a manifest with more
 * records than that is refused by the validator, on the publisher AND on every
 * client. A retention limit above it could therefore never be satisfied — the
 * build would produce a file it then refuses — so it is the maximum here too,
 * imported rather than repeated so the two cannot drift apart.
 *
 * Zero is not a limit, it is a kill switch, and there is already one of those:
 * `paused` at the manifest root, which suppresses everything without deleting
 * anything. A retention limit of zero would publish an empty file and look
 * identical on a device to an outage, so the minimum is one.
 *
 * ## Why it lives in this package
 *
 * The phone offers the setting, the CLI offers the setting, and the build
 * enforces it. Three callers, one set of bounds — the same reason
 * `createRecord` and `applyEdits` are here rather than copied into each front
 * end. A second opinion about the maximum would show up as a value the phone
 * accepts and the build refuses.
 */

import { MANIFEST_MAX_RECORDS } from '@ruood/announcement-schema';

/** One. Zero is the kill switch, not a limit — see the header. */
export const RETENTION_MIN = 1;

/** The schema's own cap. Publishing more is refused by the validator anyway. */
export const RETENTION_MAX = MANIFEST_MAX_RECORDS;

/**
 * What a repository retains when it has never said.
 *
 * Twenty rather than the maximum: the point of the setting is a small payload,
 * and a default that sat at the cap would mean nobody got the benefit until
 * they went looking for a setting they did not know existed. Twenty is more
 * announcements than any install will ever have unread, and well under the
 * manifest's byte budget even with an image on every one of them.
 */
export const DEFAULT_MAX_RETAINED = 20;

/** Whether a value is a usable limit: a whole number, in range. */
export function isRetentionLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= RETENTION_MIN &&
    value <= RETENTION_MAX
  );
}

/**
 * A stored value as a limit, falling back to the default.
 *
 * Deliberately forgiving, and only in the safe direction: a settings file that
 * has been hand-edited into nonsense produces the default, which publishes
 * FEWER records than an unbounded build would. The alternative — refusing to
 * build — would take publishing down over a number that has no bearing on
 * whether any individual announcement is correct.
 *
 * This is not the same judgement as `retired-ids.json`, which throws. That
 * ledger failing open would let an id be reused; this one failing open costs
 * nothing that cannot be fixed by setting it again.
 */
export function normaliseRetentionLimit(value: unknown): number {
  return isRetentionLimit(value) ? value : DEFAULT_MAX_RETAINED;
}

/**
 * Typed text as a limit, or `null` if it is not one.
 *
 * `null` rather than a clamp, because this is what a person just typed: a form
 * that silently turned 500 into 50 would be deciding something on their behalf
 * and showing them a number they did not choose.
 */
export function parseRetentionLimit(text: string): number | null {
  const trimmed = text.trim();
  // `Number` would accept '1e2', ' 12 ' and '0x10'. A limit is digits.
  if (!/^\d+$/.test(trimmed)) return null;

  const value = Number(trimmed);
  return isRetentionLimit(value) ? value : null;
}

/** Why a limit was refused, in words an administrator can act on. */
export function retentionLimitProblem(text: string): string | null {
  return parseRetentionLimit(text) === null
    ? `Enter a whole number between ${RETENTION_MIN} and ${RETENTION_MAX}.`
    : null;
}
