/**
 * Semantic-version parsing and comparison.
 *
 * Hand-rolled rather than pulled from npm, because this module ships inside
 * RUOOD Lab's bundle and the package is contractually zero-dependency. It is
 * also small: version targeting needs precedence and a range test, not the
 * whole of the npm range grammar.
 *
 * Implements semver 2.0.0 precedence, including the two rules that are easy to
 * get wrong and are both tested:
 *
 *   - build metadata (`+abc`) is IGNORED for precedence, so `1.0.0+a` and
 *     `1.0.0+b` are equal;
 *   - a prerelease sorts BEFORE its release, so `2.5.0-beta.1 < 2.5.0`, and
 *     numeric prerelease identifiers compare numerically while alphanumeric
 *     ones compare as ASCII (`alpha.9 < alpha.10`, which a string sort gets
 *     backwards).
 *
 * One deliberate divergence from npm's range semantics: a prerelease version is
 * tested by plain precedence, not excluded from ranges it would otherwise
 * satisfy. `2.5.0-beta.1` satisfies `min 2.4.0 / max 2.6.0`. npm excludes it
 * unless the range itself names a prerelease; that rule exists to stop a public
 * dependency resolver picking up an alpha, which is not the problem here. The
 * targets here are the operator's own builds, and "the beta of 2.5 counts as
 * being past 2.4" is what an operator means.
 */

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers, empty when the version is a release. */
  prerelease: string[];
  /** Ignored for precedence. Kept so a caller can display it. */
  build: string | null;
}

/** `null` for anything that is not a strict semver string. */
export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null;

  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ?? null,
  };
}

export function isVersion(value: unknown): value is string {
  return parseVersion(value) !== null;
}

/**
 * -1, 0 or 1. Throws on an unparseable input rather than guessing, because
 * every call site here has already validated, and a silent 0 would read as
 * "these versions are equal".
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) throw new TypeError(`Not a semantic version: ${JSON.stringify(a)}`);
  if (!right) throw new TypeError(`Not a semantic version: ${JSON.stringify(b)}`);
  return compareParsed(left, right);
}

export function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  const core = cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.patch, b.patch);
  if (core !== 0) return core;

  // A release outranks any prerelease of the same core version.
  const aPre = a.prerelease.length > 0;
  const bPre = b.prerelease.length > 0;
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;

  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];

    // A shorter set of identifiers has lower precedence, all else equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = isNumericIdentifier(left);
    const rightNumeric = isNumericIdentifier(right);

    if (leftNumeric && rightNumeric) {
      const result = cmp(Number(left), Number(right));
      if (result !== 0) return result;
      continue;
    }

    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;

    if (left !== right) return left < right ? -1 : 1;
  }

  return 0;
}

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

function cmp(a: number, b: number): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export interface VersionRange {
  /** Inclusive lower bound (>=). */
  minVersion: string | null;
  /** EXCLUSIVE upper bound (<). See `Targeting.maxVersion`. */
  maxVersion: string | null;
}

/**
 * Whether `version` falls in `[minVersion, maxVersion)`.
 *
 * FAILS CLOSED. An unparseable app version, or an unparseable bound, returns
 * `false` -- the record is not shown. The alternative, treating a bound this
 * build cannot read as "no bound", would show version-targeted announcements to
 * exactly the installs the targeting was meant to exclude.
 */
export function satisfiesVersionRange(version: unknown, range: VersionRange): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  if (range.minVersion !== null && range.minVersion !== undefined) {
    const min = parseVersion(range.minVersion);
    if (!min) return false;
    if (compareParsed(parsed, min) < 0) return false;
  }

  if (range.maxVersion !== null && range.maxVersion !== undefined) {
    const max = parseVersion(range.maxVersion);
    if (!max) return false;
    if (compareParsed(parsed, max) >= 0) return false;
  }

  return true;
}

/**
 * Whether any version at all could satisfy the range.
 *
 * Catches the transposed bound (`min 2.5.0 / max 2.4.0`) and the degenerate
 * one (`min 2.5.0 / max 2.5.0`, which excludes its own lower bound and so
 * matches nothing). Both are publishable-but-dead targeting, and there is no
 * feedback channel that would ever tell you.
 */
export function isRangeSatisfiable(range: VersionRange): boolean {
  if (range.minVersion === null || range.maxVersion === null) return true;

  const min = parseVersion(range.minVersion);
  const max = parseVersion(range.maxVersion);
  if (!min || !max) return false;

  return compareParsed(min, max) < 0;
}
