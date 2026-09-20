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
  STATE_FILE,
  idFromRecordFile,
  mediaFile,
  mediaOf,
  normaliseRetentionLimit,
  recordFile,
  isRetentionLimit,
  RETENTION_MAX,
  RETENTION_MIN,
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
  /** The repository's own settings. See `RepositorySettings`. */
  settings: RepositorySettings;
  /** Blob shas by path, so an unchanged file is never fetched twice. */
  shas: Record<string, string>;
}

/**
 * `content/state.json`, as the app needs it.
 *
 * Two values for two jobs. `maxRetained` is the setting the Settings screen
 * shows and writes. `stored` is the file exactly as it was read, and it is
 * there so that writing the setting cannot destroy anything else in it — the
 * revision counter above all, which the build increments and which going
 * backwards would make every published manifest look older than it is.
 *
 * `stored` is `null` when the file exists and could not be read. The app stays
 * usable — a settings file is not a reason to stop authoring announcements —
 * and `saveSettings` refuses, because merging onto a guess is exactly how the
 * counter would be lost.
 */
export interface RepositorySettings {
  maxRetained: number;
  stored: Record<string, unknown> | null;
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
    settings: await loadSettings(client, shas[STATE_FILE], cache, failures),
    shas,
  };
}

/**
 * The settings file, which is allowed to be absent and allowed to be broken.
 *
 * Absent is an ordinary repository that has never changed a setting. Broken is
 * reported as a failure like an unreadable record — the list still loads, and
 * `saveSettings` is what refuses.
 *
 * Note that this deliberately does NOT throw the way the retired-id ledger
 * does. That ledger failing open lets an id be reused on every device that ever
 * saw it; this one failing open costs a number that can be set again.
 */
async function loadSettings(
  client: GitHubClient,
  sha: string | undefined,
  cache: BlobCache,
  failures: LoadFailure[],
): Promise<RepositorySettings> {
  if (!sha) return { maxRetained: normaliseRetentionLimit(undefined), stored: {} };

  try {
    const text = cache.get(sha) ?? (await client.readBlob(sha));
    cache.set(sha, text);

    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('It is not a settings object.');
    }

    const stored = parsed as Record<string, unknown>;
    return { maxRetained: normaliseRetentionLimit(stored.maxRetained), stored };
  } catch (error) {
    failures.push({ path: STATE_FILE, error: (error as Error).message });
    return { maxRetained: normaliseRetentionLimit(undefined), stored: null };
  }
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
  /**
   * Removes the original this id holds, in the same commit.
   *
   * Clearing `record.image` is not enough and used to be all that happened.
   * The publishing build attaches an original that no record references — that
   * is how a picture chosen on a phone gets encoded at all, since the phone
   * cannot compute the encoded hash — so an original left behind in
   * `content/media/` is an image that comes straight back on the next publish.
   * Removing the picture has to remove the bytes.
   */
  removeImage?: boolean;
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
  const existing = snapshot.media[input.record.id];

  if (input.image) {
    const path = mediaFile(input.record.id, input.image.extension);

    if (existing && existing.path !== path) {
      files.push({ path: existing.path, kind: 'delete' });
    }

    files.push({ path, kind: 'base64', content: input.image.base64 });
  } else if (input.removeImage && existing) {
    // The record and the bytes go together, in one commit, for the same reason
    // they arrive together: a repository observed between the two is one the
    // build reads differently from either state.
    files.push({ path: existing.path, kind: 'delete' });
  }

  const result = await client.commit({
    message: input.message,
    files,
    parent: snapshot.commit,
  });

  return result.sha;
}

/**
 * Deletes one or more records and retires their ids, in ONE commit.
 *
 * ## Why the batch is the primitive, and the single delete is the special case
 *
 * A record's removal and its ledger entry must land together. An id freed for
 * reuse would inherit the previous announcement's impression state on every
 * device for the sixty-day retention window — so a repository observed between
 * the removal and the ledger entry is a repository in exactly the state the
 * ledger exists to prevent.
 *
 * Deleting several is the same rule, and looping the single delete would break
 * it in two separate ways rather than one:
 *
 *   - **Every intermediate commit is a state somebody can observe**, and the
 *     publishing workflow is triggered by each of them. Removing five
 *     announcements one at a time is five builds, four of which publish a
 *     manifest the administrator never asked anyone to see.
 *   - **The second write would be REFUSED.** A commit is built on a parent, and
 *     `snapshot.commit` is the one the caller read. After the first deletion
 *     that parent is stale, so the second is a non-fast-forward and comes back
 *     as `ConcurrentUpdate` — the mechanism that protects two administrators
 *     from overwriting each other, firing on a single administrator deleting
 *     two things. A caller could re-read between each, but that is N round
 *     trips to do what the Git Data API does in one tree.
 *
 * So the ids are collected, their originals with them, the ledger is written
 * once, and it is a single commit with a single message — which is also what
 * makes `git revert` undo the whole operation the way the administrator
 * performed it.
 *
 * Empty, or entirely ids the snapshot does not hold, is not an error and is not
 * a commit: there is nothing to record, and an empty commit in the history
 * reads as a deletion that did something.
 */
export async function deleteRecords(
  client: GitHubClient,
  snapshot: ContentSnapshot,
  ids: readonly string[],
  message: string,
): Promise<string | null> {
  // De-duplicated before anything is counted. A list naming the same id twice
  // would otherwise produce two `delete` entries for one path, which the tree
  // builder has no reason to tolerate.
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;

  const files: FileWrite[] = [];

  for (const id of unique) {
    files.push({ path: recordFile(id), kind: 'delete' });

    // The original goes in the same commit as the record that referenced it,
    // exactly as it arrived in the same commit. An original left behind is a
    // picture the publishing build would attach to nothing.
    const media = snapshot.media[id];
    if (media) files.push({ path: media.path, kind: 'delete' });
  }

  // Sorted and de-duplicated, so the ledger is stable and a re-deletion of an
  // already-retired id does not grow it.
  const retired = [...new Set([...snapshot.retiredIds, ...unique])].sort();
  files.push({ path: RETIRED_IDS_FILE, kind: 'text', content: canonicalJson(retired) });

  const result = await client.commit({ message, files, parent: snapshot.commit });
  return result.sha;
}

/**
 * Deletes a record and retires its id, in one commit.
 *
 * One call of `deleteRecords`, rather than a second implementation of it. The
 * rule about what shares a commit with a deletion is written once, so deleting
 * one announcement and deleting ten cannot come to disagree about it.
 */
export async function deleteRecord(
  client: GitHubClient,
  snapshot: ContentSnapshot,
  id: string,
  message: string,
): Promise<string> {
  const sha = await deleteRecords(client, snapshot, [id], message);

  // Never null: one id is never an empty list. Asserted rather than assumed,
  // because the caller's signature promises a sha and returning `null` as one
  // would surface later as a successful delete that reported nothing.
  if (sha === null) throw new GitHubError(500, 'The deletion produced no commit.');
  return sha;
}

/**
 * Writes the repository's settings, as one commit.
 *
 * ## It merges rather than replaces
 *
 * `content/state.json` also holds the revision counter, which the publishing
 * build increments and which nothing else may touch. Writing the settings
 * object whole would reset it to whatever this app happened to know about, and
 * a manifest whose revision went backwards is one that reads as older than the
 * file it replaced. So the write is the file as it was read, plus the change.
 *
 * ## It refuses when the file could not be read
 *
 * `stored: null` means the file is there and unreadable. Overwriting it would
 * be inventing a revision counter. The administrator is told; nothing is lost.
 */
export async function saveSettings(
  client: GitHubClient,
  snapshot: ContentSnapshot,
  changes: { maxRetained: number },
  message: string,
): Promise<string> {
  const stored = snapshot.settings.stored;

  if (stored === null) {
    throw new GitHubError(
      200,
      `${STATE_FILE} could not be read, so writing it would discard what it holds.`,
    );
  }

  if (!isRetentionLimit(changes.maxRetained)) {
    // The form checks first; this is the floor under a bad call site, and it
    // refuses rather than clamping so nothing is written that nobody chose.
    throw new GitHubError(
      200,
      `A retention limit must be a whole number between ${RETENTION_MIN} and ${RETENTION_MAX}.`,
    );
  }

  const result = await client.commit({
    message,
    files: [
      {
        path: STATE_FILE,
        kind: 'text',
        content: canonicalJson({ ...stored, maxRetained: changes.maxRetained }),
      },
    ],
    parent: snapshot.commit,
  });

  return result.sha;
}

/** Where the app looks for things, re-exported so screens need one import. */
export { ANNOUNCEMENTS_DIR, MEDIA_DIR, RETIRED_IDS_FILE, STATE_FILE, recordFile };
