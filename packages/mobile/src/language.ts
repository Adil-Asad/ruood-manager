/**
 * Everything the administrator reads, in words they already know.
 *
 * Two jobs, and they are the same job seen from two ends:
 *
 *   `humanise`  turns a failure into a sentence naming the next action.
 *   `statusOf`  turns the schema's vocabulary into the product's.
 *
 * ## Why this is a module and not a sprinkling of ternaries
 *
 * §25 and §33 of the brief are not a style preference. The person using this
 * app does not know what a manifest is, has never run git, and will not be
 * helped by `ECONNREFUSED`. If the translation lives at each call site, then
 * every new screen is a new opportunity for `403` to reach a phone — and it
 * only has to happen once for the app to stop being the product it claims to
 * be. One module means one place to check.
 *
 * The technical detail is not destroyed, it is relocated: the server still logs
 * precisely what happened, and a developer build still shows the raw message
 * under Settings → Advanced. What changes is who has to read it.
 *
 * ## The rule for writing one of these
 *
 * A good message names **what happened** and **what to do**, in that order, and
 * never blames the reader. "Unable to publish right now. Please try again." is
 * better than "Publish failed (500)" not because it is softer but because it is
 * actionable — the second one invites somebody to go looking for a 500.
 */

import { ApiFailure, ConnectionFailure } from '@ruood/announcement-client';
import { ConcurrentUpdate, DeviceFlowError, GitHubError } from '@ruood/announcement-github';
import type { LifecycleStatus, Platform } from '@ruood/announcement-schema';

import { PRODUCT_NAME } from './brand';

/**
 * A failure, as a sentence.
 *
 * Ordered from most specific to least, so the general fallback is only ever
 * reached by something genuinely unrecognised.
 */
export function humanise(failure: unknown): string {
  // GitHub's failures come first, because they are now the ones an
  // administrator will actually hit. Each maps to a sentence naming the next
  // action, and none of them mentions an API, a status or a repository.
  if (failure instanceof ConcurrentUpdate) {
    return failure.message;
  }

  if (failure instanceof GitHubError) {
    if (failure.isAuthFailure) {
      return 'Your GitHub sign-in has expired. Please sign in again.';
    }

    if (failure.isPermissionFailure) {
      // 403 and 404 are the same answer here: signed in, and not allowed. A
      // repository somebody cannot see answers 404 rather than 403, so telling
      // them apart would be telling them apart wrongly.
      return 'Your account cannot change these announcements. Ask for access, then try again.';
    }

    if (failure.status === 429) {
      return 'GitHub is asking us to slow down. Wait a minute and try again.';
    }

    if (failure.status >= 500) {
      return 'GitHub is having trouble right now. Please try again shortly.';
    }

    // Anything else gets the generic sentence, and deliberately NOT
    // `safe(failure.message)`.
    //
    // There is no such thing as a GitHubError written for an administrator.
    // Its message is either GitHub's own API wording ("Reference cannot be
    // updated", "Invalid request. For 'properties/content', nil is not a
    // string.") or one of this app's internal invariant messages ("A blob came
    // back as ... which is not base64"). Both describe machinery.
    //
    // `safe()` only rejects what it RECOGNISES as technical, and those two
    // examples carry no errno, no stack frame, no bare status and no JSON — so
    // they passed it and would have been printed verbatim on the phone. A word
    // list can always be one word short; not passing the message through at all
    // cannot be.
    return 'Something went wrong. Please try again.';
  }

  if (failure instanceof DeviceFlowError) {
    // These are written for a person already — `device-flow.ts` turns GitHub's
    // codes into sentences — so they pass through as they are.
    return failure.message;
  }

  if (failure instanceof ConnectionFailure) {
    // The phone is offline, or GitHub is unreachable. It no longer means "the
    // operator's PC is asleep", so the sentence no longer says so.
    return `${PRODUCT_NAME} can't reach your announcements right now. Check your connection and try again.`;
  }

  if (failure instanceof ApiFailure) {
    if (failure.isAuthFailure) {
      return 'Your session has expired. Please log in again.';
    }

    switch (failure.status) {
      case 403:
        return 'You do not have permission to do that.';
      case 404:
        return 'That announcement no longer exists. It may have been deleted.';
      case 409:
        return 'That change conflicts with the current state. Refresh and try again.';
      case 415:
        return 'Something went wrong sending that. Please try again.';
      case 429:
        // The throttle's own message already carries the wait, which is the
        // one useful fact, so it is passed through rather than replaced.
        return failure.message;
      case 422:
      case 400:
        // A refusal the administrator can actually fix — a message too long, an
        // image that will not encode. The validator's own sentence is written
        // for a person and is better than anything generic.
        //
        // Only the validator's sentence, though. A bare 400 from anywhere else
        // carries a message written for a developer, and passing that through
        // is how "Request failed with status 400" reaches a phone.
        return firstIssue(failure) ?? safe(failure.message);
      default:
        break;
    }

    if (failure.status >= 500) {
      return 'Something went wrong on the Manager. Please try again.';
    }

    return firstIssue(failure) ?? safe(failure.message);
  }

  // Anything that reaches here is unrecognised, so it must not be shown raw:
  // this is exactly where `EADDRINUSE` would otherwise land on a phone.
  return safe((failure as Error)?.message);
}

function firstIssue(failure: ApiFailure): string | null {
  return failure.issues.length > 0 ? failure.issues[0]!.message : null;
}

/**
 * A message, or a sentence in its place.
 *
 * The single gate every unrecognised string passes through. Having exactly one
 * of these is the point: a second place deciding whether a message is showable
 * is a second place to get it wrong, and it only has to be wrong once.
 */
function safe(message: string | undefined): string {
  return message && !looksTechnical(message)
    ? message
    : 'Something went wrong. Please try again.';
}

/**
 * Whether a message is the kind of thing only a developer should read.
 *
 * A heuristic, and deliberately a broad one: the cost of hiding a message that
 * would have been fine is a slightly vaguer sentence, and the cost of showing
 * one that should have been hidden is the whole premise of the product.
 */
function looksTechnical(message: string): boolean {
  return (
    // An errno, which is the likeliest thing to arrive from a socket.
    /\b(E[A-Z]{3,}|ENOENT|ECONNREFUSED|EADDRINUSE|ETIMEDOUT)\b/.test(message) ||
    // The system's vocabulary — §33's list of exactly what must not appear.
    /\b(git|commit|manifest|repository|revision|sha256|Ed25519|fastify|sharp|stack|signature|verification|certificate|socket|payload)\b/i.test(
      message,
    ) ||
    // GitHub's own vocabulary, which §33's list predates.
    //
    // Phase 8 made GitHub the thing that fails, and its wording is written for
    // somebody building against the API. Only 401, 403/404, 429 and 5xx are
    // mapped to sentences; every other status falls through to `safe()`, so a
    // 422 from creating a blob or a tree — "Invalid request. For
    // 'properties/content', nil is not a string." — would otherwise reach an
    // administrator verbatim. None of these words belongs on a screen that
    // says "New Announcement".
    /\b(blob|refs?|reference|endpoint|integration|oauth|bad credentials|not accessible)\b/i.test(
      message,
    ) ||
    // A stack frame. `at Object.<anonymous> (index.js:1:1)` has a dot before
    // the parenthesis, which an earlier version of this pattern did not allow —
    // so it matched the frames that never happen and missed the common one.
    /\bat\s+[\w.<>$]+\s*\(/.test(message) ||
    // A file:line reference, with or without a frame around it.
    /\.[jt]sx?:\d+/.test(message) ||
    // A bare HTTP status. Never the useful part, and always the part somebody
    // screenshots and asks about.
    /\b(status|code|error)\b[^a-z]{0,3}\d{3}\b/i.test(message) ||
    // Raw JSON, which is what an unhandled body looks like.
    /^\s*[{[]/.test(message)
  );
}

// ---------------------------------------------------------------------------
// The status vocabulary
// ---------------------------------------------------------------------------

/**
 * What the administrator calls each state.
 *
 * The left-hand column is the schema's `LifecycleStatus`, unchanged — this is a
 * translation at the edge, not a second state model. Inventing a parallel set
 * of statuses is how two parts of a product end up disagreeing about what is
 * live, so the mapping is total and the schema stays authoritative.
 *
 * `paused` becomes "Inactive" because that is what §16 and §19 call it, and
 * because "paused" invites the question "paused until when?" — which has no
 * answer. Inactive is a state somebody switches back on.
 */
const STATUS_WORDS: Record<LifecycleStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Inactive',
  expired: 'Expired',
  archived: 'Archived',
};

export function statusOf(lifecycle: LifecycleStatus): string {
  return STATUS_WORDS[lifecycle] ?? 'Draft';
}

/**
 * A one-line explanation of what a status means for the reader.
 *
 * Shown under the badge on the detail screen. Every one of them is written from
 * the RUOOD Lab user's point of view — "who can see this, and when" — because
 * that is the only question an administrator is actually asking.
 */
export function explainStatus(lifecycle: LifecycleStatus): string {
  switch (lifecycle) {
    case 'draft':
      return 'Not published. Only you can see this.';
    case 'scheduled':
      return 'Published, and will appear to RUOOD users at its start time.';
    case 'active':
      return 'Live. RUOOD users can see this now.';
    case 'paused':
      return 'Published but switched off. Nobody is seeing it.';
    case 'expired':
      return 'Its end date has passed, so it is no longer shown.';
    case 'archived':
      return 'Retired. It will not be shown again.';
    default:
      return '';
  }
}

/**
 * The two delivery choices, in the administrator's words.
 *
 * These map onto `surface` and onto NOTHING ELSE. The schema already had the
 * field, so Phase 5 deliberately did not add a `passive` boolean beside it —
 * two fields expressing one fact are two fields free to disagree, and every
 * consumer would then have to decide which wins.
 */
export const DELIVERY_LABELS = {
  active: {
    title: 'Active',
    detail: 'Shown to RUOOD users as a message when they open the app, and kept in their inbox.',
  },
  passive: {
    title: 'Passive',
    detail: 'Waits quietly in the RUOOD user’s inbox. It never interrupts them.',
  },
} as const;

/**
 * The surface a delivery choice means.
 *
 * `modal` for active, because that is the interruption the administrator is
 * choosing; `inbox` for passive, because `isEligible` refuses to present it.
 * `banner` is a third, less intrusive active surface that the schema supports
 * and this form deliberately does not offer — a two-way choice an administrator
 * understands is worth more than a three-way one they have to think about, and
 * the desktop Manager still exposes all three.
 */
export function surfaceFor(delivery: 'active' | 'passive'): 'modal' | 'inbox' {
  return delivery === 'active' ? 'modal' : 'inbox';
}

export function deliveryOf(surface: string): 'active' | 'passive' {
  return surface === 'inbox' ? 'passive' : 'active';
}

/**
 * Who an announcement is for, in the three answers a person gives.
 *
 * `targeting.platforms` is a list and always has been; this is the same
 * mapping `surfaceFor` is one field over — one word for the administrator, the
 * schema's own field underneath, and no second place for the two to disagree.
 *
 * It lives here rather than in the form because it is pure, and pure things in
 * this package are node-tested. Importing a `.tsx` into a test drags React
 * Native in with it.
 */
export type Audience = 'both' | 'android' | 'ios';

export function platformsFor(audience: Audience): Platform[] {
  if (audience === 'android') return ['android'];
  if (audience === 'ios') return ['ios'];
  return ['android', 'ios'];
}

/**
 * The answer a stored list came from.
 *
 * `web` is a legitimate CLI target that the phone does not offer, and it must
 * not read as "one platform only" — a record naming android and web is still
 * an Android announcement, and one naming all three is still everyone.
 */
export function audienceFor(platforms: readonly Platform[]): Audience {
  const android = platforms.includes('android');
  const ios = platforms.includes('ios');

  if (android && !ios) return 'android';
  if (ios && !android) return 'ios';
  return 'both';
}

/** Bytes, as somebody would say them out loud. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What to call an announcement that may have no words.
 *
 * An announcement can be a picture and nothing else, and three places still
 * need something to say about it: a row in the list, the sentence after a
 * publish, and the commit message. A blank there reads as data that failed to
 * load, so the message stands in for a missing title and a picture with neither
 * says what it is.
 *
 * It is never written into a record. The stored title of an image-only
 * announcement stays empty, because a placeholder saved as content is a
 * placeholder somebody eventually publishes.
 */
export function announcementLabel(record: {
  title?: string;
  body?: string;
  image?: unknown;
}): string {
  const title = (record.title ?? '').trim();
  if (title) return title;

  const body = (record.body ?? '').replace(/\s+/g, ' ').trim();
  if (body) return body.length > 40 ? `${body.slice(0, 39)}…` : body;

  return record.image ? 'Image announcement' : 'Untitled announcement';
}
