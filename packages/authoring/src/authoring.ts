/**
 * Creating and transitioning records.
 *
 * The lifecycle in code. Every transition is a pure function from a record to a
 * record, so the CLI and the Phase 2 UI perform the same operation rather than
 * each writing their own idea of what "archive" means.
 *
 * ```
 * Draft ──▶ Scheduled ──▶ Active ──▶ Expired ──▶ Archived
 *   ▲          │            │  ▲         │           │
 *   └──────────┴────────────┘  │         └───────────┘
 *                           Paused ◀────────┘
 * ```
 *
 * Scheduled / Active / Expired are DERIVED from the dates and never stored, so
 * they are absent from `StoredStatus` and from everything here.
 */

import {
  DEFAULT_NEW_RECORD,
  type AuthoredAnnouncement,
  type StoredStatus,
} from './defaults';
import { toCanonicalInstant } from '@ruood/announcement-schema';

export interface NewRecordInput {
  id: string;
  /** Optional: an announcement may be a picture and nothing else. */
  title?: string;
  /** Optional, on the same terms as `title`. */
  body?: string;
  now: number;
  startAt?: string;
  endAt?: string | null;
}

/** A draft, with the defaults that are right for almost every announcement. */
export function createRecord(input: NewRecordInput): AuthoredAnnouncement {
  const stamp = toCanonicalInstant(input.now);

  return {
    ...DEFAULT_NEW_RECORD,
    id: input.id,
    // Always written, even when empty, so every record has the same shape and a
    // canonical diff shows a cleared title as a cleared title rather than as a
    // field that vanished. Absent and empty mean the same thing to the
    // validator; an image-only announcement is the case that needs both.
    title: input.title ?? '',
    body: input.body ?? '',
    startAt: input.startAt ?? stamp,
    endAt: input.endAt === undefined ? null : input.endAt,
    status: 'draft',
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export type Transition = 'publish' | 'pause' | 'resume' | 'archive' | 'restore';

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

/**
 * Which transitions are legal from each stored state.
 *
 * A table rather than a chain of ifs, so "can I do this?" and "do it" read the
 * same rules — `availableTransitions` is what the UI greys out from.
 */
const ALLOWED: Record<StoredStatus, Transition[]> = {
  draft: ['publish', 'archive'],
  published: ['pause', 'archive'],
  paused: ['resume', 'archive'],
  archived: ['restore'],
};

export function availableTransitions(record: AuthoredAnnouncement): Transition[] {
  return [...ALLOWED[record.status]];
}

export function applyTransition(
  record: AuthoredAnnouncement,
  transition: Transition,
  now: number,
): AuthoredAnnouncement {
  if (!ALLOWED[record.status].includes(transition)) {
    throw new TransitionError(
      `Cannot ${transition} a record that is "${record.status}". ` +
        `Available: ${ALLOWED[record.status].join(', ') || 'none'}.`,
    );
  }

  const stamp = toCanonicalInstant(now);
  const next: AuthoredAnnouncement = { ...record, updatedAt: stamp };

  switch (transition) {
    case 'publish':
      next.status = 'published';
      // Stamped once, on first publication — it is the record's own history,
      // not a copy of the last commit date, which git already has.
      next.publishedAt = record.publishedAt ?? stamp;
      break;

    case 'pause':
      next.status = 'paused';
      break;

    case 'resume':
      next.status = 'published';
      break;

    case 'archive':
      next.status = 'archived';
      next.archivedAt = stamp;
      break;

    case 'restore':
      // Back to draft, never straight to published: a record being un-archived
      // has dates that are probably in the past, and it should pass validation
      // again before it reaches an install.
      next.status = 'draft';
      next.archivedAt = null;
      break;
  }

  return next;
}

/**
 * Bumps `rev`, which RE-SHOWS the announcement to everyone who has seen it.
 *
 * Separate from every other edit on purpose. Correcting a typo and deciding
 * that a million devices should see the message again are different intentions,
 * and conflating them means one of the two is always wrong.
 */
export function bumpRevision(
  record: AuthoredAnnouncement,
  now: number,
): AuthoredAnnouncement {
  return { ...record, rev: record.rev + 1, updatedAt: toCanonicalInstant(now) };
}

export function touch(
  record: AuthoredAnnouncement,
  changes: Partial<AuthoredAnnouncement>,
  now: number,
): AuthoredAnnouncement {
  return { ...record, ...changes, updatedAt: toCanonicalInstant(now) };
}
