/**
 * Reading and writing `content/`.
 *
 * The impure half of the source of truth. Every write goes through
 * `canonicalJson`, so a one-field edit produces a one-line diff and `git log`
 * stays readable — which is the entire reason drafts live in git rather than in
 * a Manager-local database.
 *
 * Nothing here validates. Callers validate, because the Manager wants warnings
 * and the CLI wants an exit code, and a store that refused to load a broken
 * record would leave you unable to open the thing you need to fix.
 */

import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  canonicalJson,
  type AuthoredAnnouncement,
  type IdRegistry,
} from '@ruood/announcement-schema';
import { normaliseRetentionLimit } from '@ruood/announcement-authoring';

import { recordPath, type RepoPaths } from '../paths';

export interface LoadedRecord {
  id: string;
  file: string;
  record: AuthoredAnnouncement;
}

export interface LoadFailure {
  file: string;
  error: string;
}

export interface ContentSnapshot {
  records: LoadedRecord[];
  /** Files that would not parse. Surfaced, never swallowed. */
  failures: LoadFailure[];
  retiredIds: string[];
  revision: number;
  /** How many records this repository publishes. See `retention.ts`. */
  maxRetained: number;
}

/** What `content/state.json` holds: the revision counter, and the settings. */
export interface RepoState {
  revision: number;
  /** The retention limit, normalised. Absent from the file means the default. */
  maxRetained: number;
}

export async function loadContent(paths: RepoPaths): Promise<ContentSnapshot> {
  const [records, failures] = await loadRecords(paths);
  const state = await loadState(paths);

  return {
    records,
    failures,
    retiredIds: await loadRetiredIds(paths),
    revision: state.revision,
    maxRetained: state.maxRetained,
  };
}

async function loadRecords(paths: RepoPaths): Promise<[LoadedRecord[], LoadFailure[]]> {
  if (!existsSync(paths.announcements)) return [[], []];

  const entries = (await readdir(paths.announcements))
    .filter((name) => name.endsWith('.json'))
    .sort();

  const records: LoadedRecord[] = [];
  const failures: LoadFailure[] = [];

  for (const entry of entries) {
    const file = join(paths.announcements, entry);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as AuthoredAnnouncement;
      const id = basename(entry, '.json');

      // The filename IS the id. A mismatch means a file was renamed by hand,
      // which would make the record unreachable from the Manager.
      if (parsed.id !== id) {
        failures.push({
          file,
          error: `Filename says "${id}" but the record's id is "${String(parsed.id)}".`,
        });
        continue;
      }

      records.push({ id, file, record: parsed });
    } catch (error) {
      failures.push({ file, error: (error as Error).message });
    }
  }

  return [records, failures];
}

export async function saveRecord(
  paths: RepoPaths,
  record: AuthoredAnnouncement,
): Promise<string> {
  await mkdir(paths.announcements, { recursive: true });
  const file = recordPath(paths, record.id);
  await writeFile(file, canonicalJson(record), 'utf8');
  return file;
}

/**
 * Deletes a record and retires its id in one step.
 *
 * The two are inseparable: an id whose file is gone but which is not on the
 * ledger is an id that can be handed out again, and a reused id inherits the
 * previous announcement's impression counters on every device that ever saw it.
 */
export async function deleteRecord(paths: RepoPaths, id: string): Promise<void> {
  const file = recordPath(paths, id);
  if (existsSync(file)) await rm(file);
  await retireId(paths, id);
}

export async function loadRetiredIds(paths: RepoPaths): Promise<string[]> {
  if (!existsSync(paths.retiredIds)) return [];
  try {
    const parsed = JSON.parse(await readFile(paths.retiredIds, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // A corrupt ledger must never read as "no ids are retired" — that would
    // silently permit exactly the reuse it exists to prevent.
    throw new Error(
      `${paths.retiredIds} is unreadable. It is the only record of which ids can never be ` +
        'reused, so publishing is refused until it is repaired.',
    );
  }
}

export async function retireId(paths: RepoPaths, id: string): Promise<void> {
  const existing = await loadRetiredIds(paths);
  if (existing.includes(id)) return;

  await mkdir(paths.content, { recursive: true });
  await writeFile(paths.retiredIds, canonicalJson([...existing, id].sort()), 'utf8');
}

export async function loadState(paths: RepoPaths): Promise<RepoState> {
  const raw = await readRawState(paths);

  const revision = typeof raw.revision === 'number' ? raw.revision : 0;

  return {
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    maxRetained: normaliseRetentionLimit(raw.maxRetained),
  };
}

/**
 * Writes the fields it is given and PRESERVES the rest.
 *
 * It used to take a whole `RepoState` and write exactly that, which was fine
 * while the file held one number. It does not hold one number any more: every
 * build ends with `saveState(paths, { revision })`, and writing that object
 * whole would erase the retention limit on the first publish after it was set
 * — silently, and in the direction that publishes more rather than less.
 *
 * Merging onto the parsed file rather than onto `loadState` is deliberate too:
 * a field a future version of this tool adds survives being written by an older
 * one, and a value `loadState` normalised away is not written back as though
 * somebody had chosen it.
 */
export async function saveState(paths: RepoPaths, changes: Partial<RepoState>): Promise<void> {
  const raw = await readRawState(paths);

  await mkdir(paths.content, { recursive: true });
  await writeFile(paths.state, canonicalJson({ ...raw, ...changes }), 'utf8');
}

/**
 * The state file as it is on disk, or `{}`.
 *
 * Unreadable reads as empty on purpose, and it is a different judgement from
 * `retired-ids.json` above: that ledger failing open would let an id be reused
 * on every device that ever saw it, while this one failing open costs a
 * revision number and a setting that can be set again. Refusing to build over
 * it would take publishing down for something that has no bearing on whether
 * any announcement is correct.
 */
async function readRawState(paths: RepoPaths): Promise<Record<string, unknown>> {
  if (!existsSync(paths.state)) return {};

  try {
    const parsed = JSON.parse(await readFile(paths.state, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * What ids are unavailable.
 *
 * `active` is every id in `content/` — drafts and archived records included,
 * because an archived announcement can be reactivated.
 */
export function idRegistryFrom(snapshot: ContentSnapshot): IdRegistry {
  return {
    active: snapshot.records.map((entry) => entry.id),
    retired: snapshot.retiredIds,
  };
}
