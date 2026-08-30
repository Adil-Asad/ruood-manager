/**
 * Announcement ids.
 *
 * An id is the only thing that ties a record on a device to a record in the
 * repository, and the device state keyed by it (impression count, dismissal)
 * outlives the announcement by up to the retention grace period. Two rules
 * follow, and the second is the one that bites:
 *
 *   1. An id is immutable. Changing it produces a different announcement.
 *   2. An id is NEVER REUSED, including after the record is deleted. A reused
 *      id inherits the previous announcement's impression counters on every
 *      device that ever saw the original -- so the new message silently fails
 *      to show for the users most likely to be paying attention, and there is
 *      no feedback channel that would ever tell you.
 *
 * Rule 2 is why the repository keeps a retired-id ledger rather than deriving
 * "ids in use" from the files that still exist. A file that has been deleted
 * leaves nothing behind to check against.
 */

import { ID_MAX_LENGTH, ID_MIN_LENGTH } from './constants';

/**
 * Lowercase alphanumeric words joined by single hyphens.
 *
 * No leading, trailing or doubled hyphen -- an id appears in filenames and in
 * image paths, so it stays URL-safe and visually unambiguous.
 */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type IdProblem = 'format' | 'too-short' | 'too-long';

export interface IdCheckResult {
  ok: boolean;
  problem?: IdProblem;
}

export function checkIdFormat(value: unknown): IdCheckResult {
  if (typeof value !== 'string') return { ok: false, problem: 'format' };
  if (value.length < ID_MIN_LENGTH) return { ok: false, problem: 'too-short' };
  if (value.length > ID_MAX_LENGTH) return { ok: false, problem: 'too-long' };
  if (!ID_PATTERN.test(value)) return { ok: false, problem: 'format' };
  return { ok: true };
}

export function isValidId(value: unknown): value is string {
  return checkIdFormat(value).ok;
}

/**
 * The ids an announcement may not take.
 *
 * `active` is every id currently in `content/` -- drafts and archived records
 * included, because an archived announcement can be reactivated. `retired` is
 * the ledger of ids that have ever existed and been deleted.
 */
export interface IdRegistry {
  active: readonly string[];
  retired: readonly string[];
}

export type IdAvailability =
  | { available: true }
  | { available: false; reason: 'duplicate' | 'retired' };

export function checkIdAvailable(id: string, registry: IdRegistry): IdAvailability {
  if (registry.active.some((known) => known === id)) {
    return { available: false, reason: 'duplicate' };
  }
  if (registry.retired.some((known) => known === id)) {
    return { available: false, reason: 'retired' };
  }
  return { available: true };
}

/**
 * A candidate id from a title, for the Manager's "new announcement" form.
 *
 * A suggestion only -- the operator can always type their own, and this never
 * runs at publish time. Returns `null` when the title yields nothing usable
 * (an all-punctuation or non-Latin title), so the caller prompts rather than
 * publishing something like `a-1`.
 */
export function suggestId(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX_LENGTH)
    .replace(/-+$/g, '');

  return checkIdFormat(slug).ok ? slug : null;
}

/**
 * The first free id of the form `base`, `base-2`, `base-3`, ...
 *
 * Used only when suggesting; never applied automatically to a published
 * record, because an id that quietly became `reports-center-2` is an id the
 * operator did not intend and will not recognise later.
 */
export function nextAvailableId(base: string, registry: IdRegistry): string | null {
  if (!isValidId(base)) return null;
  if (checkIdAvailable(base, registry).available) return base;

  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, ID_MAX_LENGTH).replace(/-+$/g, '');
    if (isValidId(candidate) && checkIdAvailable(candidate, registry).available) {
      return candidate;
    }
  }

  return null;
}
