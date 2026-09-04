/**
 * The announcements repository, as announcements.
 *
 * `repository.ts` knows about blobs, trees and refs. This knows about records —
 * and it is the layer the app's screens actually use, so that no screen ever
 * has to think about a tree entry.
 *
 * ## It mirrors `core/src/content/store.ts` deliberately
 *
 * That file does the same job against a working copy. This one does it over
 * the API. They are two transports for one set of rules, and the rules
 * themselves — what a record is, what an edit means, which ids are retired —
 * live in `@ruood/announcement-authoring` and `@ruood/announcement-schema`
 * where both can reach them.
 *
 * What must NOT happen is a second opinion about any of that. If a rule appears
 * here that is not in `authoring`, the phone and the build have started to
 * disagree, and the symptom will be a record that saves on the phone and is
 * refused by the build with nothing to point at.
 *
 * ## One commit per operation, always
 *
 * Attaching an image writes a record and an original. Deleting writes a
 * removal and a retired-id ledger entry. Each is a single commit, because a
 * repository observed between two of them is a repository in a state the build
 * would refuse — a record whose image is missing, or an id freed for reuse.
 *
 * ## A corrupt ledger refuses the load
 *
 * `retired-ids.json` is the only record of which ids can never come back, and
 * a reused id inherits the previous announcement's impression counters on every
 * device. Reading an unparseable ledger as "nothing is retired" would be the
 * one failure this project has consistently refused to allow, so it throws.
 */

import {
  ANNOUNCEMENTS_DIR,
  CONTENT_DIR,
  MEDIA_DIR,
  RETIRED_IDS_FILE,
  idFromRecordFile,
  mediaFile,
  mediaOf,
  recordFile,
} from '@ruood/announcement-authoring';
import {
  canonicalJson,
  type AuthoredAnnouncement,
  type IdRegistry,
} from '@ruood/announcement-schema';

import { GitHubError, type FileWrite, type GitHubClient } from './repository';

/** A record that would not parse. Surfaced, never swallowed. */
export interface LoadFailure {
  path: string;
  error: string;
}

export interface ContentSnapshot {
  /** The commit this was read at. Every write is built on it. */
  commit: string;
  records: AuthoredAnnouncement[];
  failures: LoadFailure[];
  retiredIds: string[];
  /** The stored original for each id, if there is one. */
  media: Record<string, { path: string; sha: string; extension: string }>;
  /** Blob shas by path, so an unchanged file is never fetched twice. */
  shas: Record<string, string>;
}

/**
 * Blob content by sha.
 *
 * A git blob sha is a hash of the content, so a sha that has not changed names
 * content that has not changed. Passing the previous snapshot's cache into the
 * next load means a refresh costs one tree listing plus only the records that
 * actually moved — which on a repository of fifty announcements is usually
 * zero requests.
 */
export type BlobCache = Map<string, string>;

export function emptyCache(): BlobCache {
  return new Map();
}

export async function loadContent(
  client: GitHubClient,
  cache: BlobCache = emptyCache(),
): Promise<ContentSnapshot> {
  const commit = await client.head();
  const files = await client.listFiles(commit, `${CONTENT_DIR}/`);

  const shas: Record<string, string> = {};
  for (const file of files) shas[file.path] = file.sha;

  const records: AuthoredAnnouncement[] = [];
  const failures: LoadFailure[] = [];
  const media: ContentSnapshot['media'] = {};

  for (const file of files) {
    const asMedia = mediaOf(file.path);
    if (asMedia) {
      media[asMedia.id] = { path: file.path, sha: file.sha, extension: asMedia.extension };
      continue;
    }
  }

  // Records are fetched concurrently — each is a small independent blob, and
  // doing them in series is a visible pause on a phone with fifty of them.
  const recordFiles = files.filter((file) => idFromRecordFile(file.path) !== null);

  await Promise.all(
    recordFiles.map(async (file) => {
      try {
        const text = cache.get(file.sha) ?? (await client.readBlob(file.sha));
        cache.set(file.sha, text);

        const parsed = JSON.parse(text) as AuthoredAnnouncement;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
          failures.push({ path: file.path, error: 'It is not an announcement record.' });
          return;
        }

        records.push(parsed);
      } catch (error) {
        // One unreadable file must not take the whole list down. It is reported
        // and the rest still load — the same rule `loadContent` keeps on disk.
        failures.push({ path: file.path, error: (error as Error).message });
      }
    }),
  );

  records.sort((a, b) => a.id.localeCompare(b.id));

  return {
    commit,
    records,
    failures,
    retiredIds: await loadRetiredIds(client, shas[RETIRED_IDS_FILE], cache),
    media,
    shas,
  };
}

async function loadRetiredIds(
  client: GitHubClient,
  sha: string | undefined,
  cache: BlobCache,
): Promise<string[]> {
  // Absent is legitimate: a repository where nothing has ever been deleted has
  // no ledger. Unreadable is not.
  if (!sha) return [];

  const text = cache.get(sha) ?? (await client.readBlob(sha));
  cache.set(sha, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitHubError(
      200,
      `${RETIRED_IDS_FILE} is unreadable. It is the only record of which ids can never be ` +
        'reused, and reading it as empty would let one come back.',
    );
  }

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new GitHubError(200, `${RETIRED_IDS_FILE} is not a list of ids.`);
  }

  return parsed as string[];
}

/**
 * The registry the validator checks an id against.
 *
 * Both halves of the question in one object: which ids exist, and which are
 * retired. A local guess at either would be checking against half of it.
 */
export function idRegistryOf(snapshot: ContentSnapshot): IdRegistry {
  return {
    // `active` and `retired` are the validator's own field names. Naming them
    // anything else here would mean a translation at every call site, and a
    // translation is a place to get `retired` wrong.
    active: snapshot.records.map((record) => record.id),
    retired: snapshot.retiredIds,
  };
}

/** A record, serialised exactly as the build expects to read it back. */
export function recordWrite(record: AuthoredAnnouncement): FileWrite {
  // `canonicalJson` rather than `JSON.stringify`: key order is stable, so a
  // record edited on a phone and one edited by the CLI produce identical bytes
  // and the git history shows the field that changed rather than a reordering.
  return { path: recordFile(record.id), kind: 'text', content: canonicalJson(record) };
}

export interface SaveRecordInput {
  record: AuthoredAnnouncement;
  /** A newly chosen original, base64. Written in the SAME commit as the record. */
  image?: { base64: string; extension: string } | null;
  message: string;
}

/**
 * Writes one record, and its image when there is one, as a single commit.
 *
 * The old original is removed in the same commit when the extension changes.
 * `content/media/` holds exactly one file per id — the build finds it by
 * matching the filename stem — and two files with the same stem make that match
 * ambiguous, which surfaces later as a build refusing an image that was in fact
 * attached correctly.
 */
export async function saveRecord(
  client: GitHubClient,
  snapshot: ContentSnapshot,
  input: SaveRecordInput,
): Promise<string> {
  const files: FileWrite[] = [recordWrite(input.record)];

  if (input.image) {
    const existing = snapshot.media[input.record.id];
    const path = mediaFile(input.record.id, input.image.extension);

    if (existing && existing.path !== path) {
      files.push({ path: existing.path, kind: 'delete' });
    }

    files.push({ path, kind: 'base64', content: input.image.base64 });
  }

  const result = await client.commit({
    message: input.message,
    files,
    parent: snapshot.commit,
  });

  return result.sha;
}

/**
 * Deletes a record and retires its id, in one commit.
 *
 * The two must land together. An id freed for reuse would inherit the previous
 * announcement's impression state on every device for the sixty-day retention
 * window — so a repository observed between the removal and the ledger entry is
 * a repository in exactly the state the ledger exists to prevent.
 */
export async function deleteRecord(
  client: GitHubClient,
  snapshot: ContentSnapshot,
  id: string,
  message: string,
): Promise<string> {
  const files: FileWrite[] = [{ path: recordFile(id), kind: 'delete' }];

  const media = snapshot.media[id];
  if (media) files.push({ path: media.path, kind: 'delete' });

  // Sorted and de-duplicated, so the ledger is stable and a re-deletion of an
  // already-retired id does not grow it.
  const retired = [...new Set([...snapshot.retiredIds, id])].sort();
  files.push({ path: RETIRED_IDS_FILE, kind: 'text', content: canonicalJson(retired) });

  const result = await client.commit({ message, files, parent: snapshot.commit });
  return result.sha;
}

/** Where the app looks for things, re-exported so screens need one import. */
export { ANNOUNCEMENTS_DIR, MEDIA_DIR, RETIRED_IDS_FILE, recordFile };
