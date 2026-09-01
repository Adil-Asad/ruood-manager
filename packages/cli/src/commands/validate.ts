import { buildManifest } from '@ruood/announcement-core';

import type { CommandContext, CommandResult } from '../main';
import { channelOf, paths, reportIssues } from './shared';

/**
 * Validates without writing anything, including the revision counter — which
 * is what `keepRevision` is for. Running `validate` twice must not advance the
 * number that appears in a published manifest.
 */
export async function runValidate(ctx: CommandContext): Promise<CommandResult> {
  const channel = channelOf(ctx);
  if (!channel) return 2;

  // Unsigned on purpose: validate writes nothing and answers "would this
  // publish", which does not depend on who signs it.
  const result = await buildManifest(paths(ctx), {
    now: ctx.now,
    keepRevision: true,
    channel,
  });

  reportIssues(ctx, result.errors, result.warnings, result.problems);

  ctx.out('');
  ctx.out(
    `${result.manifest.announcements.length} record(s) would be published, ` +
      `${result.excluded.length} excluded, ${result.bytes} bytes.`,
  );

  for (const excluded of result.excluded) {
    ctx.out(`  - ${excluded.id} (${excluded.reason})`);
  }

  if (!result.ok) {
    ctx.out('');
    ctx.err(
      `NOT publishable: ${result.errors.length} error(s), ${result.problems.length} problem(s).`,
    );
    return 1;
  }

  ctx.out('');
  ctx.out(
    result.warnings.length > 0
      ? `Publishable, with ${result.warnings.length} warning(s) to review.`
      : 'Ready to publish.',
  );

  return 0;
}
