import {
  buildManifest,
  DEFAULT_MAX_RETAINED,
  loadState,
  parseRetentionLimit,
  RETENTION_MAX,
  RETENTION_MIN,
  saveState,
} from '@ruood/announcement-core';

import { flagBool, flagString } from '../args';
import type { CommandContext, CommandResult } from '../main';
import { paths } from './shared';

/**
 * Shows or sets how many announcements stay published.
 *
 * The same setting the Manager app writes, in the same place — `maxRetained` in
 * `content/state.json`. There is one implementation of what it means (the
 * projection in `core`) and one place it is stored; this and the phone are two
 * front ends onto it, which is the rule the whole project is built on.
 *
 * Showing it runs the build with `keepRevision`, because "what does this
 * setting do to MY announcements" is a better answer than the number on its
 * own, and the build is the only thing that can say.
 */
export async function runRetention(ctx: CommandContext): Promise<CommandResult> {
  const repo = paths(ctx);

  // `has` rather than a non-null value, so `--max` with nothing after it is a
  // misuse to report rather than a request to show the current setting.
  const setting = flagBool(ctx.args, 'max');

  if (setting) {
    const limit = parseRetentionLimit(flagString(ctx.args, 'max') ?? '');

    if (limit === null) {
      // Refused rather than clamped. A tool that silently turned 500 into 50
      // would report a setting nobody chose.
      ctx.err(
        `--max must be a whole number between ${RETENTION_MIN} and ${RETENTION_MAX}. ` +
          `Zero is not a limit — to stop showing announcements, publish with --paused.`,
      );
      return 2;
    }

    await saveState(repo, { maxRetained: limit });
    ctx.out(`Maximum retained announcements: ${limit}.`);
    ctx.out('');
    ctx.out('Nothing is published until the next build. Run: announce publish');
  }

  const stored = await loadState(repo);
  const limit = stored.maxRetained;

  if (!setting) {
    ctx.out(
      `Maximum retained announcements: ${limit}` +
        `${limit === DEFAULT_MAX_RETAINED ? ' (the default)' : ''}. ` +
        `Allowed: ${RETENTION_MIN}-${RETENTION_MAX}.`,
    );
  }

  // What that limit does to this repository, right now. Unsigned and
  // `keepRevision`, because this command writes no manifest and must not
  // advance the number that appears in one.
  const result = await buildManifest(repo, { now: ctx.now, keepRevision: true });
  const outside = result.excluded.filter((entry) => entry.reason === 'retention');

  ctx.out('');
  ctx.out(`${result.manifest.announcements.length} announcement(s) would be published.`);

  if (outside.length === 0) {
    ctx.out('Nothing falls outside the limit.');
    return 0;
  }

  ctx.out(`${outside.length} fall outside it and would NOT be published:`);
  for (const entry of outside) ctx.out(`  - ${entry.id}`);

  ctx.out('');
  // The distinction the whole feature turns on, said where somebody will read
  // it: this is not a deletion, and it is not an archive.
  ctx.out(
    'They are still here, unchanged, and raising the limit publishes them again. ' +
      'Nothing in content/ is removed.',
  );

  return 0;
}
