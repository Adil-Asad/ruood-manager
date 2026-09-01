/**
 * What every command needs: locate a record, report issues, print a table.
 */

import {
  loadContent,
  repoPaths,
  saveRecord,
  type ContentSnapshot,
  type RepoPaths,
} from '@ruood/announcement-core';
import {
  deriveLifecycleStatus,
  formatIssues,
  type AuthoredAnnouncement,
  type ValidationIssue,
} from '@ruood/announcement-schema';

import type { CommandContext } from '../main';

export function paths(ctx: CommandContext): RepoPaths {
  return repoPaths(ctx.repoRoot);
}

export async function snapshot(ctx: CommandContext): Promise<ContentSnapshot> {
  return loadContent(paths(ctx));
}

export interface FoundRecord {
  record: AuthoredAnnouncement;
  snapshot: ContentSnapshot;
}

/**
 * Loads one record by id.
 *
 * Suggests near misses on a miss, because an id is 3-64 characters of
 * hyphenated lowercase and a typo is the likeliest reason a command fails.
 */
export async function requireRecord(
  ctx: CommandContext,
  id: string,
): Promise<FoundRecord | null> {
  const content = await snapshot(ctx);
  const found = content.records.find((entry) => entry.id === id);

  if (found) return { record: found.record, snapshot: content };

  ctx.err(`No announcement with id "${id}".`);

  const near = content.records
    .map((entry) => entry.id)
    .filter((candidate) => candidate.includes(id) || id.includes(candidate));

  if (near.length > 0) ctx.err(`Did you mean: ${near.join(', ')}?`);
  else if (content.records.length > 0) {
    ctx.err(`Known ids: ${content.records.map((entry) => entry.id).join(', ')}`);
  }

  return null;
}

export async function writeRecord(
  ctx: CommandContext,
  record: AuthoredAnnouncement,
): Promise<void> {
  await saveRecord(paths(ctx), record);
}

export function reportIssues(
  ctx: CommandContext,
  errors: readonly ValidationIssue[],
  warnings: readonly ValidationIssue[],
  problems: readonly string[] = [],
): void {
  if (errors.length > 0) {
    ctx.err('');
    ctx.err(formatIssues(errors));
  }
  if (warnings.length > 0) {
    ctx.out('');
    ctx.out(formatIssues(warnings));
  }
  for (const problem of problems) ctx.err(`ERROR [problem]: ${problem}`);
}

export function lifecycleOf(record: AuthoredAnnouncement, now: number): string {
  return deriveLifecycleStatus(
    { status: record.status, startAt: record.startAt, endAt: record.endAt ?? null },
    now,
  );
}

/** Left-aligned fixed-width columns, sized to the widest cell. */
export function table(rows: readonly string[][]): string {
  if (rows.length === 0) return '';

  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  return rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
