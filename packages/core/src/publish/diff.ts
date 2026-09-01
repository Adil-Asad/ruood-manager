/**
 * What a publish would change.
 *
 * Pure, and computed from the two manifests plus the two image sets — never
 * from git. It runs BEFORE anything is written, which is the whole point: the
 * one thing that reliably stops a wrong publish is seeing, in words, that it
 * removes an announcement you did not mean to remove.
 *
 * A record counts as modified when any published field differs, `rev`
 * included — and `rev` is called out separately, because bumping it re-shows
 * the announcement to everyone who has already seen it. That is the single
 * most consequential thing a publish can do and it must never be buried in a
 * list of field names.
 */

import { canonicalCompactJson, type AnnouncementManifest, type PublishedAnnouncement } from '@ruood/announcement-schema';

export interface RecordChange {
  id: string;
  /** Field names that differ, sorted. */
  fields: string[];
  /** True when `rev` moved — impression counters reset on every device. */
  resetsImpressions: boolean;
}

export interface ImageChange {
  path: string;
  bytes: number;
}

export interface PublishDiff {
  added: PublishedAnnouncement[];
  removed: PublishedAnnouncement[];
  modified: RecordChange[];
  unchanged: string[];

  imagesAdded: ImageChange[];
  imagesRemoved: ImageChange[];

  manifestBytesBefore: number;
  manifestBytesAfter: number;

  /** Kill-switch transitions, which deserve their own line in any summary. */
  pausedChanged: { from: boolean; to: boolean } | null;
  revisionFrom: number | null;
  revisionTo: number;

  /** True when nothing at all would change. */
  empty: boolean;
}

export interface ImageInventory {
  /** Manifest-relative path (`images/x-a1b2c3d4.webp`) to byte length. */
  [path: string]: number;
}

export interface DiffInput {
  before: AnnouncementManifest | null;
  after: AnnouncementManifest;
  imagesBefore: ImageInventory;
  imagesAfter: ImageInventory;
  manifestBytesBefore: number;
  manifestBytesAfter: number;
}

export function diffPublish(input: DiffInput): PublishDiff {
  const beforeRecords = indexById(input.before?.announcements ?? []);
  const afterRecords = indexById(input.after.announcements);

  const added: PublishedAnnouncement[] = [];
  const removed: PublishedAnnouncement[] = [];
  const modified: RecordChange[] = [];
  const unchanged: string[] = [];

  for (const [id, record] of afterRecords) {
    const previous = beforeRecords.get(id);
    if (!previous) {
      added.push(record);
      continue;
    }

    const fields = changedFields(previous, record);
    if (fields.length === 0) {
      unchanged.push(id);
    } else {
      modified.push({ id, fields, resetsImpressions: previous.rev !== record.rev });
    }
  }

  for (const [id, record] of beforeRecords) {
    if (!afterRecords.has(id)) removed.push(record);
  }

  const imagesAdded = imageDelta(input.imagesAfter, input.imagesBefore);
  const imagesRemoved = imageDelta(input.imagesBefore, input.imagesAfter);

  const pausedBefore = input.before?.paused ?? false;
  const pausedChanged =
    input.before && pausedBefore !== input.after.paused
      ? { from: pausedBefore, to: input.after.paused }
      : null;

  const empty =
    added.length === 0 &&
    removed.length === 0 &&
    modified.length === 0 &&
    imagesAdded.length === 0 &&
    imagesRemoved.length === 0 &&
    pausedChanged === null;

  return {
    added: added.sort(byId),
    removed: removed.sort(byId),
    modified: modified.sort((a, b) => compare(a.id, b.id)),
    unchanged: unchanged.sort(compare),
    imagesAdded,
    imagesRemoved,
    manifestBytesBefore: input.manifestBytesBefore,
    manifestBytesAfter: input.manifestBytesAfter,
    pausedChanged,
    revisionFrom: input.before?.revision ?? null,
    revisionTo: input.after.revision,
    empty,
  };
}

/**
 * Which top-level fields differ.
 *
 * Compared through the canonical form, so key order and whitespace cannot
 * register as a change — the reason canonical JSON is in the schema package
 * rather than being a build detail.
 */
function changedFields(
  before: PublishedAnnouncement,
  after: PublishedAnnouncement,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];

  for (const key of keys) {
    const left = (before as unknown as Record<string, unknown>)[key];
    const right = (after as unknown as Record<string, unknown>)[key];
    if (canonicalCompactJson(left ?? null) !== canonicalCompactJson(right ?? null)) {
      changed.push(key);
    }
  }

  return changed.sort();
}

function imageDelta(from: ImageInventory, against: ImageInventory): ImageChange[] {
  return Object.keys(from)
    .filter((path) => !(path in against))
    .sort()
    .map((path) => ({ path, bytes: from[path]! }));
}

function indexById(
  records: readonly PublishedAnnouncement[],
): Map<string, PublishedAnnouncement> {
  return new Map(records.map((record) => [record.id, record]));
}

function byId(a: PublishedAnnouncement, b: PublishedAnnouncement): number {
  return compare(a.id, b.id);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A human summary, used by the CLI's confirmation and by `publish --dry-run`. */
export function formatDiff(diff: PublishDiff): string {
  if (diff.empty) return 'No changes — dist/ is already what content/ produces.';

  const lines: string[] = [];
  const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));

  for (const record of diff.added) lines.push(`  + ${record.id}  (${record.display.surface})`);
  for (const change of diff.modified) {
    const reset = change.resetsImpressions ? '  [RE-SHOWS to everyone who saw it]' : '';
    lines.push(`  ~ ${change.id}  ${change.fields.join(', ')}${reset}`);
  }
  for (const record of diff.removed) lines.push(`  - ${record.id}`);

  if (diff.imagesAdded.length > 0 || diff.imagesRemoved.length > 0) {
    lines.push('');
    for (const image of diff.imagesAdded) {
      lines.push(`  + ${image.path}  (${formatBytes(image.bytes)})`);
    }
    for (const image of diff.imagesRemoved) lines.push(`  - ${image.path}`);
  }

  if (diff.pausedChanged) {
    lines.push('');
    lines.push(
      diff.pausedChanged.to
        ? '  !! KILL SWITCH ON — every install will show nothing'
        : '  !! kill switch off — announcements resume',
    );
  }

  lines.push('');
  lines.push(
    `  manifest ${formatBytes(diff.manifestBytesBefore)} -> ${formatBytes(diff.manifestBytesAfter)}` +
      ` (${sign(diff.manifestBytesAfter - diff.manifestBytesBefore)} bytes),` +
      ` revision ${diff.revisionFrom ?? '-'} -> ${diff.revisionTo}`,
  );

  return lines.join('\n');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
