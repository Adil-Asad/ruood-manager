/**
 * The one announcement validator.
 *
 * Both consumers reach the contract through this file: the Manager calls it in
 * `authored` mode before publishing, and the client parser calls it in
 * `published` mode while reading a downloaded manifest. There is deliberately
 * no second, looser set of rules on the device -- a manifest that the Manager
 * would refuse to publish is a manifest the client refuses to read, and the two
 * cannot drift because they are the same code.
 *
 * The mode changes what is *present*, not how strict a shared rule is:
 *
 *   authored  -- status and audit dates required; id checked against the
 *                registry; authoring-time judgements applied (an end date
 *                already in the past, a feature announcement with no version
 *                floor, a start date 6 months out).
 *   published -- those fields must be absent; the authoring-time judgements do
 *                not apply, because a record legitimately expires while it is
 *                still in a manifest a device is holding.
 *
 * Everything here is pure and takes `now` as an argument.
 */

import {
  ACTION_LABEL_MAX_LENGTH,
  BODY_LENGTH_WARNING,
  BODY_MAX_LENGTH,
  CATEGORIES,
  DISMISS_BEHAVIOURS,
  IMAGE_ALT_MAX_LENGTH,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MIN_DIMENSION,
  IMAGE_PATH_PATTERN,
  PLATFORMS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  REVISION_MIN,
  SCHEDULE_HORIZON_WARNING_DAYS,
  SHA256_PATTERN,
  STORED_STATUSES,
  SUPPORTED_SCHEMA_VERSION,
  SURFACES,
  TITLE_MAX_LENGTH,
  TRIGGERS,
} from './constants';
import { IssueCollector, type ValidationResult } from './issues';
import { checkIdAvailable, checkIdFormat, type IdRegistry } from './id';
import { daysBetween, instantToEpoch, parseInstant } from './instant';
import { isRangeSatisfiable, isVersion } from './semver';
import {
  EXTERNAL_HOST_ALLOWLIST,
  isAllowedExternalUrl,
  isRouteTarget,
} from './routes';

export type ValidationMode = 'authored' | 'published';

export interface RecordValidationOptions {
  /** Injected, never read from the clock. */
  now: number;
  mode?: ValidationMode;
  /** Checked only in `authored` mode. */
  idRegistry?: IdRegistry;
  /**
   * When validating an existing record, its own id is expected to already be
   * in the registry. Pass it so the duplicate check does not fire on itself.
   */
  editingId?: string;
  externalHostAllowlist?: readonly string[];
  /** The schema version this validation is performed against. */
  schemaVersion?: number;
}

const PUBLISHED_FIELDS = new Set([
  'id',
  'rev',
  'minSchema',
  'title',
  'body',
  'category',
  'priority',
  'startAt',
  'endAt',
  'paused',
  'display',
  'targeting',
  'image',
  'action',
  'signature',
]);

const AUTHORED_ONLY_FIELDS = new Set([
  'status',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'archivedAt',
  'internalNote',
]);

const DISPLAY_FIELDS = new Set([
  'surface',
  'trigger',
  'maxImpressions',
  'minIntervalHours',
  'dismiss',
]);
const TARGETING_FIELDS = new Set(['platforms', 'minVersion', 'maxVersion']);
const IMAGE_FIELDS = new Set(['path', 'width', 'height', 'bytes', 'sha256', 'alt']);
const ACTION_FIELDS = new Set(['type', 'label', 'target']);

/**
 * Characters refused in any user-visible string.
 *
 * Control characters and the Unicode line/paragraph separators, which some
 * JSON and JS parsers treat as line terminators; and the angle brackets, so
 * that no future decision to render the body richly can turn stored text into
 * markup. Newline and tab are allowed in the body only.
 */
const UNSAFE_ANYWHERE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029<>]/;
const UNSAFE_SINGLE_LINE = /[\u0000-\u001F\u007F\u2028\u2029<>]/;

export function validateAnnouncementRecord(
  value: unknown,
  options: RecordValidationOptions,
): ValidationResult {
  const mode: ValidationMode = options.mode ?? 'authored';
  const collector = new IssueCollector();

  if (!isPlainObject(value)) {
    collector.error('not-an-object', '', 'An announcement must be a JSON object.');
    return collector.result();
  }

  const record = value as Record<string, unknown>;

  validateUnknownFields(record, mode, collector);
  validateId(record, mode, options, collector);
  validateVersioningFields(record, options, collector);
  validateText(record, collector);
  validateEnums(record, collector);
  validatePriority(record, collector);
  const schedule = validateSchedule(record, mode, collector);
  validateDisplay(record, collector);
  validateTargeting(record, collector);
  validateImage(record, collector);
  validateAction(record, options, collector);
  validateSignature(record, collector);

  if (mode === 'authored') {
    validateAuthoredFields(record, collector);
    applyAuthoringJudgements(record, schedule, options, collector);
  }

  return collector.result();
}

// ---------------------------------------------------------------------------

function validateUnknownFields(
  record: Record<string, unknown>,
  mode: ValidationMode,
  collector: IssueCollector,
): void {
  for (const key of Object.keys(record)) {
    if (PUBLISHED_FIELDS.has(key)) continue;

    if (AUTHORED_ONLY_FIELDS.has(key)) {
      if (mode === 'published') {
        collector.error(
          'unknown-field',
          key,
          `"${key}" is an authoring field and must not appear in a published manifest.`,
        );
      }
      continue;
    }

    // A warning, not an error: forward compatibility requires that an unknown
    // optional field be ignorable. It is still almost always a typo.
    collector.warn('unknown-field', key, `Unrecognised field "${key}" -- is it a typo?`);
  }
}

function validateId(
  record: Record<string, unknown>,
  mode: ValidationMode,
  options: RecordValidationOptions,
  collector: IssueCollector,
): void {
  const id = record.id;
  if (id === undefined) {
    collector.error('missing-field', 'id', 'An announcement must have an id.');
    return;
  }

  const check = checkIdFormat(id);
  if (!check.ok) {
    if (check.problem === 'too-short') {
      collector.error('id-too-short', 'id', 'An id must be at least 3 characters.');
    } else if (check.problem === 'too-long') {
      collector.error('id-too-long', 'id', 'An id must be at most 64 characters.');
    } else {
      collector.error(
        'id-invalid-format',
        'id',
        'An id must be lowercase words joined by single hyphens, e.g. "reports-center-launch".',
      );
    }
    return;
  }

  if (mode !== 'authored' || !options.idRegistry) return;

  const availability = checkIdAvailable(id as string, options.idRegistry);
  if (availability.available) return;

  // `editingId` excuses a record for colliding with ITSELF — an existing record
  // is in the registry by definition. It does NOT excuse a retired id, which is
  // an error whichever record carries it. Skipping the whole check here is what
  // let a retired id come back in through an ordinary edit.
  if (availability.reason === 'duplicate' && options.editingId === id) return;

  if (availability.reason === 'duplicate') {
    collector.error('id-duplicate', 'id', `The id "${String(id)}" is already in use.`);
  } else {
    collector.error(
      'id-retired',
      'id',
      `The id "${String(id)}" belonged to a deleted announcement and can never be reused -- ` +
        'devices that saw the original still hold its impression count under this id.',
    );
  }
}

function validateVersioningFields(
  record: Record<string, unknown>,
  options: RecordValidationOptions,
  collector: IssueCollector,
): void {
  requireInteger(record, 'rev', REVISION_MIN, Number.MAX_SAFE_INTEGER, collector);

  const schemaVersion = options.schemaVersion ?? SUPPORTED_SCHEMA_VERSION;
  const minSchema = record.minSchema;

  if (minSchema === undefined) {
    collector.error('missing-field', 'minSchema', 'minSchema is required.');
    return;
  }
  if (!isInteger(minSchema)) {
    collector.error('wrong-type', 'minSchema', 'minSchema must be an integer.');
    return;
  }
  if ((minSchema as number) < 1) {
    collector.error('number-out-of-range', 'minSchema', 'minSchema must be at least 1.');
    return;
  }
  if ((minSchema as number) > schemaVersion) {
    collector.error(
      'schema-version-unsupported',
      'minSchema',
      `This record requires schema version ${String(minSchema)}, but this build supports ${schemaVersion}.`,
    );
  }
}

function validateText(record: Record<string, unknown>, collector: IssueCollector): void {
  requireText(record, 'title', TITLE_MAX_LENGTH, true, collector);
  requireText(record, 'body', BODY_MAX_LENGTH, false, collector);

  const body = record.body;
  if (typeof body === 'string' && body.length > BODY_LENGTH_WARNING) {
    collector.warn(
      'text-long-warning',
      'body',
      `The body is ${body.length} characters; over ${BODY_LENGTH_WARNING} it will scroll inside a phone-width dialog.`,
    );
  }
}

function validateEnums(record: Record<string, unknown>, collector: IssueCollector): void {
  requireEnum(record, 'category', CATEGORIES, collector);
}

function validatePriority(record: Record<string, unknown>, collector: IssueCollector): void {
  requireInteger(record, 'priority', PRIORITY_MIN, PRIORITY_MAX, collector);
}

interface ScheduleWindow {
  start: number | null;
  end: number | null;
}

function validateSchedule(
  record: Record<string, unknown>,
  mode: ValidationMode,
  collector: IssueCollector,
): ScheduleWindow {
  const schedule: ScheduleWindow = { start: null, end: null };

  if (record.startAt === undefined) {
    collector.error('missing-field', 'startAt', 'startAt is required.');
  } else {
    const parsed = parseInstant(record.startAt);
    if (!parsed.ok) {
      reportInstantProblem('startAt', parsed.problem, collector);
    } else {
      schedule.start = parsed.epochMs;
    }
  }

  if (record.endAt === undefined) {
    collector.error('missing-field', 'endAt', 'endAt is required (use null for no expiry).');
  } else if (record.endAt !== null) {
    const parsed = parseInstant(record.endAt);
    if (!parsed.ok) {
      reportInstantProblem('endAt', parsed.problem, collector);
    } else {
      schedule.end = parsed.epochMs;
    }
  }

  if (schedule.start !== null && schedule.end !== null && schedule.end <= schedule.start) {
    collector.error(
      'end-before-start',
      'endAt',
      'endAt must be later than startAt.',
    );
  }

  if (mode === 'authored' && record.endAt === null) {
    collector.warn(
      'no-end-date-warning',
      'endAt',
      'This announcement has no end date and will run until it is paused or unpublished.',
    );
  }

  return schedule;
}

function validateDisplay(record: Record<string, unknown>, collector: IssueCollector): void {
  const display = record.display;
  if (display === undefined) {
    collector.error('missing-field', 'display', 'display is required.');
    return;
  }
  if (!isPlainObject(display)) {
    collector.error('wrong-type', 'display', 'display must be an object.');
    return;
  }

  const rules = display as Record<string, unknown>;
  const scoped = collector.scoped('display');

  for (const key of Object.keys(rules)) {
    if (!DISPLAY_FIELDS.has(key)) {
      scoped.warn('unknown-field', key, `Unrecognised display field "${key}".`);
    }
  }

  requireEnum(rules, 'surface', SURFACES, scoped);
  requireEnum(rules, 'trigger', TRIGGERS, scoped);
  requireEnum(rules, 'dismiss', DISMISS_BEHAVIOURS, scoped);
  requireInteger(rules, 'minIntervalHours', 0, 24 * 365, scoped);

  const maxImpressions = rules.maxImpressions;
  if (maxImpressions === undefined) {
    scoped.error('missing-field', 'maxImpressions', 'maxImpressions is required (null for unlimited).');
  } else if (maxImpressions !== null) {
    if (!isInteger(maxImpressions)) {
      scoped.error('wrong-type', 'maxImpressions', 'maxImpressions must be an integer or null.');
    } else if ((maxImpressions as number) < 1) {
      scoped.error(
        'number-out-of-range',
        'maxImpressions',
        'maxImpressions must be at least 1. Use null for unlimited.',
      );
    }
  }

  // The one combination that would produce a dialog with no way out and no end.
  if (
    rules.surface === 'modal' &&
    rules.dismiss === 'none' &&
    rules.maxImpressions === null &&
    record.endAt === null
  ) {
    collector.error(
      'unclosable-modal',
      'display',
      'A modal that is never dismissed, never limited and never expires is a remote brick. ' +
        'Set an end date, an impression limit, or a dismiss behaviour.',
    );
  }

  if (rules.surface === 'inbox' && rules.trigger === 'immediate') {
    collector.warn(
      'inbox-with-immediate-trigger',
      'display.trigger',
      'An inbox announcement is never presented, so its trigger has no effect.',
    );
  }
}

function validateTargeting(record: Record<string, unknown>, collector: IssueCollector): void {
  const targeting = record.targeting;
  if (targeting === undefined) {
    collector.error('missing-field', 'targeting', 'targeting is required.');
    return;
  }
  if (!isPlainObject(targeting)) {
    collector.error('wrong-type', 'targeting', 'targeting must be an object.');
    return;
  }

  const rules = targeting as Record<string, unknown>;
  const scoped = collector.scoped('targeting');

  for (const key of Object.keys(rules)) {
    if (!TARGETING_FIELDS.has(key)) {
      scoped.warn('unknown-field', key, `Unrecognised targeting field "${key}".`);
    }
  }

  const platforms = rules.platforms;
  if (platforms === undefined) {
    scoped.error('missing-field', 'platforms', 'platforms is required.');
  } else if (!Array.isArray(platforms)) {
    scoped.error('wrong-type', 'platforms', 'platforms must be an array.');
  } else if (platforms.length === 0) {
    scoped.error(
      'number-out-of-range',
      'platforms',
      'platforms must name at least one platform, or nobody can ever see this.',
    );
  } else {
    for (const entry of platforms) {
      if (!(PLATFORMS as readonly unknown[]).includes(entry)) {
        scoped.error(
          'unknown-enum-value',
          'platforms',
          `"${String(entry)}" is not a known platform (${PLATFORMS.join(', ')}).`,
        );
      }
    }
  }

  for (const key of ['minVersion', 'maxVersion'] as const) {
    const bound = rules[key];
    if (bound === undefined) {
      scoped.error('missing-field', key, `${key} is required (null for no bound).`);
    } else if (bound !== null && !isVersion(bound)) {
      scoped.error(
        'version-invalid',
        key,
        `${key} must be a semantic version like "2.5.0", or null.`,
      );
    }
  }

  const minVersion = typeof rules.minVersion === 'string' ? rules.minVersion : null;
  const maxVersion = typeof rules.maxVersion === 'string' ? rules.maxVersion : null;

  if (
    (rules.minVersion === null || isVersion(rules.minVersion)) &&
    (rules.maxVersion === null || isVersion(rules.maxVersion)) &&
    !isRangeSatisfiable({ minVersion, maxVersion })
  ) {
    scoped.error(
      'version-range-empty',
      'maxVersion',
      `No version can satisfy ">= ${String(minVersion)}" and "< ${String(maxVersion)}". ` +
        'Remember maxVersion is exclusive: for every 2.5.x, use min 2.5.0 and max 2.6.0.',
    );
  }
}

function validateImage(record: Record<string, unknown>, collector: IssueCollector): void {
  const image = record.image;
  if (image === undefined || image === null) return;

  if (!isPlainObject(image)) {
    collector.error('wrong-type', 'image', 'image must be an object or absent.');
    return;
  }

  const fields = image as Record<string, unknown>;
  const scoped = collector.scoped('image');

  for (const key of Object.keys(fields)) {
    if (!IMAGE_FIELDS.has(key)) {
      scoped.warn('unknown-field', key, `Unrecognised image field "${key}".`);
    }
  }

  if (typeof fields.path !== 'string' || !IMAGE_PATH_PATTERN.test(fields.path)) {
    scoped.error(
      'image-path-invalid',
      'path',
      'image.path must be a content-addressed WebP under images/, e.g. "images/reports-center-a3f91c22.webp".',
    );
  }

  for (const key of ['width', 'height'] as const) {
    const dimension = fields[key];
    if (!isInteger(dimension)) {
      scoped.error('image-dimension-invalid', key, `image.${key} must be an integer.`);
    } else if (
      (dimension as number) < IMAGE_MIN_DIMENSION ||
      (dimension as number) > IMAGE_MAX_DIMENSION
    ) {
      scoped.error(
        'image-dimension-invalid',
        key,
        `image.${key} must be between ${IMAGE_MIN_DIMENSION} and ${IMAGE_MAX_DIMENSION}.`,
      );
    }
  }

  const bytes = fields.bytes;
  if (!isInteger(bytes) || (bytes as number) < 1) {
    scoped.error('wrong-type', 'bytes', 'image.bytes must be a positive integer.');
  } else if ((bytes as number) > IMAGE_MAX_BYTES) {
    scoped.error(
      'image-too-large',
      'bytes',
      `The image is ${String(bytes)} bytes; the publish limit is ${IMAGE_MAX_BYTES}.`,
    );
  }

  if (typeof fields.sha256 !== 'string' || !SHA256_PATTERN.test(fields.sha256)) {
    scoped.error('image-hash-invalid', 'sha256', 'image.sha256 must be 64 lowercase hex characters.');
  }

  requireText(fields, 'alt', IMAGE_ALT_MAX_LENGTH, true, scoped);
}

function validateAction(
  record: Record<string, unknown>,
  options: RecordValidationOptions,
  collector: IssueCollector,
): void {
  const action = record.action;
  if (action === undefined || action === null) return;

  if (!isPlainObject(action)) {
    collector.error('wrong-type', 'action', 'action must be an object or absent.');
    return;
  }

  const fields = action as Record<string, unknown>;
  const scoped = collector.scoped('action');

  for (const key of Object.keys(fields)) {
    if (!ACTION_FIELDS.has(key)) {
      scoped.warn('unknown-field', key, `Unrecognised action field "${key}".`);
    }
  }

  requireText(fields, 'label', ACTION_LABEL_MAX_LENGTH, true, scoped);

  const type = fields.type;
  if (type === 'route') {
    if (!isRouteTarget(fields.target)) {
      scoped.error(
        'action-target-not-allowed',
        'target',
        `"${String(fields.target)}" is not a known route. An action may only point at a screen ` +
          'declared in ROUTE_TARGETS -- never at a URL or a deep link.',
      );
    }
  } else if (type === 'external') {
    const allowlist = options.externalHostAllowlist ?? EXTERNAL_HOST_ALLOWLIST;
    if (!isAllowedExternalUrl(fields.target, allowlist)) {
      scoped.error(
        'action-url-not-allowed',
        'target',
        'An external action must be an https URL, with no embedded credentials, ' +
          `on an allowlisted host (${allowlist.join(', ') || 'none configured'}).`,
      );
    }
  } else {
    scoped.error(
      'unknown-enum-value',
      'type',
      `action.type must be "route" or "external", not "${String(type)}".`,
    );
  }
}

function validateSignature(record: Record<string, unknown>, collector: IssueCollector): void {
  const signature = record.signature;
  if (signature === undefined || signature === null) return;
  if (typeof signature !== 'string' || signature.length === 0) {
    collector.error('wrong-type', 'signature', 'signature must be a non-empty string or null.');
  }
}

function validateAuthoredFields(
  record: Record<string, unknown>,
  collector: IssueCollector,
): void {
  requireEnum(record, 'status', STORED_STATUSES, collector);

  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (record[key] === undefined) {
      collector.error('missing-field', key, `${key} is required on an authored record.`);
    } else {
      const parsed = parseInstant(record[key]);
      if (!parsed.ok) reportInstantProblem(key, parsed.problem, collector);
    }
  }

  for (const key of ['publishedAt', 'archivedAt'] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const parsed = parseInstant(value);
    if (!parsed.ok) reportInstantProblem(key, parsed.problem, collector);
  }

  if (record.internalNote !== undefined && typeof record.internalNote !== 'string') {
    collector.error('wrong-type', 'internalNote', 'internalNote must be a string.');
  }
}

/**
 * Judgements that only make sense while authoring.
 *
 * None of these is a structural fault -- a published manifest may legitimately
 * contain a record that has just expired, and a device holding it must not
 * reject the file over that.
 */
function applyAuthoringJudgements(
  record: Record<string, unknown>,
  schedule: ScheduleWindow,
  options: RecordValidationOptions,
  collector: IssueCollector,
): void {
  const isLive = record.status === 'published' || record.status === 'paused';

  if (isLive && schedule.end !== null && schedule.end <= options.now) {
    collector.error(
      'end-in-past',
      'endAt',
      'This announcement ends in the past, so publishing it would show it to nobody.',
    );
  }

  if (schedule.start !== null) {
    const horizon = daysBetween(options.now, schedule.start);
    if (horizon > SCHEDULE_HORIZON_WARNING_DAYS) {
      collector.warn(
        'start-far-future-warning',
        'startAt',
        `This starts ${Math.round(horizon)} days from now -- check the date is what you meant.`,
      );
    }
  }

  const targeting = isPlainObject(record.targeting)
    ? (record.targeting as Record<string, unknown>)
    : null;

  if (record.category === 'feature' && targeting && targeting.minVersion === null) {
    collector.warn(
      'version-missing-warning',
      'targeting.minVersion',
      'A feature announcement with no minimum version will also reach installs too old to have the feature.',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function reportInstantProblem(
  path: string,
  problem: 'invalid' | 'no-offset',
  collector: IssueCollector,
): void {
  if (problem === 'no-offset') {
    collector.error(
      'instant-no-offset',
      path,
      `${path} has no timezone offset. Store an absolute instant, e.g. "2026-09-01T06:00:00Z" -- ` +
        'a bare local date means a different moment on every device.',
    );
  } else {
    collector.error(
      'instant-invalid',
      path,
      `${path} must be an ISO-8601 instant with an offset, e.g. "2026-09-01T06:00:00Z".`,
    );
  }
}

function requireText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  singleLine: boolean,
  collector: IssueCollector,
): void {
  const value = record[key];

  if (value === undefined) {
    collector.error('missing-field', key, `${key} is required.`);
    return;
  }
  if (typeof value !== 'string') {
    collector.error('wrong-type', key, `${key} must be a string.`);
    return;
  }
  if (value.trim().length === 0) {
    collector.error('text-empty', key, `${key} must not be empty.`);
    return;
  }
  if (value.length > maxLength) {
    collector.error(
      'text-too-long',
      key,
      `${key} is ${value.length} characters; the limit is ${maxLength}.`,
    );
  }

  const unsafe = singleLine ? UNSAFE_SINGLE_LINE : UNSAFE_ANYWHERE;
  if (unsafe.test(value)) {
    collector.error(
      'text-unsafe-characters',
      key,
      `${key} contains control characters or angle brackets. Announcement text is rendered as ` +
        'plain text and must never be able to read as markup.',
    );
  }
}

function requireEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  collector: IssueCollector,
): void {
  const value = record[key];
  if (value === undefined) {
    collector.error('missing-field', key, `${key} is required.`);
    return;
  }
  if (!allowed.includes(value as string)) {
    collector.error(
      'unknown-enum-value',
      key,
      `${key} must be one of ${allowed.join(', ')} -- got "${String(value)}".`,
    );
  }
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  collector: IssueCollector,
): void {
  const value = record[key];
  if (value === undefined) {
    collector.error('missing-field', key, `${key} is required.`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    collector.error('wrong-type', key, `${key} must be a number.`);
    return;
  }
  if (!Number.isInteger(value)) {
    collector.error('number-not-integer', key, `${key} must be a whole number.`);
    return;
  }
  if (value < min || value > max) {
    collector.error('number-out-of-range', key, `${key} must be between ${min} and ${max}.`);
  }
}

function isInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The lifecycle state the Manager displays.
 *
 * Derived from the stored status and the dates -- never stored, for the same
 * reason RUOOD Lab derives "used in formulas" rather than keeping a column: a
 * stored copy would disagree with the dates the moment one of them was edited.
 */
export function deriveLifecycleStatus(
  record: { status: string; startAt: string; endAt: string | null },
  now: number,
): 'draft' | 'scheduled' | 'active' | 'paused' | 'expired' | 'archived' {
  if (record.status === 'draft') return 'draft';
  if (record.status === 'archived') return 'archived';
  if (record.status === 'paused') return 'paused';

  const start = instantToEpoch(record.startAt);
  if (start === null) return 'draft';

  const end = record.endAt === null ? null : instantToEpoch(record.endAt);
  if (end !== null && now >= end) return 'expired';
  if (now < start) return 'scheduled';
  return 'active';
}

