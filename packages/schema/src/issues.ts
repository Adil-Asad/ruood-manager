/**
 * What a validator says when something is wrong.
 *
 * Codes are a closed union rather than free text so the Manager UI can key off
 * them, tests can assert on them without matching prose, and the wording can be
 * changed without breaking either.
 *
 * The severity split is the whole point of the module:
 *
 *   error   -- publishing is refused. The record is malformed, unsafe, or
 *              expresses something the client cannot honour.
 *   warning -- publishing proceeds after confirmation. The record is valid but
 *              probably not what you meant.
 *
 * Nothing here reads a clock, throws, or formats for a particular UI.
 */

export type IssueSeverity = 'error' | 'warning';

export type IssueCode =
  // -- structure -----------------------------------------------------------
  | 'not-an-object'
  | 'missing-field'
  | 'wrong-type'
  | 'unknown-field'
  | 'unknown-enum-value'
  // -- id ------------------------------------------------------------------
  | 'id-invalid-format'
  | 'id-too-short'
  | 'id-too-long'
  | 'id-duplicate'
  | 'id-retired'
  // -- text ----------------------------------------------------------------
  | 'text-empty'
  | 'text-too-long'
  | 'text-unsafe-characters'
  | 'text-long-warning'
  // -- numbers -------------------------------------------------------------
  | 'number-not-integer'
  | 'number-out-of-range'
  // -- dates ---------------------------------------------------------------
  | 'instant-invalid'
  | 'instant-no-offset'
  | 'end-before-start'
  | 'end-in-past'
  | 'no-end-date-warning'
  | 'start-far-future-warning'
  // -- versions ------------------------------------------------------------
  | 'version-invalid'
  | 'version-range-empty'
  | 'version-missing-warning'
  // -- display -------------------------------------------------------------
  | 'unclosable-modal'
  | 'inbox-with-immediate-trigger'
  // -- image ---------------------------------------------------------------
  | 'image-path-invalid'
  | 'image-too-large'
  | 'image-dimension-invalid'
  | 'image-hash-invalid'
  // -- action --------------------------------------------------------------
  | 'action-target-not-allowed'
  | 'action-url-not-allowed'
  // -- manifest ------------------------------------------------------------
  | 'schema-version-unsupported'
  | 'manifest-too-large'
  | 'manifest-too-many-records'
  | 'overlapping-category-warning'
  | 'too-many-modals-warning';

export interface ValidationIssue {
  code: IssueCode;
  /** Dotted path to the offending value, e.g. `display.maxImpressions`. */
  path: string;
  message: string;
  severity: IssueSeverity;
}

export interface ValidationResult {
  /** True when there are no errors. Warnings do not make a result invalid. */
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Collects issues during a validation pass.
 *
 * A class rather than array-pushing at every call site so that "is this an
 * error or a warning" is decided once, by the method name, and a validator
 * cannot accidentally record an error into the warnings list.
 */
export class IssueCollector {
  private readonly issues: ValidationIssue[] = [];

  constructor(private readonly basePath: string = '') {}

  error(code: IssueCode, path: string, message: string): void {
    this.issues.push({ code, path: this.resolve(path), message, severity: 'error' });
  }

  warn(code: IssueCode, path: string, message: string): void {
    this.issues.push({ code, path: this.resolve(path), message, severity: 'warning' });
  }

  /** A collector for a nested object, whose paths are prefixed automatically. */
  scoped(path: string): IssueCollector {
    const child = new IssueCollector(this.resolve(path));
    // Share the array so a nested collector's issues land in the parent.
    (child as unknown as { issues: ValidationIssue[] }).issues = this.issues;
    return child;
  }

  absorb(other: ValidationIssue[]): void {
    this.issues.push(...other);
  }

  all(): ValidationIssue[] {
    return [...this.issues];
  }

  hasErrors(): boolean {
    return this.issues.some((issue) => issue.severity === 'error');
  }

  result(): ValidationResult {
    return toResult(this.issues);
  }

  private resolve(path: string): string {
    if (!this.basePath) return path;
    if (!path) return this.basePath;
    return `${this.basePath}.${path}`;
  }
}

export function toResult(issues: readonly ValidationIssue[]): ValidationResult {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}

/** Merges several results, preserving order. */
export function mergeResults(...results: readonly ValidationResult[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  for (const result of results) {
    issues.push(...result.errors, ...result.warnings);
  }
  return toResult(issues);
}

/** A one-line-per-issue rendering, for the CLI and for test failure output. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const mark = issue.severity === 'error' ? 'ERROR' : 'WARN ';
      const where = issue.path ? ` at ${issue.path}` : '';
      return `${mark} [${issue.code}]${where}: ${issue.message}`;
    })
    .join('\n');
}
