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
}

/** The counter that becomes `manifest.revision`. */
interface RepoState {
  revision: number;
}

export async function loadContent(paths: RepoPaths): Promise<ContentSnapshot> {
  const [records, failures] = await loadRecords(paths);

  return {
    records,
    failures,
    retiredIds: await loadRetiredIds(paths),
    revision: (await loadState(paths)).revision,
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
  if (!existsSync(paths.state)) return { revision: 0 };
  try {
    const parsed = JSON.parse(await readFile(paths.state, 'utf8')) as Partial<RepoState>;
    const revision = typeof parsed.revision === 'number' ? parsed.revision : 0;
    return { revision: Number.isInteger(revision) && revision >= 0 ? revision : 0 };
  } catch {
    return { revision: 0 };
  }
}

export async function saveState(paths: RepoPaths, state: RepoState): Promise<void> {
  await mkdir(paths.content, { recursive: true });
  await writeFile(paths.state, canonicalJson(state), 'utf8');
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
