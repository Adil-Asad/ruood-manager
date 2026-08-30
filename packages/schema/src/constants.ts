/**
 * Every hard limit and closed enum in the announcement contract.
 *
 * This file is the paper equivalent of RUOOD Lab's `constants/layout.ts`: a
 * number that governs the contract lives here, never at a call site. A
 * validator that picks its own limit and a client that picks a different one is
 * exactly how a manifest becomes publishable-but-unreadable.
 *
 * It imports nothing, deliberately.
 */

/**
 * The schema version this build of the package understands.
 *
 * Bump ONLY for a breaking structural change — a field removed, a field whose
 * meaning changed, a container reshaped. A client refuses a manifest whose
 * `schemaVersion` exceeds this, so a bump strands every install that has not
 * updated. Additive changes take a per-record `minSchema` instead, which lets an
 * old client skip the one new record and still read the rest of the file.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** The lowest `schemaVersion` this build can still read. */
export const MINIMUM_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Closed enums.
//
// "Closed" is load-bearing: a value outside one of these sets is not a value to
// fall back from, it is a record this build cannot render correctly. The client
// parser SKIPS such a record rather than guessing a default (see parse-manifest).
// ---------------------------------------------------------------------------

export const PLATFORMS = ['android', 'ios', 'web'] as const;

export const CATEGORIES = ['feature', 'fix', 'notice', 'tip'] as const;

/** How intrusive the announcement is allowed to be. */
export const SURFACES = ['modal', 'banner', 'inbox'] as const;

/** When the app is allowed to present it. */
export const TRIGGERS = ['next-launch', 'immediate'] as const;

/** What dismissing it means. */
export const DISMISS_BEHAVIOURS = ['permanent', 'session', 'snooze-24h', 'none'] as const;

export const ACTION_TYPES = ['route', 'external'] as const;

/**
 * The states an authored record is STORED in.
 *
 * `scheduled`, `active` and `expired` are deliberately absent: they are derived
 * from `startAt` / `endAt` and must never be stored, or the stored value and the
 * dates will disagree. See `deriveLifecycleStatus`.
 */
export const STORED_STATUSES = ['draft', 'published', 'paused', 'archived'] as const;

/** Stored states plus the three derived ones — what the Manager displays. */
export const LIFECYCLE_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'expired',
  'archived',
] as const;

// ---------------------------------------------------------------------------
// Field limits.
// ---------------------------------------------------------------------------

export const ID_MIN_LENGTH = 3;
export const ID_MAX_LENGTH = 64;

export const TITLE_MAX_LENGTH = 60;
export const BODY_MAX_LENGTH = 500;
/** Above this the body scrolls inside a phone-width modal. Warning, not error. */
export const BODY_LENGTH_WARNING = 300;

export const ACTION_LABEL_MAX_LENGTH = 24;
export const IMAGE_ALT_MAX_LENGTH = 120;

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;

export const REVISION_MIN = 1;

// ---------------------------------------------------------------------------
// Image limits.
//
// Two byte caps, and the difference matters. The publish cap is what the image
// pipeline must reach; the client cap is deliberately larger so a legitimately
// published image can never trip the client's own defence.
// ---------------------------------------------------------------------------

export const IMAGE_MAX_BYTES = 150 * 1024;
export const CLIENT_IMAGE_MAX_BYTES = 500 * 1024;
export const IMAGE_MAX_DIMENSION = 1080;
export const IMAGE_MIN_DIMENSION = 16;

/** The one output format. One format means one decode path to reason about. */
export const IMAGE_OUTPUT_EXTENSION = '.webp';
export const IMAGE_CONTENT_TYPE = 'image/webp';

/** `images/<slug>-<8 hex>.webp`, relative to the manifest. Content-addressed. */
export const IMAGE_PATH_PATTERN = /^images\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\.webp$/;

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Manifest limits.
// ---------------------------------------------------------------------------

export const MANIFEST_MAX_BYTES = 256 * 1024;
export const MANIFEST_MAX_RECORDS = 50;

/** More than this many overlapping modals is a warning, not an error. */
export const SIMULTANEOUS_MODAL_WARNING_THRESHOLD = 3;

/** A start date further out than this is probably a typo. Warning. */
export const SCHEDULE_HORIZON_WARNING_DAYS = 90;

// ---------------------------------------------------------------------------
// Client behaviour constants.
//
// Here rather than in RUOOD Lab because the Manager's preview and its validator
// warnings have to agree with what the app will actually do.
// ---------------------------------------------------------------------------

/** At most one blocking modal per app session, whatever else is eligible. */
export const MAX_MODALS_PER_SESSION = 1;

/** A `seen` entry is pruned this long after its id last appeared in a manifest. */
export const SEEN_STATE_GRACE_DAYS = 60;

/** Hard cap on remembered ids, oldest-seen evicted first. */
export const SEEN_STATE_MAX_ENTRIES = 200;

/** Minimum gap between manifest fetches. */
export const FETCH_INTERVAL_HOURS = 6;

export const MANIFEST_FETCH_TIMEOUT_MS = 8000;
export const IMAGE_FETCH_TIMEOUT_MS = 15000;

/** An image is prefetched only once its start is this close. */
export const IMAGE_PREFETCH_LEAD_HOURS = 48;

/**
 * A device clock further than this from the server's `Date` header is not
 * trusted for scheduling.
 */
export const MAX_CLOCK_SKEW_HOURS = 24;
