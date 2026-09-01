/**
 * The wire contract between the Manager's server and its browser half.
 *
 * Types only, imported by both sides, so a route that changes shape breaks the
 * screen that reads it at compile time rather than at runtime in front of the
 * operator.
 *
 * Most of it is `core`'s own types passed straight through. Where a DTO exists
 * instead, it is because the `core` result carries something that cannot cross
 * a wire — `BuildResult.imageFiles` is a `Map<string, Buffer>` holding every
 * encoded image, which is the whole payload and none of the answer.
 */

import type {
  Channel,
  ExcludedRecord,
  PublishDiff,
  PublishStatus,
  PushOutcome,
  RepoStatus,
  Transition,
} from '@ruood/announcement-core';
import type {
  AuthoredAnnouncement,
  Category,
  LifecycleStatus,
  Platform,
  StoredStatus,
  Surface,
  ValidationIssue,
} from '@ruood/announcement-schema';

export type { Channel, PublishDiff, PublishStatus, PushOutcome, RepoStatus, Transition };

/**
 * What the repository knows about signing.
 *
 * `expectedKeyId` comes from the committed public key; `signedBy` from the
 * manifest actually published. The two disagreeing is the state worth shouting
 * about — it means every install is rejecting what is up there.
 */
export interface SigningState {
  /** The key this repository says its manifests must be signed by. */
  expectedKeyId: string | null;
  /** True when a usable private key was found where the Manager looks. */
  keyAvailable: boolean;
  keyPath: string;
  /** Anything wrong with the public key record, ready to show. */
  problem: string | null;
}

/** One row of the record list. Enough to search, sort and show; never the whole record. */
export interface RecordSummary {
  id: string;
  title: string;
  body: string;
  rev: number;
  category: Category;
  priority: number;
  surface: Surface;
  status: StoredStatus;
  /** Derived from the dates on the server's clock, never stored. */
  lifecycle: LifecycleStatus;
  startAt: string;
  endAt: string | null;
  updatedAt: string;
  platforms: Platform[];
  hasImage: boolean;
  hasAction: boolean;
  /** Errors this record would contribute to a build. Drives the list's badges. */
  errorCount: number;
  warningCount: number;
}

export interface PublishedState {
  revision: number;
  bytes: number;
  records: number;
  images: number;
  generatedAt: string;
  paused: boolean;
  /** The key id in the published file, or `null` if it carries no signature. */
  signedBy: string | null;
}

/**
 * Git may legitimately not be usable — a directory that was never `init`ed, a
 * repository whose index is locked. That is a state to show, not an error that
 * takes the whole screen down, so it is modelled rather than thrown.
 */
export type GitState =
  | { ok: true; status: RepoStatus }
  | { ok: false; reason: string };

/** Everything the shell needs, in one round trip. */
export interface ManagerState {
  repo: { root: string; name: string };
  /** The server's clock, so the UI derives the same lifecycle states it does. */
  now: string;
  records: RecordSummary[];
  counts: Partial<Record<LifecycleStatus, number>>;
  /** Files in `content/` that would not parse. Surfaced, never swallowed. */
  failures: { file: string; error: string }[];
  retiredIds: string[];
  contentRevision: number;
  published: PublishedState | null;
  /** The staging channel, which additionally carries drafts. */
  publishedStaging: PublishedState | null;
  signing: SigningState;
  git: GitState;
  /** True when `dist/` no longer matches what `content/` would produce. */
  distStale: boolean;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface RecordDetail {
  record: AuthoredAnnouncement;
  lifecycle: LifecycleStatus;
  /** What `applyTransition` would accept from here — what the UI greys out from. */
  transitions: Transition[];
  validation: ValidationReport;
  /** Present only when an image is attached; a cache-busting URL. */
  imageUrl: string | null;
}

export interface NewRecordRequest {
  id: string;
  title: string;
  body: string;
  startAt?: string;
  endAt?: string | null;
  surface?: Surface;
  category?: Category;
  priority?: number;
}

/**
 * A record edit.
 *
 * Deliberately not `Partial<AuthoredAnnouncement>`: `id`, `status` and `rev`
 * each have their own operation, and `core`'s `applyEdits` refuses them. The
 * type says so here too, so the browser cannot even ask.
 */
export interface EditRecordRequest {
  edits: Record<string, unknown>;
}

export interface TransitionRequest {
  transition: Transition;
}

export interface DeleteRecordRequest {
  /**
   * Required, and named for what it actually does. Deleting retires the id for
   * ever; a `DELETE` that needed no body would make the irreversible half of
   * the operation the easy half.
   */
  acknowledgeIdRetired: true;
}

export interface DeleteRecordResponse {
  deleted: string;
  retiredIds: string[];
}

export interface IdCheckResponse {
  id: string;
  available: boolean;
  reason?: 'duplicate' | 'retired' | 'format';
  /** A free alternative, when the asked-for one is taken. */
  suggestion: string | null;
}

export interface ImageAttachResponse extends RecordDetail {
  encoded: {
    width: number;
    height: number;
    bytes: number;
    originalBytes: number;
    /** Which rung of the encoder's quality ladder was used. */
    quality: number;
  };
}

/** `BuildResult` without the megabytes of image data it also carries. */
export interface BuildSummary {
  ok: boolean;
  channel: Channel;
  /** The key the manifest was signed with, or `null` for an unsigned build. */
  signedBy: string | null;
  revision: number;
  bytes: number;
  records: number;
  images: number;
  excluded: ExcludedRecord[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  problems: string[];
}

export interface PublishRequest {
  dryRun: boolean;
  /** Defaults to production. Staging additionally publishes drafts. */
  channel?: Channel;
  /** Sign with the repository's key. Refused if the key cannot be loaded. */
  sign?: boolean;
  acceptWarnings?: boolean;
  noPush?: boolean;
  /** The global kill switch. Omitted means "leave it as it is" — it is sticky. */
  paused?: boolean;
  message?: string;
}

export interface PublishResponse {
  status: PublishStatus;
  blockedBy?: string;
  commit?: string;
  push?: PushOutcome;
  build: BuildSummary;
  diff: PublishDiff;
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
}

export interface RevertRequest {
  commit: string;
}

export interface ApiError {
  error: string;
  /** Set when a request was refused by validation rather than by being malformed. */
  issues?: ValidationIssue[];
}
