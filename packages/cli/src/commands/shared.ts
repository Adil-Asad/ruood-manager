/**
 * What every command needs: locate a record, report issues, print a table.
 */

import {
  defaultKeyPath,
  isChannel,
  loadContent,
  loadPublicKeyRecord,
  loadSigningKey,
  repoPaths,
  saveRecord,
  type Channel,
  type ContentSnapshot,
  type RepoPaths,
  type SigningKey,
} from '@ruood/announcement-core';
import {
  deriveLifecycleStatus,
  formatIssues,
  type AuthoredAnnouncement,
  type ValidationIssue,
} from '@ruood/announcement-schema';

import { flagBool, flagString } from '../args';
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

/**
 * The channel a command is acting on. `production` unless asked otherwise.
 *
 * Defaulting to production rather than requiring the flag every time is a
 * deliberate asymmetry: the common operation should be the short one, and
 * publishing to staging by accident is harmless while the reverse is not.
 */
export function channelOf(ctx: CommandContext): Channel | null {
  const requested = flagString(ctx.args, 'channel');
  if (requested === null) return 'production';

  if (!isChannel(requested)) {
    ctx.err(`--channel must be production or staging, not "${requested}".`);
    return null;
  }

  return requested;
}

/**
 * The signing key, when `--sign` was asked for.
 *
 * Returns `undefined` for "not signing", and `null` for "asked to sign and
 * could not" — which the caller must treat as a refusal. Publishing unsigned
 * after being asked to sign would be the worst possible reading of a missing
 * key file: it succeeds, looks fine, and ships something no install trusts.
 */
export async function signingKeyFor(
  ctx: CommandContext,
): Promise<SigningKey | undefined | null> {
  const explicitPath = flagString(ctx.args, 'key');
  const asked = flagBool(ctx.args, 'sign') || explicitPath !== null;

  if (!asked) {
    // Not asked, but say so when the repository plainly expects it — an
    // unsigned publish to a signed repository is a mistake, not a choice.
    const expected = await loadPublicKeyRecord(ctx.repoRoot);
    if (expected) {
      ctx.err(
        `Note: this repository expects manifests signed by key ${expected.keyId}, and this ` +
          'build is unsigned. Add --sign.',
      );
    }
    return undefined;
  }

  try {
    return await loadSigningKey(explicitPath ?? defaultKeyPath());
  } catch (error) {
    ctx.err((error as Error).message);
    return null;
  }
}
