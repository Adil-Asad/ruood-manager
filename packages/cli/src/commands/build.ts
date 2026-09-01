import { buildManifest, saveState, writeBuild } from '@ruood/announcement-core';

import type { CommandContext, CommandResult } from '../main';
import { paths, reportIssues } from './shared';

/**
 * Writes `dist/` without committing.
 *
 * Useful for inspecting the output, and for proving the claim that `dist/` is
 * disposable: delete it, run this, and it comes back byte-identical from
 * `content/` alone.
 */
export async function runBuild(ctx: CommandContext): Promise<CommandResult> {
  const repo = paths(ctx);
  const result = await buildManifest(repo, { now: ctx.now });

  reportIssues(ctx, result.errors, result.warnings, result.problems);

  if (!result.ok) {
    ctx.err('');
    ctx.err('Build refused. Nothing was written.');
    return 1;
  }

  const written = await writeBuild(repo, result);
  await saveState(repo, { revision: result.manifest.revision });

  ctx.out('');
  ctx.out(`Wrote dist/ at revision ${result.manifest.revision} (${result.bytes} bytes).`);
  ctx.out(`  ${result.manifest.announcements.length} record(s), ${result.imageFiles.size} image(s).`);
  for (const file of written) ctx.out(`  ${file.slice(repo.root.length + 1)}`);

  ctx.out('');
  ctx.out('Not committed. Run: announce publish');

  return 0;
}
