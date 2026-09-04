/**
 * Making an id nobody has to think about.
 *
 * ## Why this exists
 *
 * An announcement id is permanent, never reused, and keys impression state on
 * every device for up to sixty days after the announcement itself is gone. It
 * is one of the most consequential fields in the contract — and §11 is right
 * that a non-technical administrator must never be asked to invent one.
 *
 * The consequences do not go away by hiding the field, so they are handled
 * here instead: the id is derived from the title, checked against the server's
 * registry, and a collision takes the server's own suggestion rather than
 * anything invented locally.
 *
 * ## Why derived from the title rather than random
 *
 * A random id would be simpler and would work. It would also make every commit
 * message in the announcements repository read `Publish a3f91c22`, and the
 * repository is the audit trail somebody reads a year later when they need to
 * know what went out and when. A readable id costs one function.
 */

import { ID_MAX_LENGTH, ID_MIN_LENGTH } from '@ruood/announcement-schema';

/**
 * A title, as an id.
 *
 * Lowercase words joined by single hyphens — which is exactly what
 * `checkIdFormat` requires, so this cannot produce something the validator will
 * refuse. Non-ASCII is dropped rather than transliterated: a transliteration
 * table is a large thing to get subtly wrong, and the fallback below covers
 * every case where dropping leaves nothing.
 */
export function idFromTitle(title: string, now: number): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    // Combining marks, so "Réservé" becomes "reserve" rather than "rserv".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX_LENGTH);

  const trimmed = slug.replace(/-+$/, '');

  // A title that is entirely emoji, or entirely non-Latin, leaves nothing. A
  // date-stamped fallback is still readable in a git log, which is the whole
  // reason ids are derived rather than random.
  if (trimmed.length < ID_MIN_LENGTH) {
    return `announcement-${new Date(now).toISOString().slice(0, 10)}`;
  }

  return trimmed;
}

/**
 * An id that is free.
 *
 * ## Why this no longer asks a server
 *
 * It used to call `/api/id-check`, because the server held both halves of the
 * answer: the records that exist and `content/retired-ids.json`. The phone now
 * holds both — `loadContent` reads the ledger and every record in one tree
 * listing — so the check is local, instant, and made against exactly the same
 * two facts.
 *
 * The RETIRED half is the one that matters. A reused id inherits the previous
 * announcement's impression counters on every device for the sixty-day
 * retention window, so the replacement silently fails to show for precisely the
 * users who were paying attention. Checking only for duplicates would miss it.
 *
 * The publishing workflow validates again against the same ledger, so a race
 * between two phones is refused there rather than shipped.
 */
export function availableId(
  registry: { records: { id: string }[]; retiredIds: string[] },
  title: string,
  now: number,
): string {
  const taken = new Set([...registry.records.map((record) => record.id), ...registry.retiredIds]);
  const wanted = idFromTitle(title, now);

  if (!taken.has(wanted)) return wanted;

  // A numeric suffix rather than a random one, so the second "Ramadan Schedule"
  // of the year is `ramadan-schedule-2` and still readable in a `git log`.
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${wanted.slice(0, ID_MAX_LENGTH - 4)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  // Ninety-eight announcements with one title is not a case worth a cleverer
  // answer than the clock.
  return `${wanted.slice(0, ID_MAX_LENGTH - 6)}-${new Date(now)
    .toISOString()
    .slice(11, 16)
    .replace(':', '')}`;
}
