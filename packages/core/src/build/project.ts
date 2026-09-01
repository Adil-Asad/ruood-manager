/**
 * The build's core: authored records in, a manifest out.
 *
 * A pure projection, with no filesystem and no clock of its own, because this
 * is the step that decides what every install will see and it has to be
 * testable to the record. Everything impure — reading `content/`, encoding
 * images, writing `dist/` — happens around it.
 *
 * An authored record is a SUPERSET of a published one, so this strips fields
 * rather than translating them. That is what stops the two shapes drifting: a
 * new published field needs no work here at all, and a new authoring field
 * needs one entry in the strip list.
 */

import {
  instantToEpoch,
  type AnnouncementManifest,
  type AuthoredAnnouncement,
  type PublishedAnnouncement,
} from '@ruood/announcement-schema';

export type ExclusionReason =
  | 'draft'
  | 'archived'
  | 'expired'
  | 'unreadable-dates';

export interface ExcludedRecord {
  id: string;
  reason: ExclusionReason;
}

export interface ProjectionOptions {
  now: number;
  revision: number;
  /** The global kill switch. */
  paused?: boolean;
  /**
   * Include drafts. True only for the staging channel.
   *
   * This is the whole point of staging: seeing an announcement on a real device
   * before deciding it is ready. A staging manifest that excluded drafts the
   * way production does would be a copy of production and worth nothing.
   *
   * Archived and expired records stay excluded from both. Neither is something
   * you are trying to preview — one is deliberately retired and the other can
   * never be shown again.
   */
  includeDrafts?: boolean;
}

export interface ProjectionResult {
  manifest: AnnouncementManifest;
  excluded: ExcludedRecord[];
}

/**
 * Fields that exist only in `content/`.
 *
 * Listed once, here, and asserted against the type in the tests — so a field
 * added to `AuthoredAnnouncement` without being added here is caught rather
 * than quietly published.
 */
export const AUTHORED_ONLY_KEYS = [
  'status',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'archivedAt',
  'internalNote',
] as const;

export function projectManifest(
  records: readonly AuthoredAnnouncement[],
  options: ProjectionOptions,
): ProjectionResult {
  const included: PublishedAnnouncement[] = [];
  const excluded: ExcludedRecord[] = [];

  for (const record of records) {
    const reason = exclusionFor(record, options.now, options.includeDrafts);
    if (reason) {
      excluded.push({ id: record.id, reason });
      continue;
    }
    included.push(toPublished(record));
  }

  return {
    manifest: {
      schemaVersion: 1,
      revision: options.revision,
      generatedAt: canonicalNow(options.now),
      paused: options.paused ?? false,
      announcements: included.sort(byPresentationOrder),
    },
    excluded,
  };
}

/**
 * Why a record is not published, or `null` if it is.
 *
 * An **expired** record drops out of `dist/` immediately rather than lingering
 * on a grace period: it can never be shown again, so keeping it only costs
 * every install bytes. The device side is covered separately — a client keeps
 * its impression state for 60 days after an id stops appearing, so extending an
 * end date later brings the record back without re-showing it to anyone who had
 * already dismissed it.
 */
export function exclusionFor(
  record: AuthoredAnnouncement,
  now: number,
  includeDrafts = false,
): ExclusionReason | null {
  if (record.status === 'draft' && !includeDrafts) return 'draft';
  if (record.status === 'archived') return 'archived';

  const start = instantToEpoch(record.startAt);
  if (start === null) return 'unreadable-dates';

  if (record.endAt !== null && record.endAt !== undefined) {
    const end = instantToEpoch(record.endAt);
    if (end === null) return 'unreadable-dates';
    if (now >= end) return 'expired';
  }

  return null;
}

/**
 * Strips the authoring fields and stamps `paused` from the stored status.
 *
 * A paused record is PUBLISHED, carrying `paused: true` — not withheld. Keeping
 * it in the manifest means the client keeps its cached image, so reactivating
 * is instant rather than another download.
 */
export function toPublished(record: AuthoredAnnouncement): PublishedAnnouncement {
  const copy = { ...record } as Record<string, unknown>;

  for (const key of AUTHORED_ONLY_KEYS) {
    delete copy[key];
  }

  if (record.status === 'paused') {
    copy.paused = true;
  } else {
    // Never emit `paused: false` — it is the default, and an absent field is
    // one fewer byte on every install and one fewer line in every diff.
    delete copy.paused;
  }

  return copy as unknown as PublishedAnnouncement;
}

/**
 * Presentation order: highest priority first, then the earliest start, then the
 * id.
 *
 * Deterministic to the last tiebreak deliberately. The client sorts for itself
 * when choosing what to show, so this ordering is not load-bearing at runtime —
 * but a manifest whose record order wobbled between builds would produce a
 * meaningless diff on every publish.
 */
function byPresentationOrder(a: PublishedAnnouncement, b: PublishedAnnouncement): number {
  if (a.priority !== b.priority) return b.priority - a.priority;

  const startA = instantToEpoch(a.startAt) ?? 0;
  const startB = instantToEpoch(b.startAt) ?? 0;
  if (startA !== startB) return startA - startB;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function canonicalNow(now: number): string {
  return `${new Date(now).toISOString().slice(0, 19)}Z`;
}
