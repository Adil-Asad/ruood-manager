/**
 * Manifest-level validation: the rules that are about the SET of records rather
 * than any one of them.
 *
 * Three of them exist because there is no feedback channel. A duplicate id, two
 * overlapping modals or a file that has quietly grown past what a phone should
 * download are all conditions you would otherwise learn about from a user, or
 * never.
 */

import {
  MANIFEST_MAX_BYTES,
  MANIFEST_MAX_RECORDS,
  MINIMUM_SCHEMA_VERSION,
  SIMULTANEOUS_MODAL_WARNING_THRESHOLD,
  SUPPORTED_SCHEMA_VERSION,
} from './constants';
import { IssueCollector, type ValidationResult } from './issues';
import { instantToEpoch, parseInstant } from './instant';
import {
  isPlainObject,
  validateAnnouncementRecord,
  type RecordValidationOptions,
} from './validate-record';

const MANIFEST_FIELDS = new Set([
  'schemaVersion',
  'revision',
  'generatedAt',
  'paused',
  'announcements',
  // Both optional and both absent from an unsigned build. They are listed here
  // so a signed manifest does not warn about its own signature.
  'keyId',
  'signature',
]);

export interface ManifestValidationOptions {
  now: number;
  externalHostAllowlist?: readonly string[];
  /**
   * Byte length of the serialised manifest. Passed in rather than measured
   * here so this module never has to know about an encoding, and so the caller
   * can measure exactly the bytes it is about to write.
   */
  serialisedBytes?: number;
  schemaVersion?: number;
}

export function validateManifest(
  value: unknown,
  options: ManifestValidationOptions,
): ValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(value)) {
    collector.error('not-an-object', '', 'A manifest must be a JSON object.');
    return collector.result();
  }

  const manifest = value as Record<string, unknown>;

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) {
      collector.warn('unknown-field', key, `Unrecognised manifest field "${key}".`);
    }
  }

  validateSchemaVersion(manifest, collector);
  validateRevision(manifest, collector);
  validateGeneratedAt(manifest, collector);
  validatePausedFlag(manifest, collector);
  validateSize(options, collector);

  const records = manifest.announcements;
  if (records === undefined) {
    collector.error('missing-field', 'announcements', 'announcements is required.');
    return collector.result();
  }
  if (!Array.isArray(records)) {
    collector.error('wrong-type', 'announcements', 'announcements must be an array.');
    return collector.result();
  }
  if (records.length > MANIFEST_MAX_RECORDS) {
    collector.error(
      'manifest-too-many-records',
      'announcements',
      `A manifest holds at most ${MANIFEST_MAX_RECORDS} records; this one has ${records.length}. ` +
        'Expired records belong in the archive, not in the published file.',
    );
  }

  const recordOptions: RecordValidationOptions = {
    now: options.now,
    mode: 'published',
    schemaVersion: options.schemaVersion ?? SUPPORTED_SCHEMA_VERSION,
    ...(options.externalHostAllowlist
      ? { externalHostAllowlist: options.externalHostAllowlist }
      : {}),
  };

  records.forEach((record, index) => {
    const result = validateAnnouncementRecord(record, recordOptions);
    for (const issue of [...result.errors, ...result.warnings]) {
      const path = issue.path
        ? `announcements[${index}].${issue.path}`
        : `announcements[${index}]`;
      collector.absorb([{ ...issue, path }]);
    }
  });

  validateUniqueIds(records, collector);
  validateModalPressure(records, collector);

  return collector.result();
}

// ---------------------------------------------------------------------------

function validateSchemaVersion(
  manifest: Record<string, unknown>,
  collector: IssueCollector,
): void {
  const version = manifest.schemaVersion;

  if (version === undefined) {
    collector.error('missing-field', 'schemaVersion', 'schemaVersion is required.');
    return;
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    collector.error('wrong-type', 'schemaVersion', 'schemaVersion must be an integer.');
    return;
  }
  if (version < MINIMUM_SCHEMA_VERSION || version > SUPPORTED_SCHEMA_VERSION) {
    collector.error(
      'schema-version-unsupported',
      'schemaVersion',
      `This build reads schema versions ${MINIMUM_SCHEMA_VERSION}-${SUPPORTED_SCHEMA_VERSION}; ` +
        `the manifest declares ${version}.`,
    );
  }
}

function validateRevision(
  manifest: Record<string, unknown>,
  collector: IssueCollector,
): void {
  const revision = manifest.revision;
  if (revision === undefined) {
    collector.error('missing-field', 'revision', 'revision is required.');
  } else if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    // Zero is legal and meaningful: it is the empty manifest a freshly created
    // repository publishes, so that a client fetching before the first real
    // publish reads a well-formed file rather than a 404.
    collector.error('wrong-type', 'revision', 'revision must be a non-negative integer.');
  }
}

function validateGeneratedAt(
  manifest: Record<string, unknown>,
  collector: IssueCollector,
): void {
  if (manifest.generatedAt === undefined) {
    collector.error('missing-field', 'generatedAt', 'generatedAt is required.');
    return;
  }
  const parsed = parseInstant(manifest.generatedAt);
  if (!parsed.ok) {
    collector.error(
      parsed.problem === 'no-offset' ? 'instant-no-offset' : 'instant-invalid',
      'generatedAt',
      'generatedAt must be an ISO-8601 instant with an offset.',
    );
  }
}

function validatePausedFlag(
  manifest: Record<string, unknown>,
  collector: IssueCollector,
): void {
  if (manifest.paused === undefined) {
    collector.error('missing-field', 'paused', 'paused is required (false in normal operation).');
  } else if (typeof manifest.paused !== 'boolean') {
    collector.error('wrong-type', 'paused', 'paused must be a boolean.');
  }
}

function validateSize(
  options: ManifestValidationOptions,
  collector: IssueCollector,
): void {
  if (options.serialisedBytes === undefined) return;
  if (options.serialisedBytes <= MANIFEST_MAX_BYTES) return;

  collector.error(
    'manifest-too-large',
    '',
    `The manifest is ${options.serialisedBytes} bytes; the limit is ${MANIFEST_MAX_BYTES}. ` +
      'Every install downloads this file.',
  );
}

function validateUniqueIds(records: readonly unknown[], collector: IssueCollector): void {
  const seen = new Map<string, number>();

  records.forEach((record, index) => {
    if (!isPlainObject(record)) return;
    const id = (record as Record<string, unknown>).id;
    if (typeof id !== 'string') return;

    const first = seen.get(id);
    if (first === undefined) {
      seen.set(id, index);
      return;
    }
    collector.error(
      'id-duplicate',
      `announcements[${index}].id`,
      `The id "${id}" also appears at announcements[${first}]. ` +
        'Ids key the impression state on every device, so two records cannot share one.',
    );
  });
}

/**
 * How many modal records are live simultaneously, and whether two records in
 * the same category overlap.
 *
 * A sweep over interval endpoints rather than a pairwise comparison, so the
 * cost stays linear-ish and the answer is exact: the maximum concurrency can
 * only change at a start or an end.
 */
interface RecordInterval {
  index: number;
  start: number;
  /** `Infinity` for a record with no end date. */
  end: number;
  category: string;
  modal: boolean;
}

function validateModalPressure(
  records: readonly unknown[],
  collector: IssueCollector,
): void {
  const intervals = collectIntervals(records);
  if (intervals.length === 0) return;

  reportCategoryOverlaps(intervals, collector);
  reportModalPeak(intervals, collector);
}

/** Records whose window can be read. One that cannot is already an error. */
function collectIntervals(records: readonly unknown[]): RecordInterval[] {
  const intervals: RecordInterval[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!isPlainObject(record)) continue;

    const fields = record as Record<string, unknown>;
    const start = instantToEpoch(fields.startAt);
    if (start === null) continue;

    const end =
      fields.endAt === null || fields.endAt === undefined
        ? Number.POSITIVE_INFINITY
        : instantToEpoch(fields.endAt);
    if (end === null) continue;

    const display = isPlainObject(fields.display)
      ? (fields.display as Record<string, unknown>)
      : null;

    intervals.push({
      index,
      start,
      end,
      category: typeof fields.category === 'string' ? fields.category : 'unknown',
      modal: display?.surface === 'modal' && fields.paused !== true,
    });
  }

  return intervals;
}

function reportCategoryOverlaps(
  intervals: readonly RecordInterval[],
  collector: IssueCollector,
): void {
  for (let a = 0; a < intervals.length; a += 1) {
    for (let b = a + 1; b < intervals.length; b += 1) {
      const left = intervals[a]!;
      const right = intervals[b]!;
      if (left.category !== right.category) continue;
      if (left.start >= right.end || right.start >= left.end) continue;

      collector.warn(
        'overlapping-category-warning',
        `announcements[${right.index}]`,
        `This overlaps announcements[${left.index}] in time and both are "${left.category}". ` +
          'Only one modal is shown per session, so the lower-priority one may wait a long time.',
      );
    }
  }
}

/**
 * Peak simultaneous modals, by sweeping interval endpoints -- the concurrency
 * can only change at a start or an end, so the maximum is exact.
 */
function reportModalPeak(
  intervals: readonly RecordInterval[],
  collector: IssueCollector,
): void {
  const events: { at: number; delta: number }[] = [];

  for (const entry of intervals) {
    if (!entry.modal) continue;
    events.push({ at: entry.start, delta: 1 });
    if (Number.isFinite(entry.end)) events.push({ at: entry.end, delta: -1 });
  }

  // An end and a start at the same instant must not read as an overlap, so
  // ends (-1) sort before starts (+1).
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let live = 0;
  let peak = 0;
  for (const event of events) {
    live += event.delta;
    if (live > peak) peak = live;
  }

  if (peak > SIMULTANEOUS_MODAL_WARNING_THRESHOLD) {
    collector.warn(
      'too-many-modals-warning',
      'announcements',
      `Up to ${peak} modal announcements are live at once. At one modal per session, ` +
        'the last of them may not be seen for days.',
    );
  }
}
