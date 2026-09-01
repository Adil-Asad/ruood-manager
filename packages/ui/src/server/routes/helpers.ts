/**
 * The shapes the routes hand back, assembled in one place.
 *
 * `requireRecord` and `reportIssues` do the same job in the CLI's
 * `commands/shared.ts`. Both front ends load a record the same way and validate
 * it the same way, because both are calling the same `core` and the same
 * validator — the difference is only that one produces an exit code and the
 * other produces JSON.
 */

import {
  idRegistryFrom,
  availableTransitions,
  loadContent,
  type ContentSnapshot,
} from '@ruood/announcement-core';
import {
  deriveLifecycleStatus,
  validateAnnouncementRecord,
  type AuthoredAnnouncement,
  type LifecycleStatus,
  type ValidationResult,
} from '@ruood/announcement-schema';

import type { ServerContext } from '../context';
import type { RecordDetail, RecordSummary, ValidationReport } from '../../shared/api';

export function lifecycleOf(record: AuthoredAnnouncement, now: number): LifecycleStatus {
  return deriveLifecycleStatus(
    { status: record.status, startAt: record.startAt, endAt: record.endAt ?? null },
    now,
  );
}

/**
 * Validates one record in the same mode and against the same registry the
 * build will use, so what the editor shows is what publishing will say.
 */
export function validateOne(
  record: AuthoredAnnouncement,
  snapshot: ContentSnapshot,
  now: number,
): ValidationResult {
  return validateAnnouncementRecord(record, {
    now,
    mode: 'authored',
    idRegistry: idRegistryFrom(snapshot),
    // Its own id is already in the registry; without this the duplicate check
    // fires on the record being edited.
    editingId: record.id,
  });
}

export function reportOf(result: ValidationResult): ValidationReport {
  return { errors: result.errors, warnings: result.warnings };
}

/**
 * The image URL carries the content hash.
 *
 * Published image names are content-addressed for exactly this reason, and the
 * preview inherits it: replace an image and the URL changes, so no browser can
 * show the previous one from its cache.
 */
export function imageUrlFor(record: AuthoredAnnouncement): string | null {
  if (!record.image) return null;
  return `/api/records/${encodeURIComponent(record.id)}/image?v=${record.image.sha256.slice(0, 8)}`;
}

export function detailOf(
  record: AuthoredAnnouncement,
  snapshot: ContentSnapshot,
  now: number,
): RecordDetail {
  return {
    record,
    lifecycle: lifecycleOf(record, now),
    transitions: availableTransitions(record),
    validation: reportOf(validateOne(record, snapshot, now)),
    imageUrl: imageUrlFor(record),
  };
}

export function summarise(snapshot: ContentSnapshot, now: number): RecordSummary[] {
  return snapshot.records.map(({ record }) => {
    const validation = validateOne(record, snapshot, now);

    return {
      id: record.id,
      title: record.title,
      body: record.body,
      rev: record.rev,
      category: record.category,
      priority: record.priority,
      surface: record.display.surface,
      status: record.status,
      lifecycle: lifecycleOf(record, now),
      startAt: record.startAt,
      endAt: record.endAt ?? null,
      updatedAt: record.updatedAt,
      platforms: record.targeting.platforms,
      hasImage: record.image !== undefined,
      hasAction: record.action !== undefined,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
    };
  });
}

export async function snapshotOf(ctx: ServerContext): Promise<ContentSnapshot> {
  return loadContent(ctx.paths);
}

export function findRecord(
  snapshot: ContentSnapshot,
  id: string,
): AuthoredAnnouncement | undefined {
  return snapshot.records.find((entry) => entry.id === id)?.record;
}

/**
 * A refusal the browser can act on.
 *
 * Thrown rather than returned so a route reads as a straight line; `app.ts`
 * turns it into a status and a body.
 */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: ValidationResult['errors'],
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export function notFound(id: string): RequestError {
  return new RequestError(404, `No announcement with id "${id}".`);
}
