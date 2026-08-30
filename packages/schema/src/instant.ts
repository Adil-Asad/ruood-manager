/**
 * Absolute instants.
 *
 * The rule this module exists to enforce: an announcement date is an instant,
 * never a wall-clock reading. "September 1, 9:00 AM" is not a fact a device in
 * another timezone can act on, and a naive string is the classic way a
 * scheduled thing fires eight hours early for half the users.
 *
 * So a stored date must carry an explicit offset -- `Z` or `+05:00` -- and the
 * Manager resolves the author's local intent to one of these at authoring time
 * and displays it back with the zone it was authored in.
 *
 * Pure. `now` is always passed in, never read from the clock, for the same
 * reason RUOOD Lab's report engine takes it as a field: a scheduling rule you
 * cannot pin to a fixed instant is a scheduling rule you cannot test.
 */

/**
 * ISO-8601 with a mandatory explicit offset.
 *
 * Deliberately narrower than what `Date.parse` accepts. `Date.parse` will take
 * `2026-09-01`, `2026/09/01` and a good deal else, resolving some of it against
 * the local zone -- which is exactly the ambiguity being refused here.
 */
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** ISO-8601 without an offset -- recognised only so the error can say why. */
const NAIVE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

export type InstantProblem = 'invalid' | 'no-offset';

export interface InstantParseFailure {
  ok: false;
  problem: InstantProblem;
}

export interface InstantParseSuccess {
  ok: true;
  /** Milliseconds since the epoch. */
  epochMs: number;
  /** The canonical `YYYY-MM-DDTHH:MM:SSZ` form of the same instant. */
  canonical: string;
}

export type InstantParseResult = InstantParseSuccess | InstantParseFailure;

/**
 * Parses a stored instant.
 *
 * Rejects a syntactically well-formed but impossible date (`2026-02-30`) by
 * round-tripping through `Date` and checking the components survived -- the
 * platform silently rolls those over to March 2nd otherwise.
 */
export function parseInstant(value: unknown): InstantParseResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, problem: 'invalid' };
  }

  const match = INSTANT_PATTERN.exec(value);
  if (!match) {
    return { ok: false, problem: NAIVE_PATTERN.test(value) ? 'no-offset' : 'invalid' };
  }

  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    return { ok: false, problem: 'invalid' };
  }

  // Guard against rollover: 2026-02-30T00:00:00Z parses, as March 2nd.
  const date = new Date(epochMs);
  const [, year, month, day] = match;
  if (match[8] === 'Z') {
    if (
      date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day)
    ) {
      return { ok: false, problem: 'invalid' };
    }
  }

  return { ok: true, epochMs, canonical: toCanonicalInstant(epochMs) };
}

export function isInstant(value: unknown): value is string {
  return parseInstant(value).ok;
}

/** The one stored form: UTC, second precision, trailing `Z`. */
export function toCanonicalInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/** Epoch milliseconds, or `null` if the value is not a valid instant. */
export function instantToEpoch(value: unknown): number | null {
  const parsed = parseInstant(value);
  return parsed.ok ? parsed.epochMs : null;
}

/**
 * Whether `now` falls inside `[startAt, endAt)`.
 *
 * Half-open on purpose: an announcement ending at 23:59:00 and another starting
 * at 23:59:00 must not both be live for that instant. An unparseable date is
 * treated as "not in window" -- fail closed, like everything else here.
 */
export function isWithinWindow(
  startAt: unknown,
  endAt: unknown,
  now: number,
): boolean {
  const start = instantToEpoch(startAt);
  if (start === null || now < start) return false;

  if (endAt === null || endAt === undefined) return true;

  const end = instantToEpoch(endAt);
  if (end === null) return false;
  return now < end;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function daysBetween(fromEpochMs: number, toEpochMs: number): number {
  return (toEpochMs - fromEpochMs) / DAY_MS;
}
