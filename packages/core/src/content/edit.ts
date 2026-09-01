/**
 * Editing an existing record's content fields.
 *
 * `touch` takes any `Partial<AuthoredAnnouncement>`, which is right for an
 * internal caller that already knows what it is doing — the image command
 * stamping an `image` object, a transition writing a status. It is the wrong
 * shape for an editor form, because a form is driven by whatever arrives from
 * outside and a `Partial<>` lets `id`, `status` and `rev` through.
 *
 * Each of those three has its own operation, and for a reason the architecture
 * is explicit about:
 *
 *   id      immutable. Changing it produces a different announcement, and the
 *           old id keys impression state on every device that ever saw it.
 *   status  moves only through `applyTransition`, which knows the legal moves.
 *   rev     is the RE-SHOW switch. `bumpRevision` exists so that correcting a
 *           typo and telling a million devices to look again stay different
 *           intentions.
 *
 * So the editable set is closed, and anything outside it is refused loudly
 * rather than dropped quietly — a caller sending `status` has a bug, and
 * silently ignoring it would leave the sender believing it had been saved.
 *
 * Pure, like the rest of `content/authoring.ts`. Validation is the caller's
 * job: the CLI wants an exit code and the UI wants issues to hang off form
 * fields, and both call `validateAnnouncementRecord` on the result.
 */

import { toCanonicalInstant, type AuthoredAnnouncement } from '@ruood/announcement-schema';

/**
 * The fields an editor may write.
 *
 * `image` is here only so it can be CLEARED. Attaching one means encoding
 * bytes, hashing them and writing an original into `content/media/`, which is
 * `encodeAnnouncementImage`'s job — an editor that could hand-write an `image`
 * object could name a file that does not exist or a hash that does not match,
 * and the build would refuse every subsequent publish.
 */
export const EDITABLE_FIELDS = [
  'title',
  'body',
  'category',
  'priority',
  'startAt',
  'endAt',
  'display',
  'targeting',
  'action',
  'image',
  'internalNote',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * `null` clears an optional field.
 *
 * The distinction matters over a wire: `undefined` does not survive JSON, so
 * "remove the action" has to be expressible as a value. `endAt` is the one
 * where `null` is not a removal but the meaning itself — no end date.
 */
export type RecordEdits = {
  [K in EditableField]?: K extends 'action' | 'image' | 'internalNote'
    ? AuthoredAnnouncement[K] | null
    : AuthoredAnnouncement[K];
};

const EDITABLE = new Set<string>(EDITABLE_FIELDS);

/** Fields that are removed rather than stored when the edit is `null`. */
const CLEARABLE = new Set<string>(['action', 'image', 'internalNote']);

export class EditError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'EditError';
  }
}

/**
 * Applies content edits and stamps `updatedAt`.
 *
 * Only the keys actually present are touched, so an editor can send one field
 * or all of them and a field it did not send is a field it did not change.
 */
export function applyEdits(
  record: AuthoredAnnouncement,
  edits: RecordEdits,
  now: number,
): AuthoredAnnouncement {
  const next = { ...record } as AuthoredAnnouncement & Record<string, unknown>;

  for (const [field, value] of Object.entries(edits)) {
    if (value === undefined) continue;

    if (!EDITABLE.has(field)) {
      throw new EditError(
        `"${field}" is not an editable field. Editable: ${EDITABLE_FIELDS.join(', ')}.` +
          (field === 'rev'
            ? ' Use bumpRevision — it re-shows the announcement to everyone who saw it.'
            : field === 'status'
              ? ' Use applyTransition, which knows which moves are legal.'
              : field === 'id'
                ? ' An id is immutable; it keys impression state on every device.'
                : ''),
        field,
      );
    }

    if (value === null && CLEARABLE.has(field)) {
      delete next[field];
      continue;
    }

    next[field] = value;
  }

  next.updatedAt = toCanonicalInstant(now);
  return next;
}

/** Whether a field name is one an editor may write. */
export function isEditableField(field: string): field is EditableField {
  return EDITABLE.has(field);
}
