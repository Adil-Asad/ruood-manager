/**
 * The announcement data contract.
 *
 * Three shapes, and the difference between them is the whole design:
 *
 *   AuthoredAnnouncement   what lives in the announcements repo's `content/`.
 *                          Carries status and audit dates. Never leaves the repo.
 *
 *   PublishedAnnouncement  what the build emits into `dist/announcements.json`.
 *                          No status, no audit dates, no drafts, no archive --
 *                          only what a client can act on.
 *
 *   AnnouncementManifest   the published file itself.
 *
 * An authored record is a superset of a published one, so the build is a
 * projection rather than a translation. That is what stops the two drifting.
 */

import type { RouteTarget } from './routes';
import type {
  ACTION_TYPES,
  CATEGORIES,
  DISMISS_BEHAVIOURS,
  LIFECYCLE_STATUSES,
  PLATFORMS,
  STORED_STATUSES,
  SURFACES,
  TRIGGERS,
} from './constants';

export type Platform = (typeof PLATFORMS)[number];
export type Category = (typeof CATEGORIES)[number];
export type Surface = (typeof SURFACES)[number];
export type Trigger = (typeof TRIGGERS)[number];
export type DismissBehaviour = (typeof DISMISS_BEHAVIOURS)[number];
export type ActionType = (typeof ACTION_TYPES)[number];
export type StoredStatus = (typeof STORED_STATUSES)[number];
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/**
 * An absolute instant, ISO-8601, always with an explicit offset.
 *
 * Never a naive local string. "September 1, 9:00 AM" has no meaning in a file
 * read by devices in other timezones; the Manager resolves the author's local
 * intent to an instant at publish time and displays it back with its offset.
 */
export type Instant = string;

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * How, when and how often the announcement may be shown.
 *
 * These four fields are orthogonal on purpose. An earlier draft of the design
 * had a single `displayMode` enum mixing "not published yet", "starts later"
 * and "may interrupt the current session" -- three different axes, which meant
 * every combination had to be validated against the other two and half of them
 * were nonsense. Status covers the first, `startAt` covers the second, and only
 * `trigger` is genuinely display timing.
 */
export interface DisplayRules {
  /**
   * How intrusive this is allowed to be.
   *
   *  - `modal`  -- a blocking dialog. At most one per session, priority-ordered.
   *  - `banner` -- an inline notice on a list screen. Never blocks.
   *  - `inbox`  -- appears only in Settings > Announcements. Never presented.
   */
  surface: Surface;

  /**
   *  - `next-launch` -- shown the next time the app opens. The default, and the
   *    right answer for almost everything: it never interrupts work in progress.
   *  - `immediate`   -- may be shown during the session it was fetched in.
   */
  trigger: Trigger;

  /** Total times it may ever be shown on one device. `null` = unlimited. */
  maxImpressions: number | null;

  /**
   * Minimum hours between two impressions. `0` means it may repeat within a
   * session (still subject to the one-modal-per-session rule); `24` is
   * "once a day".
   */
  minIntervalHours: number;

  /**
   *  - `permanent`  -- dismissing retires it on this device for good.
   *  - `session`    -- dismissing hides it until the app is next opened.
   *  - `snooze-24h` -- dismissing hides it for a day.
   *  - `none`       -- no dismiss control beyond the ordinary close affordance.
   *
   * `none` never means "cannot be closed". Nothing in this contract may produce
   * a dialog a user cannot get out of; a manifest that could is a remote brick.
   */
  dismiss: DismissBehaviour;
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

/**
 * Who may see it.
 *
 * Deliberately three fields. Region, language, device capability and user
 * segment were all considered and rejected: RUOOD Lab has no accounts, no
 * analytics and no backend, so there is no identity to segment on and no way to
 * resolve a region without adding a network call to an offline-first app.
 *
 * Targeting FAILS CLOSED. A record whose targeting this build cannot fully
 * evaluate is skipped, never shown.
 */
export interface Targeting {
  /** Non-empty. A platform absent from the list never sees the record. */
  platforms: Platform[];

  /** Inclusive lower bound (>=). `null` = no lower bound. */
  minVersion: string | null;

  /**
   * EXCLUSIVE upper bound (<). `null` = no upper bound.
   *
   * Exclusive so a range can express "every 2.5.x" as
   * `minVersion: "2.5.0", maxVersion: "2.6.0"` without inventing a patch
   * number nobody will ever ship.
   */
  maxVersion: string | null;
}

// ---------------------------------------------------------------------------
// Image and action
// ---------------------------------------------------------------------------

/**
 * The published image reference.
 *
 * `path` is content-addressed (`images/<slug>-<hash8>.webp`), so an image is
 * never mutated -- only replaced by a differently-named file. That single
 * choice answers cache invalidation and old-image cleanup at once.
 *
 * `bytes` and `sha256` are carried so the client can verify what it downloaded
 * and discard a mismatch. An image is always optional at display time: a failed
 * or unverifiable download shows the announcement WITHOUT its image, never
 * suppresses it.
 */
export interface AnnouncementImage {
  path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  alt: string;

  /**
   * Whether this `.webp` holds more than one frame.
   *
   * Optional, and absent means still — which is what every image published
   * before animation existed is, so nothing had to be rewritten.
   *
   * It is here rather than left to the decoder because the VALIDATOR needs it:
   * an animation is allowed a larger byte budget than a still, and the rule
   * that picks between the two caps runs over the manifest without ever seeing
   * the image bytes. A renderer does not need the field at all — `expo-image`
   * sniffs the file — so this is not a display hint, it is the fact that makes
   * `image.bytes` checkable.
   *
   * It is NOT authored. `encodeAnnouncementImage` stamps what it actually
   * produced, so the flag cannot disagree with the file: a record claiming
   * `animated: true` over a still image would simply be granted a budget it has
   * no use for, and one claiming `false` over an animation would be refused by
   * the still cap. Derived, never stored by hand — the same discipline as
   * `width` and `sha256` beside it.
   */
  animated?: boolean;
}

/** A route action: a closed id, resolved by the app. Never a URL. */
export interface RouteAction {
  type: 'route';
  label: string;
  target: RouteTarget;
}

/** An external action: https only, to an allowlisted host. */
export interface ExternalAction {
  type: 'external';
  label: string;
  target: string;
}

export type AnnouncementAction = RouteAction | ExternalAction;

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

export interface PublishedAnnouncement {
  /** Immutable, never reused -- including after deletion. See `id.ts`. */
  id: string;

  /**
   * Content revision, from 1.
   *
   * Bumping it resets this record's impression counters on every device, which
   * is what makes "re-show a corrected message" expressible. Leaving it alone
   * while editing is what makes "fix a typo quietly" expressible. Without the
   * field there is no way to have both.
   */
  rev: number;

  /**
   * Lowest schema version able to render this record. A client skips a record
   * whose `minSchema` exceeds its own support and still reads the rest of the
   * file -- which is why an additive change does not need a root version bump.
   */
  minSchema: number;

  /**
   * Optional, and absent or empty mean the same thing: no title.
   *
   * An announcement may be a picture and nothing else -- the image IS the
   * message, and asking for a caption to go with it produces a caption nobody
   * needed. What is not allowed is an announcement with no picture, no title
   * and no message: `validateAnnouncementRecord` refuses that, because it is a
   * record that would render as an empty dialog.
   *
   * Writers always write a string (empty when there is no text); readers
   * tolerate the field being absent.
   */
  title?: string;
  /** Optional, on the same terms as `title`. */
  body?: string;
  category: Category;

  /** 0-100. Ordering among simultaneously eligible records. Not urgency. */
  priority: number;

  startAt: Instant;
  /** `null` = runs until it is unpublished. */
  endAt: Instant | null;

  /** Published but suppressed. Reversible without touching the dates. */
  paused?: boolean;

  display: DisplayRules;
  targeting: Targeting;

  image?: AnnouncementImage;
  action?: AnnouncementAction;

  /**
   * Reserved for Ed25519-over-canonical-JSON, implemented in Phase 3.
   *
   * Present and nullable from v1 deliberately: adding a signature field to a
   * schema already shipped to devices costs a version bump and a migration;
   * reserving it now costs one line.
   */
  signature?: string | null;
}

/**
 * The repository-side record. Superset of the published one.
 *
 * Everything below `signature` exists only in `content/` and is never emitted
 * into `dist/`. Git already records who changed what and when, so this is the
 * small set of facts git cannot answer cheaply -- not a second audit log.
 */
export interface AuthoredAnnouncement extends PublishedAnnouncement {
  status: StoredStatus;
  createdAt: Instant;
  updatedAt: Instant;
  publishedAt?: Instant | null;
  archivedAt?: Instant | null;
  /** Operator-only. Never published, never shown to a user. */
  internalNote?: string;
}

export interface AnnouncementManifest {
  schemaVersion: number;
  /** Monotonic, incremented by the build. For logs and support, not logic. */
  revision: number;
  generatedAt: Instant;
  /** Global kill switch. `true` and clients show nothing at all. */
  paused: boolean;
  announcements: PublishedAnnouncement[];

  /**
   * Which key signed this file: the first 8 hex of the sha256 of the public
   * key. A hint, not a credential -- it says which of its pinned keys a client
   * should try, and a client that does not recognise it refuses the manifest.
   */
  keyId?: string;

  /**
   * Ed25519 over the canonical COMPACT form of this envelope with `signature`
   * removed. `keyId` is inside the covered bytes, so it cannot be swapped.
   *
   * Covers the whole file rather than each record, because the three things
   * worth tampering with -- `paused`, `revision`, and which records are present
   * at all -- are not inside any record. See `signing.ts`.
   */
  signature?: string | null;
}
