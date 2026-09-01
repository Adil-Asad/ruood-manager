import { buildManifest, saveState, writeBuild } from '@ruood/announcement-core';

import type { CommandContext, CommandResult } from '../main';
import { channelOf, paths, reportIssues, signingKeyFor } from './shared';

/**
 * Writes `dist/` without committing.
 *
 * Useful for inspecting the output, and for proving the claim that `dist/` is
 * disposable: delete it, run this, and it comes back byte-identical from
 * `content/` alone.
 */
export async function runBuild(ctx: CommandContext): Promise<CommandResult> {
  const repo = paths(ctx);

  const channel = channelOf(ctx);
  if (!channel) return 2;

  const signingKey = await signingKeyFor(ctx);
  if (signingKey === null) return 1;

  const result = await buildManifest(repo, {
    now: ctx.now,
    channel,
    ...(signingKey ? { signingKey } : {}),
  });

  reportIssues(ctx, result.errors, result.warnings, result.problems);

  if (!result.ok) {
    ctx.err('');
    ctx.err('Build refused. Nothing was written.');
    return 1;
  }

  const written = await writeBuild(repo, result);
  await saveState(repo, { revision: result.manifest.revision });

  ctx.out('');
  ctx.out(
    `Wrote the ${result.channel} manifest at revision ${result.manifest.revision} ` +
      `(${result.bytes} bytes)${result.signedBy ? `, signed by ${result.signedBy}` : ', UNSIGNED'}.`,
  );
  ctx.out(`  ${result.manifest.announcements.length} record(s), ${result.imageFiles.size} image(s).`);
  for (const file of written) ctx.out(`  ${file.slice(repo.root.length + 1)}`);

  ctx.out('');
  ctx.out('Not committed. Run: announce publish');

  return 0;
}
