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
import { isRetentionLimit } from '@ruood/announcement-authoring';

export type ExclusionReason =
  | 'draft'
  | 'archived'
  | 'expired'
  | 'unreadable-dates'
  /** Older than the newest N the repository retains. See `applyRetention`. */
  | 'retention';

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

  /**
   * How many records this manifest may carry. Omit it and every eligible
   * record is published, which is what every build did before the setting
   * existed.
   *
   * It is applied AFTER the exclusions above, so drafts, archived and expired
   * records never take up one of the places — the limit governs what is
   * published, not what exists.
   */
  maxRetained?: number;
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
  const eligible: AuthoredAnnouncement[] = [];
  const excluded: ExcludedRecord[] = [];

  for (const record of records) {
    const reason = exclusionFor(record, options.now, options.includeDrafts);
    if (reason) {
      excluded.push({ id: record.id, reason });
      continue;
    }
    eligible.push(record);
  }

  // The retention window, applied to what would otherwise be published.
  const { kept, dropped } = applyRetention(eligible, options.maxRetained);
  for (const record of dropped) excluded.push({ id: record.id, reason: 'retention' });

  return {
    manifest: {
      schemaVersion: 1,
      revision: options.revision,
      generatedAt: canonicalNow(options.now),
      paused: options.paused ?? false,
      announcements: kept.map(toPublished).sort(byPresentationOrder),
    },
    excluded,
  };
}

export interface RetentionResult {
  /** Published. In the order they were given. */
  kept: AuthoredAnnouncement[];
  /** Not published, and not changed either. Newest first. */
  dropped: AuthoredAnnouncement[];
}

/**
 * The newest `limit` records, and the ones that fall outside the window.
 *
 * ## It only ever removes
 *
 * Nothing here writes, stamps, archives or transitions anything. A record that
 * falls outside the window keeps its stored status exactly as the administrator
 * left it, and the file in `content/` is untouched — which is what makes
 * raising the limit put an announcement straight back, and what makes it
 * impossible for retention to REACTIVATE something that was deliberately
 * paused. A paused record inside the window is still published carrying
 * `paused: true`; a paused record outside it is simply not published. Neither
 * case changes the record.
 *
 * ## What "newest" means
 *
 * `publishedAt` when the record has one, and `startAt` otherwise. The first is
 * when the announcement was published and is stamped once and never again, so
 * it is the order an administrator means by "the last five announcements". The
 * second covers drafts, which have never been published and only reach a
 * manifest on the staging channel.
 *
 * Ties fall through to `startAt` and then to the id, so the same repository
 * always retains the same set. The id tiebreak is deterministic rather than
 * meaningful — it exists so that a build is reproducible, which the dry-run
 * diff and the signature both depend on.
 *
 * Note that this is NOT `byPresentationOrder`. That sorts by priority, which is
 * about which announcement a client shows first among several it could show;
 * retention is about age. Sorting the window by priority would let a
 * high-priority announcement from a year ago hold a place against this week's.
 */
export function applyRetention(
  records: readonly AuthoredAnnouncement[],
  limit?: number,
): RetentionResult {
  // An unset or unusable limit retains everything, which is what every build
  // did before the setting existed. The caller normalises; this is the floor
  // under a bad call site.
  if (!isRetentionLimit(limit) || records.length <= limit) {
    return { kept: [...records], dropped: [] };
  }

  const newestFirst = [...records].sort(byRecency);
  const keep = new Set(newestFirst.slice(0, limit).map((record) => record.id));

  return {
    // Filtered from the input, so the retained set arrives in the order it was
    // given and the caller's own sort decides the manifest.
    kept: records.filter((record) => keep.has(record.id)),
    dropped: newestFirst.slice(limit),
  };
}

/** Newest first. See `applyRetention` for why it is not the presentation order. */
function byRecency(a: AuthoredAnnouncement, b: AuthoredAnnouncement): number {
  const recencyA = recencyOf(a);
  const recencyB = recencyOf(b);
  if (recencyA !== recencyB) return recencyB - recencyA;

  const startA = instantToEpoch(a.startAt) ?? 0;
  const startB = instantToEpoch(b.startAt) ?? 0;
  if (startA !== startB) return startB - startA;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * When the announcement entered the world.
 *
 * `publishedAt` is absent on a draft and can be absent on a record written by
 * an older tool, so `startAt` stands in — it is required, and every record that
 * reaches here has already had it parsed by `exclusionFor`.
 */
function recencyOf(record: AuthoredAnnouncement): number {
  const published = record.publishedAt ? instantToEpoch(record.publishedAt) : null;
  return published ?? instantToEpoch(record.startAt) ?? 0;
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
